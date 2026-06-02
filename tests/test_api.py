from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import yaml
from fastapi.testclient import TestClient

from agent_orchestrator.api import create_app
from agent_orchestrator.config import Settings
from agent_orchestrator.execution import ClaudeCodeAdapter
from agent_orchestrator.pricing import Pricing

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
        cache_write=1_000_000,
    )
    assert cost == 110.25


def test_claude_usage_counts_assistant_messages_once_and_uses_result_cost() -> None:
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
    }
    assert assistant["session_id"] == "session_1"
    assert adapter._usage_for_event(duplicate, seen) is None
    assert adapter._usage_for_event(result, seen) is None
    assert adapter._final_cost_for_event(result) == 0.123


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
        assert cost["cost_usd"] > 0

        reviewed = client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"}).json()
        assert reviewed["status"] == "approved"


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
