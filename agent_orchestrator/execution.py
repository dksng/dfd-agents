from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config import Settings
from .db import AGENT_EFFORT_VALUES, PERMISSION_MODE_VALUES, Store
from .events import EventHub
from .exceptions import AppValidationError, ConflictError
from .pricing import Pricing
from .workspace import WorkspaceBuilder, safe_name

RUN_STATUSES_ALLOWING_SUBMIT = {"running"}
RUN_STATUSES_ALLOWING_REVIEW = {"in_review"}
RUN_STATUSES_ALLOWING_PUBLIC_RESUME = {"failed"}


@dataclass
class AgentResult:
    ok: bool
    submitted: bool = False
    session_id: str | None = None
    error: str | None = None


class ExecutionEngine:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        hub: EventHub,
        pricing: Pricing,
        workspace_builder: WorkspaceBuilder,
    ):
        self.settings = settings
        self.store = store
        self.hub = hub
        self.pricing = pricing
        self.workspace_builder = workspace_builder
        self._active_processes: dict[str, asyncio.subprocess.Process] = {}

    async def start_process(self, process_id: str) -> dict[str, Any]:
        process = self.store.get_process(process_id)
        workdir = self.settings.workflow_root / process["workflow_id"] / "runs" / "pending"
        run = self.store.create_run(process_id, status="draft", workdir_path=str(workdir))
        actual_workdir = self.settings.workflow_root / process["workflow_id"] / "runs" / run["id"]
        self.store.update_run(run["id"], workdir_path=str(actual_workdir))
        snapshot = self.workspace_builder.build(run["id"], process_id)
        self.store.update_run(run["id"], status="running", input_snapshot_json=snapshot)
        asyncio.create_task(self._run_agent(run["id"], resume=False))
        return self.store.get_run(run["id"])

    async def resume_run(self, run_id: str, feedback_text: str) -> dict[str, Any]:
        parent = self.store.get_run(run_id)
        if parent["status"] not in RUN_STATUSES_ALLOWING_PUBLIC_RESUME:
            raise ConflictError(f"Run cannot be resumed from status: {parent['status']}")
        return await self._resume_run(parent, feedback_text)

    async def _resume_run(self, parent: dict[str, Any], feedback_text: str) -> dict[str, Any]:
        process = self.store.get_process(parent["process_id"])
        workdir = self.settings.workflow_root / process["workflow_id"] / "runs" / "pending"
        run = self.store.create_run(
            process["id"],
            status="draft",
            workdir_path=str(workdir),
            parent_run_id=parent["id"],
        )
        actual_workdir = self.settings.workflow_root / process["workflow_id"] / "runs" / run["id"]
        self.store.update_run(run["id"], workdir_path=str(actual_workdir))
        snapshot = self.workspace_builder.build(run["id"], process["id"], parent_run=parent, feedback_text=feedback_text)
        self.store.update_run(run["id"], status="running", input_snapshot_json=snapshot)
        asyncio.create_task(self._run_agent(run["id"], resume=True, feedback_text=feedback_text))
        return self.store.get_run(run["id"])

    async def submit_run(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if run["status"] not in RUN_STATUSES_ALLOWING_SUBMIT:
            raise ConflictError(f"Run cannot be submitted from status: {run['status']}")
        values = self._read_output_values(run)
        artifacts = self.store.replace_artifact_values(run_id, values)
        output_snapshot = {"artifacts": artifacts}
        self.store.create_review(run_id)
        updated = self.store.update_run(run_id, status="in_review", output_snapshot_json=output_snapshot)
        await self._publish(run_id, "status", {"status": "in_review"})
        await self._log(run_id, "info", "Submitted output for review")
        return updated

    async def review_run(self, run_id: str, action: str, feedback_text: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if run["status"] not in RUN_STATUSES_ALLOWING_REVIEW:
            raise ConflictError(f"Run cannot be reviewed from status: {run['status']}")
        if action == "approve":
            self.store.resolve_review(run_id, "approved", feedback_text)
            updated = self.store.update_run(run_id, status="approved")
            await self._publish(run_id, "status", {"status": "approved"})
            return updated
        self.store.resolve_review(run_id, "rejected", feedback_text)
        self.store.update_run(run_id, status="rejected")
        await self._publish(run_id, "status", {"status": "rejected", "feedback_text": feedback_text})
        return await self._resume_run(run, feedback_text)

    async def register_question(self, run_id: str, question_text: str, wait: bool, timeout_seconds: int | None) -> dict[str, Any]:
        qa = self.store.create_qa(run_id, question_text)
        self.store.update_run(run_id, status="waiting_qa", ended_at=None)
        await self._publish(run_id, "qa", qa)
        if not wait:
            return qa
        timeout = self.settings.qa_timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = time.monotonic() + max(timeout, 0)
        while True:
            current = self.store.get_qa(qa["id"])
            if current["status"] == "answered":
                self.store.update_run(run_id, status="running", ended_at=None)
                await self._publish(run_id, "status", {"status": "running"})
                return current
            if time.monotonic() >= deadline:
                timed_out = self.store.timeout_qa(qa["id"])
                if not timed_out.get("timed_out_by_this_call"):
                    continue
                self.store.update_run(run_id, status="failed")
                await self._publish(run_id, "qa_timeout", timed_out)
                await self._publish(run_id, "status", {"status": "failed"})
                await self._log(run_id, "error", f"QA timed out after {timeout} seconds")
                await self.terminate_process(run_id)
                raise TimeoutError(f"QA timed out after {timeout} seconds")
            await asyncio.sleep(1)

    async def answer_question(self, qa_id: str, answer_text: str) -> dict[str, Any]:
        current_qa = self.store.get_qa(qa_id)
        run = self.store.get_run(current_qa["run_id"])
        if run["status"] != "waiting_qa":
            raise ConflictError(f"QA cannot be answered while run is {run['status']}")
        qa = self.store.answer_qa(qa_id, answer_text)
        self.store.update_run(qa["run_id"], status="running", ended_at=None)
        await self._publish(qa["run_id"], "qa_answered", qa)
        await self._publish(qa["run_id"], "status", {"status": "running"})
        return qa

    async def _run_agent(self, run_id: str, *, resume: bool, feedback_text: str = "") -> None:
        run = self.store.get_run(run_id)
        process = self.store.get_process(run["process_id"])
        adapter = self._select_adapter()
        await self._log(run_id, "info", f"Starting {process['agent_kind']} agent for {process['name']}")
        try:
            result = await adapter.run(self, run, process, resume=resume, feedback_text=feedback_text)
            if result.session_id:
                self.store.update_run(run_id, session_id=result.session_id)
            current = self.store.get_run(run_id)
            if result.submitted and current["status"] == "running":
                await self.submit_run(run_id)
            elif not result.ok and current["status"] == "running":
                self.store.update_run(run_id, status="failed")
                await self._publish(run_id, "status", {"status": "failed"})
                await self._log(run_id, "error", result.error or "Agent failed")
            elif result.ok and current["status"] == "running":
                self.store.update_run(run_id, status="failed")
                await self._publish(run_id, "status", {"status": "failed"})
                await self._log(run_id, "error", "Agent exited before submitting output")
        except Exception as exc:  # noqa: BLE001
            current = self.store.get_run(run_id)
            if current["status"] in {"running", "waiting_qa", "draft"}:
                self.store.update_run(run_id, status="failed")
                await self._publish(run_id, "status", {"status": "failed"})
            await self._log(run_id, "error", str(exc))

    def register_process(self, run_id: str, process: asyncio.subprocess.Process) -> None:
        self._active_processes[run_id] = process

    def unregister_process(self, run_id: str, process: asyncio.subprocess.Process) -> None:
        if self._active_processes.get(run_id) is process:
            self._active_processes.pop(run_id, None)

    async def terminate_process(self, run_id: str) -> None:
        process = self._active_processes.get(run_id)
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()
        await self._log(run_id, "error", "Terminated agent process after QA timeout")

    def _select_adapter(self) -> "AgentAdapter":
        mode = self.settings.agent_mode.lower()
        command = shlex.split(self.settings.claude_command)
        command_exists = bool(command and shutil.which(command[0]))
        if mode == "mock" or (mode == "auto" and not command_exists):
            return MockAgentAdapter()
        return ClaudeCodeAdapter(command, self.settings)

    def describe_adapter(self) -> dict[str, Any]:
        mode = self.settings.agent_mode.lower()
        command = shlex.split(self.settings.claude_command)
        claude_available = bool(command and shutil.which(command[0]))
        active = "mock" if (mode == "mock" or (mode == "auto" and not claude_available)) else "claude"
        return {
            "agent_mode": mode,
            "claude_available": claude_available,
            "active_adapter": active,
            "claude_command": self.settings.claude_command,
            "default_permission_mode": self.settings.default_permission_mode,
            "default_allowed_tools": self.settings.default_allowed_tools,
            "default_disallowed_tools": self.settings.default_disallowed_tools,
        }

    def _read_output_values(self, run: dict[str, Any]) -> list[dict[str, Any]]:
        workdir = Path(run["workdir_path"])
        output_yaml = workdir / "output" / "output.yaml"
        data = yaml.safe_load(output_yaml.read_text(encoding="utf-8")) if output_yaml.exists() else {}
        items = data.get("output") or []
        output_artifacts = [
            self.store.get_artifact(edge["artifact_id"])
            for edge in self.store.get_edges_for_process(run["process_id"], "produces")
        ]
        artifacts_by_id = {artifact["id"]: artifact for artifact in output_artifacts}
        artifacts_by_name = {artifact["name"]: artifact for artifact in output_artifacts}
        values: list[dict[str, Any]] = []
        for index, item in enumerate(items):
            artifact = artifacts_by_id.get(item.get("id") or "") or artifacts_by_name.get(item.get("name") or "")
            if artifact is None and index < len(output_artifacts):
                artifact = output_artifacts[index]
            if artifact is None:
                continue
            artifact_type = item.get("type")
            if artifact_type not in {"file", "url", "text"}:
                artifact_type = artifact["type"]
            value = {"artifact_id": artifact["id"], "artifact_type": artifact_type}
            if artifact_type == "file":
                value["file_path"] = item.get("path") or f"output/{safe_name(item.get('name') or artifact['name'])}.md"
            elif artifact_type == "url":
                value["url"] = item.get("url") or ""
            else:
                value["text_value"] = item.get("text") or ""
            values.append(value)
        return values

    async def record_usage(
        self,
        run_id: str,
        process: dict[str, Any],
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read: int = 0,
        cache_write: int = 0,
    ) -> None:
        cost = self.pricing.cost(
            process["agent_model"],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read=cache_read,
            cache_write=cache_write,
        )
        usage = self.store.add_usage(
            run_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read=cache_read,
            cache_write=cache_write,
            cost_usd=cost,
            model=process["agent_model"],
        )
        await self._publish(run_id, "usage", usage)

    async def record_final_cost(self, run_id: str, process: dict[str, Any], total_cost_usd: float) -> None:
        current_cost = float(self.store.run_cost(run_id).get("cost_usd") or 0)
        adjustment = total_cost_usd - current_cost
        if abs(adjustment) < 0.000000001:
            return
        usage = self.store.add_usage(
            run_id,
            input_tokens=0,
            output_tokens=0,
            cache_read=0,
            cache_write=0,
            cost_usd=adjustment,
            model=process["agent_model"],
        )
        await self._publish(run_id, "usage", usage)

    async def _log(self, run_id: str, level: str, message: str, raw_json: dict[str, Any] | None = None) -> None:
        row = self.store.add_log(run_id, level, message, raw_json)
        await self._publish(run_id, "log", row)

    async def _publish(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        await self.hub.publish(run_id, {"type": event_type, "payload": payload})


class AgentAdapter:
    async def run(
        self,
        engine: ExecutionEngine,
        run: dict[str, Any],
        process: dict[str, Any],
        *,
        resume: bool,
        feedback_text: str,
    ) -> AgentResult:
        raise NotImplementedError


class MockAgentAdapter(AgentAdapter):
    async def run(
        self,
        engine: ExecutionEngine,
        run: dict[str, Any],
        process: dict[str, Any],
        *,
        resume: bool,
        feedback_text: str,
    ) -> AgentResult:
        await engine._log(run["id"], "info", "Claude command was unavailable; using local mock adapter")
        await asyncio.sleep(0.05)
        workdir = Path(run["workdir_path"])
        output_yaml = workdir / "output" / "output.yaml"
        data = yaml.safe_load(output_yaml.read_text(encoding="utf-8")) or {"output": []}
        for item in data.get("output", []):
            name = item.get("name") or item.get("id") or "artifact"
            if item.get("type") == "file":
                rel = item.get("path") or f"output/{safe_name(name)}.md"
                target = workdir / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"# {name}\n\nGenerated by the local mock adapter.\n", encoding="utf-8")
                item["path"] = rel
            elif item.get("type") == "url":
                item["url"] = item.get("url") or f"https://example.invalid/{safe_name(name)}"
            else:
                item["text"] = item.get("text") or f"Generated by the local mock adapter for {name}."
        output_yaml.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
        await engine.record_usage(run["id"], process, input_tokens=1200, output_tokens=450)
        return AgentResult(ok=True, submitted=True, session_id=run.get("session_id") or f"mock-{run['id']}")


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
        command = list(self.command)
        if "--model" not in command and "-m" not in command:
            command.extend(["--model", process["agent_model"]])
        effort = (process.get("agent_effort") or "").strip()
        if effort and "--effort" not in command:
            if effort not in AGENT_EFFORT_VALUES:
                raise AppValidationError(f"Invalid agent_effort: {effort}")
            command.extend(["--effort", effort])
        self._apply_permissions(command, process)
        return command

    def _permission_setting(self, process: dict[str, Any], key: str, default: str) -> str:
        """工程の値が空ならグローバル既定にフォールバックする。"""
        value = (process.get(key) or "").strip()
        if value:
            return value
        return default

    def _apply_permissions(self, command: list[str], process: dict[str, Any]) -> None:
        default_mode = self.settings.default_permission_mode if self.settings else "default"
        default_allowed = self.settings.default_allowed_tools if self.settings else ""
        default_disallowed = self.settings.default_disallowed_tools if self.settings else ""

        mode = self._permission_setting(process, "permission_mode", default_mode)
        if mode and "--permission-mode" not in command:
            if mode not in PERMISSION_MODE_VALUES or mode == "":
                raise AppValidationError(f"Invalid permission_mode: {mode}")
            command.extend(["--permission-mode", mode])

        # allowed/disallowed はカンマ区切り。各パターン（Bash(git *) 等は空白を含む）を
        # 個別の argv 要素として渡す（--allowedTools は可変長引数）。
        allowed = self._split_tools(self._permission_setting(process, "allowed_tools", default_allowed))
        disallowed = self._split_tools(self._permission_setting(process, "disallowed_tools", default_disallowed))
        if allowed and "--allowedTools" not in command and "--allowed-tools" not in command:
            command.append("--allowedTools")
            command.extend(allowed)
        if disallowed and "--disallowedTools" not in command and "--disallowed-tools" not in command:
            command.append("--disallowedTools")
            command.extend(disallowed)

    @staticmethod
    def _split_tools(value: str) -> list[str]:
        return [item.strip() for item in (value or "").split(",") if item.strip()]

    def _normalize_usage(self, usage: dict[str, Any]) -> dict[str, int]:
        return {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "output_tokens": int(usage.get("output_tokens", 0)),
            "cache_read": int(usage.get("cache_read_input_tokens", usage.get("cache_read", 0))),
            "cache_write": int(usage.get("cache_creation_input_tokens", usage.get("cache_write", 0))),
        }

    def _usage_for_event(self, parsed: dict[str, Any], seen_message_ids: set[str]) -> dict[str, int] | None:
        if parsed.get("event_type") != "assistant" or not parsed.get("usage"):
            return None
        message_id = parsed.get("message_id")
        if not message_id:
            return self._normalize_usage(parsed["usage"])
        if message_id in seen_message_ids:
            return None
        seen_message_ids.add(message_id)
        usage = self._normalize_usage(parsed["usage"])
        return usage if any(usage.values()) else None

    def _final_cost_for_event(self, parsed: dict[str, Any]) -> float | None:
        if parsed.get("event_type") != "result" or parsed.get("total_cost_usd") is None:
            return None
        return float(parsed["total_cost_usd"])

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
        message = data.get("message")
        message_id = None
        if isinstance(message, dict):
            message_id = message.get("id")
            text_blocks = message.get("content") or []
            if isinstance(text_blocks, list):
                text = " ".join(block.get("text", "") for block in text_blocks if isinstance(block, dict))
                message = text or data.get("type")
        usage = data.get("usage")
        if not usage and isinstance(data.get("message"), dict):
            usage = data["message"].get("usage")
        return {
            "event_type": data.get("type"),
            "message": str(message or data.get("type") or data),
            "message_id": message_id,
            "usage": usage,
            "total_cost_usd": data.get("total_cost_usd"),
            "session_id": data.get("session_id") or data.get("sessionId"),
            "raw": data,
        }
