from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Any

from agent_orchestrator.claude_command import apply_permissions, command_for_process, permission_setting, split_tools
from agent_orchestrator.claude_stream import final_cost_for_event, normalize_usage, parse_event, usage_for_event
from agent_orchestrator.config import Settings

from .base import AgentAdapter, AgentResult

if TYPE_CHECKING:
    from agent_orchestrator.execution import ExecutionEngine


class ClaudeCodeAdapter(AgentAdapter):
    def __init__(self, command: list[str], settings: Settings | None = None):
        self.command = command
        self.settings = settings

    async def run(
        self,
        engine: ExecutionEngine,
        run: dict[str, Any],
        process: dict[str, Any],
        *,
        resume: bool,
        feedback_text: str,
    ) -> AgentResult:
        command = self._command_for_process(process)
        if resume and run.get("session_id"):
            command.extend(["--resume", run["session_id"]])
        env = os.environ.copy()
        env.update(
            {
                "ORCH_API_BASE": engine.settings.api_base,
                "ORCH_RUN_ID": run["id"],
                "ORCH_TOKEN": engine.settings.api_token,
                "ORCH_QA_TIMEOUT_SECONDS": str(engine.settings.qa_timeout_seconds),
            }
        )
        prompt = self._prompt(resume, feedback_text)
        process_handle = await asyncio.create_subprocess_exec(
            *command,
            cwd=run["workdir_path"],
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        engine.register_process(run["id"], process_handle)
        assert process_handle.stdin is not None
        assert process_handle.stdout is not None
        try:
            process_handle.stdin.write(prompt.encode("utf-8"))
            await process_handle.stdin.drain()
            process_handle.stdin.close()

            session_id = run.get("session_id")
            persisted_session_id = session_id
            seen_message_ids: set[str] = set()
            async for raw_line in process_handle.stdout:
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                if not line:
                    continue
                parsed = self._parse_event(line)
                if parsed.get("session_id"):
                    session_id = parsed["session_id"]
                    if session_id != persisted_session_id:
                        engine.store.update_run(run["id"], session_id=session_id)
                        persisted_session_id = session_id
                usage = self._usage_for_event(parsed, seen_message_ids)
                if usage:
                    await engine.record_usage(
                        run["id"],
                        process,
                        input_tokens=usage["input_tokens"],
                        output_tokens=usage["output_tokens"],
                        cache_read=usage["cache_read"],
                        cache_write=usage["cache_write"],
                    )
                final_cost = self._final_cost_for_event(parsed)
                if final_cost is not None:
                    await engine.record_final_cost(run["id"], process, final_cost)
                await engine._log(run["id"], "info", parsed.get("message") or line, parsed.get("raw"))
            returncode = await process_handle.wait()
            if returncode != 0:
                return AgentResult(ok=False, session_id=session_id, error=f"Claude command exited with {returncode}")
            return AgentResult(ok=True, session_id=session_id)
        finally:
            engine.unregister_process(run["id"], process_handle)

    def _command_for_process(self, process: dict[str, Any]) -> list[str]:
        return command_for_process(self.command, process, self.settings)

    def _permission_setting(self, process: dict[str, Any], key: str, default: str) -> str:
        return permission_setting(process, key, default)

    def _apply_permissions(self, command: list[str], process: dict[str, Any]) -> None:
        apply_permissions(command, process, self.settings)

    @staticmethod
    def _split_tools(value: str) -> list[str]:
        return split_tools(value)

    def _normalize_usage(self, usage: dict[str, Any]) -> dict[str, int]:
        return normalize_usage(usage)

    def _usage_for_event(self, parsed: dict[str, Any], seen_message_ids: set[str]) -> dict[str, int] | None:
        return usage_for_event(parsed, seen_message_ids)

    def _final_cost_for_event(self, parsed: dict[str, Any]) -> float | None:
        return final_cost_for_event(parsed)

    def _prompt(self, resume: bool, feedback_text: str) -> str:
        base = (
            "Read AGENTS.md and Goal.md in the current directory. "
            "Complete output/output.yaml and any referenced output files. "
            "Use utils/question.py for questions and utils/submit.py when ready for human review.\n"
        )
        if resume and feedback_text:
            return f"{base}\nHuman review feedback:\n{feedback_text}\n"
        return base

    def _parse_event(self, line: str) -> dict[str, Any]:
        return parse_event(line)
