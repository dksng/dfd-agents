from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import yaml
from fastapi.testclient import TestClient

from agent_orchestrator.api import create_app
from agent_orchestrator.config import Settings
from agent_orchestrator.execution import ClaudeCodeAdapter
from agent_orchestrator.pricing import Pricing
from agent_orchestrator.skills import SkillRegistry

AUTH = {"authorization": "Bearer dev-token"}


class FakeProcess:
    def __init__(self) -> None:
        self.returncode = None
        self.terminated = False
        self.killed = False

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        return self.returncode or 0


class DummyStore:
    def __init__(self) -> None:
        self.updates: list[tuple[str, dict[str, Any]]] = []

    def update_run(self, run_id: str, **updates: Any) -> None:
        self.updates.append((run_id, updates))


class DummyEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = DummyStore()
        self.logs: list[tuple[str, str, dict[str, Any] | None]] = []
        self.usages: list[dict[str, Any]] = []
        self.final_usages: list[dict[str, Any]] = []
        self.final_costs: list[float] = []
        self.processes: list[Any] = []

    def register_process(self, _run_id: str, process: Any) -> None:
        self.processes.append(process)

    def unregister_process(self, _run_id: str, process: Any) -> None:
        if process in self.processes:
            self.processes.remove(process)

    async def record_usage(self, _run_id: str, _process: dict[str, Any], **usage: Any) -> None:
        self.usages.append(usage)

    async def record_final_usage(
        self,
        _run_id: str,
        _process: dict[str, Any],
        final_usage: dict[str, int],
        *,
        observed_usage: dict[str, int] | None = None,
    ) -> None:
        self.final_usages.append({"final_usage": final_usage, "observed_usage": observed_usage})

    async def record_final_cost(self, _run_id: str, _process: dict[str, Any], total_cost_usd: float) -> None:
        self.final_costs.append(total_cost_usd)

    async def _log(
        self,
        _run_id: str,
        level: str,
        message: str,
        raw_json: dict[str, Any] | None = None,
    ) -> None:
        self.logs.append((level, message, raw_json))


def make_client(tmp_path: Path) -> TestClient:
    settings = Settings(
        config_root=tmp_path / "config",
        data_root=tmp_path / "data",
        agent_mode="mock",
        api_base="http://testserver",
    )
    return TestClient(create_app(settings))


def wait_for_status(client: TestClient, run_id: str, statuses: set[str]) -> dict[str, Any]:
    deadline = time.time() + 5
    while time.time() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in statuses:
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {statuses}")


def create_process(client: TestClient, workflow_id: str, name: str, process_type: str = "implement") -> dict[str, Any]:
    return client.post(
        f"/api/workflows/{workflow_id}/processes",
        json={"name": name, "type": process_type},
    ).json()


def create_artifact(
    client: TestClient,
    workflow_id: str,
    name: str,
    artifact_type: str = "text",
    **extra: Any,
) -> dict[str, Any]:
    payload = {"name": name, "type": artifact_type, **extra}
    return client.post(f"/api/workflows/{workflow_id}/artifacts", json=payload).json()


def create_edge(
    client: TestClient,
    workflow_id: str,
    kind: str,
    process_id: str,
    artifact_id: str,
):
    return client.post(
        f"/api/workflows/{workflow_id}/edges",
        json={"kind": kind, "process_id": process_id, "artifact_id": artifact_id},
    )


def attach_output(
    client: TestClient,
    workflow_id: str,
    process: dict[str, Any],
    name: str = "result",
    artifact_type: str = "text",
    **extra: Any,
) -> dict[str, Any]:
    artifact = create_artifact(client, workflow_id, name, artifact_type, **extra)
    response = create_edge(client, workflow_id, "produces", process["id"], artifact["id"])
    assert response.status_code == 200
    return artifact


def test_default_pricing_includes_opus_4_8(tmp_path: Path) -> None:
    pricing = Pricing(tmp_path / "pricing.yaml")
    cost = pricing.cost(
        "claude-opus-4-8",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read=1_000_000,
        cache_write_5m=1_000_000,
        cache_write_1h=1_000_000,
    )
    assert cost == 46.75


