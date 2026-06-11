from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from agent_orchestrator.config import Settings
from agent_orchestrator.copilot_command import command_for_process

from .base import AgentAdapter, AgentResult

if TYPE_CHECKING:
    from agent_orchestrator.execution import ExecutionEngine

# High-frequency streaming events that would flood run logs.
SKIP_EVENT_TYPES = {
    "assistant.message_start",
    "assistant.message_delta",
    "assistant.reasoning_delta",
    "assistant.streaming_delta",
    "session.usage_info",
}

EVENT_MESSAGE_FIELDS = {
    "assistant.message": "content",
    "assistant.reasoning": "content",
    "session.error": "message",
    "session.warning": "message",
    "session.info": "message",
    "session.task_complete": "summary",
}

EVENT_LOG_LEVELS = {
    "session.error": "error",
    "session.warning": "warning",
}


class CopilotCliAdapter(AgentAdapter):
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
        prompt = self._prompt(resume, feedback_text)
        command = self._command_for_process(process, prompt)
        if resume and run.get("session_id"):
            # Copilot's --resume takes an optional value, so the = form is required.
            command.append(f"--resume={run['session_id']}")
        env = os.environ.copy()
        env.update(
            {
                "ORCH_API_BASE": engine.settings.api_base,
                "ORCH_RUN_ID": run["id"],
                "ORCH_TOKEN": engine.settings.api_token,
                "ORCH_QA_TIMEOUT_SECONDS": str(engine.settings.qa_timeout_seconds),
            }
        )
        self._add_skills_env(env, Path(run["workdir_path"]))
        process_handle = await asyncio.create_subprocess_exec(
            *command,
            cwd=run["workdir_path"],
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=self._stream_limit_bytes(),
        )
        engine.register_process(run["id"], process_handle)
        assert process_handle.stdout is not None
        session_id = run.get("session_id")
        try:
            async for raw_line in process_handle.stdout:
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                if not line:
                    continue
                parsed = self._parse_event(line)
                if parsed.get("session_id") and parsed["session_id"] != session_id:
                    session_id = parsed["session_id"]
                    engine.store.update_run(run["id"], session_id=session_id)
                usage = parsed.get("usage")
                if usage:
                    await engine.record_usage(run["id"], process, **usage)
                if parsed.get("skip"):
                    continue
                await engine._log(
                    run["id"], parsed.get("level") or "info", parsed.get("message") or line, parsed.get("raw")
                )
            returncode = await process_handle.wait()
            if returncode != 0:
                return AgentResult(ok=False, session_id=session_id, error=f"Copilot command exited with {returncode}")
            return AgentResult(ok=True, session_id=session_id)
        except BaseException:
            await self._terminate_process(process_handle)
            raise
        finally:
            engine.unregister_process(run["id"], process_handle)

    def _command_for_process(self, process: dict[str, Any], prompt: str) -> list[str]:
        return command_for_process(self.command, process, self.settings, prompt)

    def _stream_limit_bytes(self) -> int:
        if self.settings is None:
            return 16 * 1024 * 1024
        return self.settings.copilot_stream_limit_bytes

    async def _terminate_process(self, process_handle: asyncio.subprocess.Process) -> None:
        if process_handle.returncode is not None:
            return
        process_handle.terminate()
        try:
            await asyncio.wait_for(process_handle.wait(), timeout=5)
        except TimeoutError:
            process_handle.kill()
            await process_handle.wait()

    def _add_skills_env(self, env: dict[str, str], workdir: Path) -> None:
        skills_dir = workdir / ".claude" / "skills"
        if not skills_dir.exists():
            return
        current = env.get("COPILOT_SKILLS_DIRS")
        env["COPILOT_SKILLS_DIRS"] = f"{skills_dir},{current}" if current else str(skills_dir)

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
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return {"message": line, "raw": {"line": line}}
        if not isinstance(data, dict):
            return {"message": line, "raw": {"line": line}}
        event_type = data.get("type")
        # Copilot session events carry their payload under "data" (see schemas/session-events.schema.json).
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        session_id = (
            payload.get("sessionId") or data.get("session_id") or data.get("sessionId") or data.get("sessionID")
        )
        return {
            "event_type": event_type,
            "message": self._message_for_event(event_type, payload, data),
            "level": EVENT_LOG_LEVELS.get(event_type or ""),
            "session_id": session_id,
            "usage": self._usage_for_event(event_type, payload),
            "skip": event_type in SKIP_EVENT_TYPES,
            "raw": data,
        }

    def _message_for_event(self, event_type: str | None, payload: dict[str, Any], data: dict[str, Any]) -> str:
        field = EVENT_MESSAGE_FIELDS.get(event_type or "")
        if field and payload.get(field):
            return str(payload[field])
        message = data.get("message") or data.get("text") or data.get("content") or data.get("type")
        if isinstance(message, dict):
            message = message.get("text") or message.get("message") or message.get("type") or message
        if isinstance(message, list):
            parts = []
            for item in message:
                if isinstance(item, dict):
                    parts.append(str(item.get("text") or item.get("content") or item.get("type") or ""))
                else:
                    parts.append(str(item))
            message = " ".join(part for part in parts if part)
        return str(message or data)

    def _usage_for_event(self, event_type: str | None, payload: dict[str, Any]) -> dict[str, int] | None:
        if event_type != "assistant.usage":
            return None
        usage = {
            "input_tokens": int(payload.get("inputTokens") or 0),
            "output_tokens": int(payload.get("outputTokens") or 0),
            "cache_read": int(payload.get("cacheReadTokens") or 0),
            "cache_write": int(payload.get("cacheWriteTokens") or 0),
        }
        if not any(usage.values()):
            return None
        return usage
