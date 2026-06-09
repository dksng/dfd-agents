from __future__ import annotations

import asyncio
import shlex
import shutil
import time
from pathlib import Path
from typing import Any

import yaml

from .adapters import AgentAdapter, ClaudeCodeAdapter, MockAgentAdapter
from .config import Settings
from .db import Store
from .events import EventHub
from .exceptions import ConflictError
from .pricing import Pricing
from .run_state import can_public_resume, can_review, can_submit
from .workspace import WorkspaceBuilder, safe_name


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
        self._run_meta: dict[str, tuple[str, str]] = {}

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
        if not can_public_resume(parent["status"]):
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
        snapshot = self.workspace_builder.build(
            run["id"], process["id"], parent_run=parent, feedback_text=feedback_text
        )
        self.store.update_run(run["id"], status="running", input_snapshot_json=snapshot)
        asyncio.create_task(self._run_agent(run["id"], resume=True, feedback_text=feedback_text))
        return self.store.get_run(run["id"])

    async def submit_run(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not can_submit(run["status"]):
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
        if not can_review(run["status"]):
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

    async def register_question(
        self, run_id: str, question_text: str, wait: bool, timeout_seconds: int | None
    ) -> dict[str, Any]:
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

    def _select_adapter(self) -> AgentAdapter:
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
                value["file_path"] = item.get("path") or f"output/{safe_name(item.get('name') or artifact['name'])}"
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
        cache_write_5m: int = 0,
        cache_write_1h: int = 0,
    ) -> None:
        cost = self.pricing.cost(
            process["agent_model"],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read=cache_read,
            cache_write=cache_write,
            cache_write_5m=cache_write_5m,
            cache_write_1h=cache_write_1h,
        )
        usage = self.store.add_usage(
            run_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read=cache_read,
            cache_write=cache_write,
            cache_write_5m=cache_write_5m,
            cache_write_1h=cache_write_1h,
            cost_usd=cost,
            model=process["agent_model"],
        )
        await self._publish(run_id, "usage", usage)

    async def record_final_usage(
        self,
        run_id: str,
        process: dict[str, Any],
        final_usage: dict[str, int],
        *,
        observed_usage: dict[str, int] | None = None,
    ) -> None:
        observed = observed_usage or {}
        deltas = {
            "input_tokens": int(final_usage.get("input_tokens", 0)) - int(observed.get("input_tokens") or 0),
            "output_tokens": int(final_usage.get("output_tokens", 0)) - int(observed.get("output_tokens") or 0),
            "cache_read": int(final_usage.get("cache_read", 0)) - int(observed.get("cache_read") or 0),
            "cache_write": int(final_usage.get("cache_write", 0)) - int(observed.get("cache_write") or 0),
            "cache_write_5m": int(final_usage.get("cache_write_5m", 0)) - int(observed.get("cache_write_5m") or 0),
            "cache_write_1h": int(final_usage.get("cache_write_1h", 0)) - int(observed.get("cache_write_1h") or 0),
        }
        if not any(deltas.values()):
            return
        await self.record_usage(run_id, process, **deltas)

    async def record_final_cost(self, run_id: str, process: dict[str, Any], total_cost_usd: float) -> None:
        if not self.pricing.use_result_total_cost():
            return
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
            cache_write_5m=0,
            cache_write_1h=0,
            cost_usd=adjustment,
            model=process["agent_model"],
        )
        await self._publish(run_id, "usage", usage)

    async def _log(self, run_id: str, level: str, message: str, raw_json: dict[str, Any] | None = None) -> None:
        row = self.store.add_log(run_id, level, message, raw_json)
        await self._publish(run_id, "log", row)

    def _run_identity(self, run_id: str) -> tuple[str, str]:
        """Resolve and cache (process_id, workflow_id) for a run (immutable per run)."""
        cached = self._run_meta.get(run_id)
        if cached is not None:
            return cached
        run = self.store.get_run(run_id)
        process = self.store.get_process(run["process_id"])
        identity = (run["process_id"], process["workflow_id"])
        self._run_meta[run_id] = identity
        return identity

    async def _publish(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        process_id, workflow_id = self._run_identity(run_id)
        await self.hub.publish(
            run_id,
            {
                "type": event_type,
                "run_id": run_id,
                "process_id": process_id,
                "workflow_id": workflow_id,
                "payload": payload,
            },
        )