def test_model_catalog_and_process_default_come_from_pricing_yaml(tmp_path: Path) -> None:
    config_root = tmp_path / "config"
    config_root.mkdir()
    (config_root / "pricing.yaml").write_text(
        yaml.safe_dump(
            {
                "currency": "USD",
                "default_model": "custom-sonnet",
                "models": {
                    "custom-sonnet": {
                        "enabled": True,
                        "label": "Custom Sonnet",
                        "input": 2.0,
                        "output": 10.0,
                        "cache_read": 0.2,
                        "cache_write_5m": 2.5,
                        "cache_write_1h": 4.0,
                    },
                    "disabled-model": {
                        "enabled": False,
                        "label": "Disabled Model",
                        "input": 99.0,
                        "output": 99.0,
                    },
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    settings = Settings(
        config_root=config_root,
        data_root=tmp_path / "data",
        agent_mode="mock",
        api_base="http://testserver",
    )
    client = TestClient(create_app(settings))

    catalog = client.get("/api/models").json()
    assert catalog["default_model"] == "custom-sonnet"
    assert catalog["models"] == [
        {
            "id": "custom-sonnet",
            "label": "Custom Sonnet",
            "input": 2.0,
            "output": 10.0,
            "cache_read": 0.2,
            "cache_write_5m": 2.5,
            "cache_write_1h": 4.0,
        }
    ]

    workflow = client.post("/api/workflows", json={"name": "pricing defaults"}).json()
    process = client.post(
        f"/api/workflows/{workflow['id']}/processes",
        json={"name": "uses default"},
    ).json()
    assert process["agent_model"] == "custom-sonnet"


def test_command_includes_model_and_effort() -> None:
    adapter = ClaudeCodeAdapter(["claude", "--print"])
    command = adapter._command_for_process({"agent_model": "claude-opus-4-8", "agent_effort": "high"})
    assert command[command.index("--model") + 1] == "claude-opus-4-8"
    assert command[command.index("--effort") + 1] == "high"


def test_command_omits_effort_when_empty() -> None:
    adapter = ClaudeCodeAdapter(["claude"])
    command = adapter._command_for_process({"agent_model": "claude-sonnet-4-5", "agent_effort": ""})
    assert "--effort" not in command


def test_command_uses_global_permission_defaults() -> None:
    settings = Settings(
        default_permission_mode="default",
        default_allowed_tools="Read,Write,Bash(git *)",
        default_disallowed_tools="WebFetch",
    )
    adapter = ClaudeCodeAdapter(["claude", "--print"], settings)
    command = adapter._command_for_process(
        {
            "agent_model": "claude-sonnet-4-5",
            "agent_effort": "",
            "permission_mode": "",
            "allowed_tools": "",
            "disallowed_tools": "",
        }
    )
    assert command[command.index("--permission-mode") + 1] == "default"
    allowed_at = command.index("--allowedTools")
    assert command[allowed_at + 1 : allowed_at + 4] == ["Read", "Write", "Bash(git *)"]
    assert command[command.index("--disallowedTools") + 1] == "WebFetch"


def test_process_overrides_global_permission_mode() -> None:
    settings = Settings(default_permission_mode="default", default_allowed_tools="Read")
    adapter = ClaudeCodeAdapter(["claude"], settings)
    command = adapter._command_for_process(
        {
            "agent_model": "claude-sonnet-4-5",
            "agent_effort": "",
            "permission_mode": "bypassPermissions",
            "allowed_tools": "Write,Bash(python3 *)",
            "disallowed_tools": "",
        }
    )
    assert command[command.index("--permission-mode") + 1] == "bypassPermissions"
    allowed_at = command.index("--allowedTools")
    assert command[allowed_at + 1 : allowed_at + 3] == ["Write", "Bash(python3 *)"]


def test_permission_mode_persists_and_rejects_invalid(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "perm"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Impl", "type": "implement"},
        ).json()
        updated = client.put(
            f"/api/processes/{process['id']}/config",
            json={"permission_mode": "bypassPermissions", "allowed_tools": "Read,Write"},
        ).json()
        assert updated["permission_mode"] == "bypassPermissions"
        assert updated["allowed_tools"] == "Read,Write"
        bad = client.put(
            f"/api/processes/{process['id']}/config",
            json={"permission_mode": "nonsense"},
        )
        assert bad.status_code == 422


def test_health_reports_permission_defaults(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        health = client.get("/api/health").json()
        assert health["default_permission_mode"]
        assert "default_allowed_tools" in health


def test_command_rejects_invalid_effort() -> None:
    adapter = ClaudeCodeAdapter(["claude"])
    try:
        adapter._command_for_process({"agent_model": "claude-sonnet-4-5", "agent_effort": "invalid"})
    except ValueError as exc:
        assert "Invalid agent_effort" in str(exc)
    else:
        raise AssertionError("invalid effort should be rejected")


def test_process_effort_persists(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "effort"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Impl", "type": "implement"},
        ).json()
        updated = client.put(
            f"/api/processes/{process['id']}/config",
            json={"agent_model": "claude-opus-4-8", "agent_effort": "high"},
        ).json()
        assert updated["agent_model"] == "claude-opus-4-8"
        assert updated["agent_effort"] == "high"


def test_process_effort_rejects_invalid_value(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "effort-invalid"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Impl", "type": "implement"},
        ).json()
        response = client.put(
            f"/api/processes/{process['id']}/config",
            json={"agent_effort": "invalid"},
        )
        assert response.status_code == 422


def test_health_reports_active_adapter(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        health = client.get("/api/health").json()
        assert health["status"] == "ok"
        assert health["active_adapter"] == "mock"
        assert "agent_mode" in health


def test_agents_base_returns_template(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        body = client.get("/api/templates/base/agents-base").json()
        assert "Goal.md" in body["content"]


def test_runtime_settings_update_skill_repos_persists_and_lists_skills(tmp_path: Path) -> None:
    repo = tmp_path / "skill-repo"
    skill_dir = repo / "custom-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "# Custom Skill\n\nUse this for custom repository setup tests.\n",
        encoding="utf-8",
    )

    with make_client(tmp_path) as client:
        updated = client.put(
            "/api/settings",
            json={
                "skill_repos": [str(repo)],
                "notify_enabled": True,
                "notify_events": ["waiting_qa", "failed", "unknown"],
            },
        ).json()
        assert updated["skill_repos"] == [str(repo)]
        assert updated["notify_enabled"] is True
        assert updated["notify_events"] == ["waiting_qa", "failed"]
        listed = client.get("/api/skills").json()
        assert listed["errors"] == []
        assert [item["name"] for item in listed["skills"]] == ["custom-skill"]

    settings = Settings(
        config_root=tmp_path / "config",
        data_root=tmp_path / "data",
        agent_mode="mock",
        api_base="http://testserver",
    )
    with TestClient(create_app(settings)) as client:
        saved = client.get("/api/settings").json()
        assert saved["skill_repos"] == [str(repo)]
        assert saved["notify_enabled"] is True
        assert saved["notify_events"] == ["waiting_qa", "failed"]


def test_skill_description_uses_frontmatter_description(tmp_path: Path) -> None:
    skill_dir = tmp_path / "skills" / "write-report"
    skill_dir.mkdir(parents=True)
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(
        "---\n"
        "name: write-report\n"
        'description: "Write polished reports from research notes."\n'
        "---\n\n"
        "# Write Report\n\n"
        "Fallback body text.\n",
        encoding="utf-8",
    )
    registry = SkillRegistry(Settings(config_root=tmp_path / "config", data_root=tmp_path / "data"))
    assert registry._extract_description(skill_md) == "Write polished reports from research notes."


def test_workflow_export_import_creates_copy_and_remaps_goal_tokens(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "portable"}).json()
        process = create_process(client, workflow["id"], "Designer", "design")
        source = create_artifact(
            client,
            workflow["id"],
            "Source PR",
            "url",
            source_url="https://github.com/example/repo/pull/1",
            pos_x=20,
            pos_y=30,
        )
        output = attach_output(
            client,
            workflow["id"],
            process,
            "Design Doc",
            "file",
            spec_json={"legacy": "kept"},
        )
        assert create_edge(client, workflow["id"], "consumes", process["id"], source["id"]).status_code == 200
        updated = client.put(
            f"/api/processes/{process['id']}/config",
            json={
                "agent_model": "claude-opus-4-8",
                "agent_effort": "high",
                "permission_mode": "default",
                "goal_md": f"Use {{{{artifact:{source['id']}}}}} to produce {{{{artifact:{output['id']}}}}}.",
                "skills": [
                    {
                        "skill_name": "portable-skill",
                        "skill_source": "git",
                        "skill_ref": "owner/repo#skills/portable-skill",
                    }
                ],
            },
        ).json()
        assert updated["skills"][0]["skill_name"] == "portable-skill"

        exported = client.get(f"/api/workflows/{workflow['id']}/export")
        assert exported.status_code == 200
        assert "Content-Disposition" in exported.headers
        document = exported.json()
        assert document["format_version"] == 1
        assert document["processes"][0]["ref"] == process["id"]
        assert "runs" not in document["processes"][0]

        imported = client.post(
            "/api/workflows/import",
            json={"name": "portable copy", "document": document},
        ).json()
        assert imported["id"] != workflow["id"]
        assert imported["name"] == "portable copy"
        imported_process = imported["processes"][0]
        imported_artifacts = {artifact["name"]: artifact for artifact in imported["artifacts"]}
        assert imported_process["id"] != process["id"]
        assert imported_artifacts["Source PR"]["id"] != source["id"]
        assert imported_artifacts["Design Doc"]["id"] != output["id"]
        assert source["id"] not in imported_process["goal_md"]
        assert output["id"] not in imported_process["goal_md"]
        assert f"{{{{artifact:{imported_artifacts['Source PR']['id']}}}}}" in imported_process["goal_md"]
        assert f"{{{{artifact:{imported_artifacts['Design Doc']['id']}}}}}" in imported_process["goal_md"]
        assert imported_process["skills"][0]["skill_ref"] == "owner/repo#skills/portable-skill"
        assert {edge["kind"] for edge in imported["edges"]} == {"produces", "consumes"}
        assert imported_process["runs"] == []


def test_delete_workflow_rejects_active_runs_and_removes_workdir(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "delete-me"}).json()
        process = create_process(client, workflow["id"], "Worker")
        workflow_dir = client.app.state.settings.workflow_root / workflow["id"]
        run_dir = workflow_dir / "runs" / "manual"
        run_dir.mkdir(parents=True)
        run = client.app.state.store.create_run(
            process["id"],
            status="running",
            workdir_path=str(run_dir),
        )

        active_delete = client.delete(f"/api/workflows/{workflow['id']}")
        assert active_delete.status_code == 409
        assert workflow_dir.exists()
        assert client.get(f"/api/workflows/{workflow['id']}").status_code == 200

        client.app.state.store.update_run(run["id"], status="failed")
        deleted = client.delete(f"/api/workflows/{workflow['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"ok": True}
        assert not workflow_dir.exists()
        assert client.get(f"/api/workflows/{workflow['id']}").status_code == 404


def test_claude_usage_counts_assistant_messages_once_and_parses_result_usage() -> None:
    adapter = ClaudeCodeAdapter(["claude"])
    seen: set[str] = set()
    assistant = adapter._parse_event(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 3,
                        "cache_read_input_tokens": 5,
                        "cache_creation_input_tokens": 2,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 1,
                            "ephemeral_1h_input_tokens": 1,
                        },
                    },
                },
                "session_id": "session_1",
            }
        )
    )
    duplicate = adapter._parse_event(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 3,
                        "cache_read_input_tokens": 5,
                        "cache_creation_input_tokens": 2,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 1,
                            "ephemeral_1h_input_tokens": 1,
                        },
                    },
                },
            }
        )
    )
    result = adapter._parse_event(
        json.dumps(
            {
                "type": "result",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 30,
                    "cache_read_input_tokens": 50,
                    "cache_creation_input_tokens": 20,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 12,
                        "ephemeral_1h_input_tokens": 8,
                    },
                },
                "total_cost_usd": 0.123,
            }
        )
    )

    assert adapter._usage_for_event(assistant, seen) == {
        "input_tokens": 10,
        "output_tokens": 3,
        "cache_read": 5,
        "cache_write": 2,
        "cache_write_5m": 1,
        "cache_write_1h": 1,
    }
    assert assistant["session_id"] == "session_1"
    assert adapter._usage_for_event(duplicate, seen) is None
    assert adapter._usage_for_event(result, seen) is None
    assert adapter._final_usage_for_event(result) == {
        "input_tokens": 100,
        "output_tokens": 30,
        "cache_read": 50,
        "cache_write": 20,
        "cache_write_5m": 12,
        "cache_write_1h": 8,
    }
    assert adapter._final_cost_for_event(result) == 0.123


def test_claude_adapter_reads_large_stream_json_line(tmp_path: Path) -> None:
    settings = Settings(
        config_root=tmp_path / "config",
        data_root=tmp_path / "data",
        default_permission_mode="",
        default_allowed_tools="",
        claude_stream_limit_bytes=256 * 1024,
    )
    script = """
import json
import sys

sys.stdin.read()
print(json.dumps({
    "type": "assistant",
    "session_id": "session-large",
    "message": {
        "id": "msg_large",
        "content": [{"type": "text", "text": "x" * 70000}],
        "usage": {"input_tokens": 1, "output_tokens": 1},
    },
}), flush=True)
print(json.dumps({
    "type": "result",
    "session_id": "session-large",
    "usage": {"input_tokens": 1, "output_tokens": 1},
}), flush=True)
"""
    adapter = ClaudeCodeAdapter([sys.executable, "-c", script], settings)
    engine = DummyEngine(settings)

    result = asyncio.run(
        adapter.run(
            engine,  # type: ignore[arg-type]
            {"id": "run_large", "workdir_path": str(tmp_path), "session_id": None},
            {"agent_model": "claude-opus-4-8", "agent_effort": ""},
            resume=False,
            feedback_text="",
        )
    )

    assert result.ok is True
    assert result.session_id == "session-large"
    assert any(level == "info" and len(message) == 70000 for level, message, _raw in engine.logs)
    assert engine.usages == [
        {
            "input_tokens": 1,
            "output_tokens": 1,
            "cache_read": 0,
            "cache_write": 0,
            "cache_write_5m": 0,
            "cache_write_1h": 0,
        }
    ]


def test_claude_adapter_terminates_child_when_stream_reader_fails(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(
        config_root=tmp_path / "config",
        data_root=tmp_path / "data",
        default_permission_mode="",
        default_allowed_tools="",
        claude_stream_limit_bytes=1024,
    )
    script = """
import json
import sys
import time

sys.stdin.read()
print(json.dumps({
    "type": "assistant",
    "message": {"content": [{"type": "text", "text": "x" * 5000}]},
}), flush=True)
time.sleep(60)
"""
    captured: dict[str, asyncio.subprocess.Process] = {}
    original_create_subprocess_exec = asyncio.create_subprocess_exec

    async def capture_process(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
        process = await original_create_subprocess_exec(*args, **kwargs)
        captured["process"] = process
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)
    adapter = ClaudeCodeAdapter([sys.executable, "-c", script], settings)
    engine = DummyEngine(settings)

    try:
        asyncio.run(
            adapter.run(
                engine,  # type: ignore[arg-type]
                {"id": "run_fail", "workdir_path": str(tmp_path), "session_id": None},
                {"agent_model": "claude-opus-4-8", "agent_effort": ""},
                resume=False,
                feedback_text="",
            )
        )
    except ValueError as exc:
        assert "Separator is found, but chunk is longer than limit" in str(exc)
    else:
        raise AssertionError("stream reader limit should fail")

    assert captured["process"].returncode is not None
    assert engine.processes == []


def test_final_usage_reconciles_tokens_without_result_cost_override(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "usage totals"}).json()
        process = create_process(client, workflow["id"], "Worker")
        run = client.app.state.store.create_run(
            process["id"],
            status="running",
            workdir_path=str(tmp_path / "run"),
        )
        engine = client.app.state.engine
        observed_usage = {
            "input_tokens": 10,
            "output_tokens": 3,
            "cache_read": 5,
            "cache_write": 2,
            "cache_write_5m": 1,
            "cache_write_1h": 1,
        }
        final_usage = {
            "input_tokens": 100,
            "output_tokens": 30,
            "cache_read": 50,
            "cache_write": 20,
            "cache_write_5m": 12,
            "cache_write_1h": 8,
        }

        asyncio.run(
            engine.record_usage(
                run["id"],
                process,
                **observed_usage,
            )
        )
        asyncio.run(
            engine.record_final_usage(
                run["id"],
                process,
                final_usage,
                observed_usage=observed_usage,
            )
        )
        pricing_cost = engine.pricing.cost(
            process["agent_model"],
            **final_usage,
        )
        asyncio.run(engine.record_final_cost(run["id"], process, 0.000001))

        summary = client.get(f"/api/runs/{run['id']}/cost").json()
        assert summary["input_tokens"] == final_usage["input_tokens"]
        assert summary["output_tokens"] == final_usage["output_tokens"]
        assert summary["cache_read"] == final_usage["cache_read"]
        assert summary["cache_write"] == final_usage["cache_write"]
        assert summary["cache_write_5m"] == final_usage["cache_write_5m"]
        assert summary["cache_write_1h"] == final_usage["cache_write_1h"]
        assert abs(summary["cost_usd"] - pricing_cost) < 0.000000001


def test_final_usage_reconciles_multiple_result_segments(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "usage segments"}).json()
        process = create_process(client, workflow["id"], "Worker")
        run = client.app.state.store.create_run(
            process["id"],
            status="running",
            workdir_path=str(tmp_path / "run"),
        )
        engine = client.app.state.engine
        segments = [
            (
                {
                    "input_tokens": 10,
                    "output_tokens": 3,
                    "cache_read": 5,
                    "cache_write": 2,
                    "cache_write_5m": 1,
                    "cache_write_1h": 1,
                },
                {
                    "input_tokens": 10,
                    "output_tokens": 30,
                    "cache_read": 5,
                    "cache_write": 2,
                    "cache_write_5m": 1,
                    "cache_write_1h": 1,
                },
            ),
            (
                {
                    "input_tokens": 2,
                    "output_tokens": 1,
                    "cache_read": 8,
                    "cache_write": 4,
                    "cache_write_5m": 4,
                    "cache_write_1h": 0,
                },
                {
                    "input_tokens": 2,
                    "output_tokens": 20,
                    "cache_read": 8,
                    "cache_write": 4,
                    "cache_write_5m": 4,
                    "cache_write_1h": 0,
                },
            ),
        ]

        expected = {key: 0 for key in segments[0][1]}
        for observed_usage, final_usage in segments:
            asyncio.run(engine.record_usage(run["id"], process, **observed_usage))
            asyncio.run(
                engine.record_final_usage(
                    run["id"],
                    process,
                    final_usage,
                    observed_usage=observed_usage,
                )
            )
            for key, value in final_usage.items():
                expected[key] += value

        pricing_cost = engine.pricing.cost(process["agent_model"], **expected)
        summary = client.get(f"/api/runs/{run['id']}/cost").json()
        for key, value in expected.items():
            assert summary[key] == value
        assert abs(summary["cost_usd"] - pricing_cost) < 0.000000001


def test_workflow_run_review_and_cost(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "demo"}).json()
        process = create_process(client, workflow["id"], "Implement")
        artifact = attach_output(
            client,
            workflow["id"],
            process,
            "implementation_notes",
            "file",
        )
        client.put(
            f"/api/processes/{process['id']}/config",
            json={"goal_md": f"Produce {{artifact:{artifact['id']}}}"},
        )

        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review", "failed"})
        assert run["status"] == "in_review"
        assert run["artifacts"][0]["artifact_id"] == artifact["id"]
        assert run["artifacts"][0]["artifact_type"] == "file"
        assert (Path(run["workdir_path"]) / run["artifacts"][0]["file_path"]).exists()

        cost = client.get(f"/api/workflows/{workflow['id']}/cost").json()
        assert cost["input_tokens"] == 1200
        assert cost["output_tokens"] == 450
        assert cost["cache_write_5m"] == 0
        assert cost["cache_write_1h"] == 0
        assert cost["cost_usd"] > 0
        run_detail = client.get(f"/api/runs/{run['id']}").json()
        assert run_detail["cost_usd"] == cost["cost_usd"]
        assert run_detail["cache_write_5m"] == 0
        assert run_detail["cache_write_1h"] == 0
        full_workflow = client.get(f"/api/workflows/{workflow['id']}").json()
        run_summary = full_workflow["processes"][0]["runs"][0]
        assert run_summary["input_tokens"] == 1200
        assert run_summary["output_tokens"] == 450
        assert run_summary["cache_write_5m"] == 0
        assert run_summary["cache_write_1h"] == 0
        assert run_summary["cost_usd"] == cost["cost_usd"]

        reviewed = client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"}).json()
        assert reviewed["status"] == "approved"


def test_file_output_path_is_derived_from_artifact_name(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "file-path"}).json()
        process = create_process(client, workflow["id"], "Producer")
        artifact = attach_output(
            client,
            workflow["id"],
            process,
            "final report",
            "file",
            spec_json={"path": "output/custom.md"},
        )
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        output_yaml = Path(run["workdir_path"]) / "output" / "output.yaml"
        data = yaml.safe_load(output_yaml.read_text(encoding="utf-8"))
        assert data["output"][0]["id"] == artifact["id"]
        assert data["output"][0]["path"] == "output/final_report"


def test_file_output_path_preserves_artifact_extension(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "html-path"}).json()
        process = create_process(client, workflow["id"], "Producer")
        artifact = attach_output(client, workflow["id"], process, "DetaileDesign.html", "file")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        output_yaml = Path(run["workdir_path"]) / "output" / "output.yaml"
        data = yaml.safe_load(output_yaml.read_text(encoding="utf-8"))
        assert data["output"][0]["id"] == artifact["id"]
        assert data["output"][0]["path"] == "output/DetaileDesign.html"


def test_reject_marks_original_run_rejected_and_starts_child(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "review"}).json()
        process = create_process(client, workflow["id"], "Reviewable")
        attach_output(client, workflow["id"], process, "notes")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})

        child = client.post(
            f"/api/runs/{run['id']}/review",
            json={"action": "reject", "feedback_text": "revise"},
        ).json()

        original = client.get(f"/api/runs/{run['id']}").json()
        assert original["status"] == "rejected"
        assert child["parent_run_id"] == run["id"]
        assert child["session_id"] is None
        child = wait_for_status(client, child["id"], {"in_review", "failed"})
        assert child["status"] == "in_review"


def test_callback_endpoints_require_orch_token(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "qa"}).json()
        process = create_process(client, workflow["id"], "Ask", "design")
        run = client.post(f"/api/processes/{process['id']}/run").json()

        unauthorized = client.post(
            f"/api/runs/{run['id']}/qa?wait=false",
            json={"question_text": "Which branch?"},
        )
        assert unauthorized.status_code == 401

        qa = client.post(
            f"/api/runs/{run['id']}/qa?wait=false",
            json={"question_text": "Which branch?"},
            headers=AUTH,
        ).json()
        assert qa["status"] == "pending"


def test_download_rejects_paths_outside_workdir(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "download"}).json()
        process = create_process(client, workflow["id"], "Producer")
        artifact = attach_output(client, workflow["id"], process, "notes", "file")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.app.state.store.replace_artifact_values(
            run["id"],
            [
                {
                    "artifact_id": artifact["id"],
                    "artifact_type": "file",
                    "file_path": "../../README.md",
                }
            ],
        )

        response = client.get(f"/api/runs/{run['id']}/artifacts/{artifact['id']}/download")
        assert response.status_code == 403


def test_submit_falls_back_to_output_name_when_id_is_changed(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "submit"}).json()
        process = create_process(client, workflow["id"], "Producer")
        artifact = attach_output(client, workflow["id"], process, "report")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        output_yaml = Path(run["workdir_path"]) / "output" / "output.yaml"
        output_yaml.write_text(
            yaml.safe_dump(
                {
                    "output": [
                        {
                            "id": "rewritten",
                            "name": artifact["name"],
                            "type": "text",
                            "text": "resolved by name",
                        }
                    ]
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        client.app.state.store.update_run(run["id"], status="running", ended_at=None)

        submitted = client.post(f"/api/runs/{run['id']}/submit", json={}, headers=AUTH)
        assert submitted.status_code == 200
        refreshed = client.get(f"/api/runs/{run['id']}").json()
        assert refreshed["artifacts"][0]["artifact_id"] == artifact["id"]
        assert refreshed["artifacts"][0]["text_value"] == "resolved by name"


def test_submit_rejects_terminal_run_without_reopening_review(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "terminal"}).json()
        process = create_process(client, workflow["id"], "Producer")
        attach_output(client, workflow["id"], process, "result")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.app.state.store.update_run(run["id"], status="failed")

        response = client.post(f"/api/runs/{run['id']}/submit", json={}, headers=AUTH)
        assert response.status_code == 409
        refreshed = client.get(f"/api/runs/{run['id']}").json()
        assert refreshed["status"] == "failed"


def test_review_and_resume_reject_terminal_states(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "terminal-review"}).json()
        process = create_process(client, workflow["id"], "Review")
        attach_output(client, workflow["id"], process, "result")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        approved = client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"}).json()
        assert approved["status"] == "approved"

        review_again = client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"})
        assert review_again.status_code == 409
        resume_approved = client.post(f"/api/runs/{run['id']}/resume", json={"feedback_text": "again"})
        assert resume_approved.status_code == 409


def test_public_resume_only_allows_failed_runs(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "resume"}).json()
        process = create_process(client, workflow["id"], "Resume")
        attach_output(client, workflow["id"], process, "result")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})

        in_review_resume = client.post(f"/api/runs/{run['id']}/resume", json={"feedback_text": "retry"})
        assert in_review_resume.status_code == 409

        client.app.state.store.update_run(run["id"], status="failed")
        child = client.post(f"/api/runs/{run['id']}/resume", json={"feedback_text": "retry"}).json()
        assert child["parent_run_id"] == run["id"]
        assert child["session_id"] is None
        child = wait_for_status(client, child["id"], {"in_review", "failed"})
        assert child["status"] == "in_review"


def test_source_artifact_is_injected_without_producer(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "source"}).json()
        consumer = create_process(client, workflow["id"], "Consumer")
        source = create_artifact(
            client,
            workflow["id"],
            "requirements",
            "text",
            source_text="source text from user",
        )
        assert create_edge(client, workflow["id"], "consumes", consumer["id"], source["id"]).status_code == 200

        run = client.post(f"/api/processes/{consumer['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        input_yaml = Path(run["workdir_path"]) / "input" / "input.yaml"
        data = yaml.safe_load(input_yaml.read_text(encoding="utf-8"))
        assert data["input"][0]["id"] == source["id"]
        assert data["input"][0]["text"] == "source text from user"


def test_uploaded_file_source_artifact_is_injected(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "file-source"}).json()
        consumer = create_process(client, workflow["id"], "Consumer")
        source = create_artifact(client, workflow["id"], "brief", "file")

        upload = client.post(
            f"/api/artifacts/{source['id']}/source-file?filename=brief.txt",
            content=b"uploaded source file",
            headers={"content-type": "application/octet-stream"},
        )
        assert upload.status_code == 200
        uploaded = upload.json()
        assert Path(uploaded["source_file_path"]).name == "brief.txt"
        assert create_edge(client, workflow["id"], "consumes", consumer["id"], source["id"]).status_code == 200

        run = client.post(f"/api/processes/{consumer['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        input_yaml = Path(run["workdir_path"]) / "input" / "input.yaml"
        data = yaml.safe_load(input_yaml.read_text(encoding="utf-8"))
        input_path = Path(run["workdir_path"]) / data["input"][0]["path"]
        assert input_path.read_text(encoding="utf-8") == "uploaded source file"


def test_produced_artifact_rejects_source_upload_and_ignores_source_default(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "produced-source"}).json()
        producer = create_process(client, workflow["id"], "Producer")
        consumer = create_process(client, workflow["id"], "Consumer")
        artifact = create_artifact(
            client,
            workflow["id"],
            "generated",
            "text",
            source_text="must not be used",
        )
        assert create_edge(client, workflow["id"], "produces", producer["id"], artifact["id"]).status_code == 200
        assert create_edge(client, workflow["id"], "consumes", consumer["id"], artifact["id"]).status_code == 200

        produced_file = create_artifact(client, workflow["id"], "generated_file", "file")
        assert create_edge(client, workflow["id"], "produces", producer["id"], produced_file["id"]).status_code == 200
        upload = client.post(
            f"/api/artifacts/{produced_file['id']}/source-file?filename=ignored.txt",
            content=b"ignored",
            headers={"content-type": "application/octet-stream"},
        )
        assert upload.status_code == 409

        run = client.post(f"/api/processes/{consumer['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        input_yaml = Path(run["workdir_path"]) / "input" / "input.yaml"
        data = yaml.safe_load(input_yaml.read_text(encoding="utf-8"))
        assert data["input"][0]["text"] == ""


def test_approved_upstream_artifact_is_injected_and_can_fan_out(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "pipeline"}).json()
        producer = create_process(client, workflow["id"], "Producer", "design")
        first_consumer = create_process(client, workflow["id"], "First Consumer", "implement")
        second_consumer = create_process(client, workflow["id"], "Second Consumer", "review")
        artifact = attach_output(client, workflow["id"], producer, "design_notes")

        assert create_edge(client, workflow["id"], "consumes", first_consumer["id"], artifact["id"]).status_code == 200
        assert create_edge(client, workflow["id"], "consumes", second_consumer["id"], artifact["id"]).status_code == 200

        run = client.post(f"/api/processes/{producer['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"})

        consumer_run = client.post(f"/api/processes/{first_consumer['id']}/run").json()
        consumer_run = wait_for_status(client, consumer_run["id"], {"in_review"})
        input_yaml = Path(consumer_run["workdir_path"]) / "input" / "input.yaml"
        data = yaml.safe_load(input_yaml.read_text(encoding="utf-8"))
        assert data["input"][0]["id"] == artifact["id"]
        assert data["input"][0]["text"].startswith("Generated by the local mock adapter")


def test_edges_reject_self_loop_duplicate_producer_duplicate_consume_and_cycles(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "edges"}).json()
        first = create_process(client, workflow["id"], "First", "design")
        second = create_process(client, workflow["id"], "Second", "implement")
        third = create_process(client, workflow["id"], "Third", "evaluate")
        first_artifact = create_artifact(client, workflow["id"], "first_output")
        second_artifact = create_artifact(client, workflow["id"], "second_output")
        third_artifact = create_artifact(client, workflow["id"], "third_output")

        assert create_edge(client, workflow["id"], "produces", first["id"], first_artifact["id"]).status_code == 200
        self_loop = create_edge(client, workflow["id"], "consumes", first["id"], first_artifact["id"])
        assert self_loop.status_code == 422

        duplicate_producer = create_edge(client, workflow["id"], "produces", third["id"], first_artifact["id"])
        assert duplicate_producer.status_code == 422

        assert create_edge(client, workflow["id"], "consumes", second["id"], first_artifact["id"]).status_code == 200
        duplicate_consume = create_edge(client, workflow["id"], "consumes", second["id"], first_artifact["id"])
        assert duplicate_consume.status_code == 422

        assert create_edge(client, workflow["id"], "produces", second["id"], second_artifact["id"]).status_code == 200
        assert create_edge(client, workflow["id"], "consumes", third["id"], second_artifact["id"]).status_code == 200
        assert create_edge(client, workflow["id"], "produces", third["id"], third_artifact["id"]).status_code == 200
        cycle = create_edge(client, workflow["id"], "consumes", first["id"], third_artifact["id"])
        assert cycle.status_code == 422


def test_edges_reject_cross_workflow_nodes(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow_a = client.post("/api/workflows", json={"name": "a"}).json()
        workflow_b = client.post("/api/workflows", json={"name": "b"}).json()
        process_a = create_process(client, workflow_a["id"], "A")
        process_b = create_process(client, workflow_b["id"], "B")
        artifact_a = create_artifact(client, workflow_a["id"], "artifact_a")
        artifact_b = create_artifact(client, workflow_b["id"], "artifact_b")

        cross_artifact = create_edge(client, workflow_a["id"], "produces", process_a["id"], artifact_b["id"])
        assert cross_artifact.status_code == 422

        cross_process = create_edge(client, workflow_a["id"], "consumes", process_b["id"], artifact_a["id"])
        assert cross_process.status_code == 422


def test_attention_summary_reflects_latest_run_state(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "attn"}).json()
        process = create_process(client, workflow["id"], "Impl", "implement")

        # No runs yet -> no attention entries.
        assert client.get("/api/attention").json() == []

        run = client.post(f"/api/processes/{process['id']}/run").json()
        wait_for_status(client, run["id"], {"in_review"})

        summary = client.get("/api/attention").json()
        entry = next(item for item in summary if item["workflow_id"] == workflow["id"])
        assert entry["in_review"] == 1
        assert entry["waiting_qa"] == 0
        assert entry["failed"] == 0

        # Approving clears the attention count (derived from current state).
        client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"})
        assert client.get("/api/attention").json() == []


def test_graph_changes_broadcast_on_global_events(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "sync"}).json()
        with client.websocket_connect("/ws/events") as ws:
            # A structural change made by another client is broadcast with its origin.
            client.post(
                f"/api/workflows/{workflow['id']}/processes",
                json={"name": "Impl", "type": "implement"},
                headers={"x-orch-client": "agent-1"},
            )
            event = ws.receive_json()
            assert event["type"] == "graph"
            assert event["action"] == "process.create"
            assert event["workflow_id"] == workflow["id"]
            assert event["origin"] == "agent-1"
            assert "process_id" in event["payload"]


def test_qa_answer_flow(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "qa"}).json()
        process = create_process(client, workflow["id"], "Ask", "design")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        qa = client.post(
            f"/api/runs/{run['id']}/qa?wait=false",
            json={"question_text": "Which branch?"},
            headers=AUTH,
        ).json()
        assert qa["status"] == "pending"
        answered = client.post(f"/api/qa/{qa['id']}/answer", json={"answer_text": "main"}).json()
        assert answered["answer_text"] == "main"


def test_qa_wait_times_out_and_cannot_be_answered_later(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "qa-timeout"}).json()
        process = create_process(client, workflow["id"], "Ask", "design")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        fake_process = FakeProcess()
        client.app.state.engine.register_process(run["id"], fake_process)

        response = client.post(
            f"/api/runs/{run['id']}/qa?timeout_seconds=0",
            json={"question_text": "No answer expected"},
            headers=AUTH,
        )
        assert response.status_code == 408
        assert fake_process.terminated is True

        refreshed = client.get(f"/api/runs/{run['id']}").json()
        assert refreshed["status"] == "failed"
        assert refreshed["qa"][0]["status"] == "timed_out"

        late_answer = client.post(
            f"/api/qa/{refreshed['qa'][0]['id']}/answer",
            json={"answer_text": "too late"},
        )
        assert late_answer.status_code == 409
