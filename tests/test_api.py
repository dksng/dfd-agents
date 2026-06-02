from __future__ import annotations

import json
import time
from pathlib import Path

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


def wait_for_status(client: TestClient, run_id: str, statuses: set[str]) -> dict:
    deadline = time.time() + 5
    while time.time() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in statuses:
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {statuses}")


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
    assert adapter._usage_for_event(duplicate, seen) is None
    assert adapter._usage_for_event(result, seen) is None
    assert adapter._final_cost_for_event(result) == 0.123


def test_workflow_run_review_and_cost(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "demo"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Implement", "type": "implement"},
        ).json()

        output_port = next(port for port in process["ports"] if port["direction"] == "out")
        process = client.put(
            f"/api/processes/{process['id']}/config",
            json={
                "goal_md": "Produce {{artifact:%s}}" % output_port["id"],
                "ports": [
                    {
                        "id": output_port["id"],
                        "direction": "out",
                        "artifact_name": "implementation_notes",
                        "artifact_type": "file",
                        "spec_json": {},
                    }
                ],
            },
        ).json()

        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review", "failed"})
        assert run["status"] == "in_review"
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
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Reviewable", "type": "implement"},
        ).json()
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
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Ask", "type": "design"},
        ).json()
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
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Producer", "type": "implement"},
        ).json()
        output_port = next(port for port in process["ports"] if port["direction"] == "out")
        process = client.put(
            f"/api/processes/{process['id']}/config",
            json={
                "ports": [
                    {
                        "id": output_port["id"],
                        "direction": "out",
                        "artifact_name": "notes",
                        "artifact_type": "file",
                        "spec_json": {},
                    }
                ],
            },
        ).json()
        output_port = process["ports"][0]
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.app.state.store.replace_artifact_values(
            run["id"],
            [
                {
                    "port_id": output_port["id"],
                    "artifact_type": "file",
                    "file_path": "../../README.md",
                }
            ],
        )

        response = client.get(f"/api/runs/{run['id']}/artifacts/{output_port['id']}/download")
        assert response.status_code == 403


def test_submit_falls_back_to_output_name_when_id_is_changed(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "submit"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Producer", "type": "implement"},
        ).json()
        output_port = next(port for port in process["ports"] if port["direction"] == "out")
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        output_yaml = Path(run["workdir_path"]) / "output" / "output.yaml"
        output_yaml.write_text(
            yaml.safe_dump(
                {
                    "output": [
                        {
                            "id": "rewritten",
                            "name": output_port["artifact_name"],
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
        assert refreshed["artifacts"][0]["port_id"] == output_port["id"]
        assert refreshed["artifacts"][0]["text_value"] == "resolved by name"


def test_submit_rejects_terminal_run_without_reopening_review(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "terminal"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Producer", "type": "implement"},
        ).json()
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.app.state.store.update_run(run["id"], status="failed")

        response = client.post(f"/api/runs/{run['id']}/submit", json={}, headers=AUTH)
        assert response.status_code == 409
        refreshed = client.get(f"/api/runs/{run['id']}").json()
        assert refreshed["status"] == "failed"


def test_review_and_resume_reject_review_terminal_states(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "terminal-review"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Review", "type": "implement"},
        ).json()
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
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Resume", "type": "implement"},
        ).json()
        run = client.post(f"/api/processes/{process['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})

        in_review_resume = client.post(f"/api/runs/{run['id']}/resume", json={"feedback_text": "retry"})
        assert in_review_resume.status_code == 409

        client.app.state.store.update_run(run["id"], status="failed")
        child = client.post(f"/api/runs/{run['id']}/resume", json={"feedback_text": "retry"}).json()
        assert child["parent_run_id"] == run["id"]
        child = wait_for_status(client, child["id"], {"in_review", "failed"})
        assert child["status"] == "in_review"


def test_approved_upstream_artifact_is_injected(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "pipeline"}).json()
        producer = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Producer", "type": "design", "pos_x": 50, "pos_y": 80},
        ).json()
        consumer = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Consumer", "type": "implement", "pos_x": 420, "pos_y": 80},
        ).json()
        producer_out = next(port for port in producer["ports"] if port["direction"] == "out")
        consumer_in = next(port for port in consumer["ports"] if port["direction"] == "in")

        run = client.post(f"/api/processes/{producer['id']}/run").json()
        run = wait_for_status(client, run["id"], {"in_review"})
        client.post(f"/api/runs/{run['id']}/review", json={"action": "approve"})

        edge = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": producer["id"],
                "from_port_id": producer_out["id"],
                "to_process_id": consumer["id"],
                "to_port_id": consumer_in["id"],
            },
        )
        assert edge.status_code == 200

        consumer_run = client.post(f"/api/processes/{consumer['id']}/run").json()
        consumer_run = wait_for_status(client, consumer_run["id"], {"in_review"})
        input_yaml = Path(consumer_run["workdir_path"]) / "input" / "input.yaml"
        data = yaml.safe_load(input_yaml.read_text(encoding="utf-8"))
        assert data["input"][0]["text"].startswith("Generated by the local mock adapter")


def test_edges_reject_self_loop_duplicate_input_and_cycles(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "edges"}).json()
        first = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "First", "type": "design"},
        ).json()
        second = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Second", "type": "implement"},
        ).json()
        third = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Third", "type": "evaluate"},
        ).json()

        first_in = next(port for port in first["ports"] if port["direction"] == "in")
        first_out = next(port for port in first["ports"] if port["direction"] == "out")
        second_in = next(port for port in second["ports"] if port["direction"] == "in")
        second_out = next(port for port in second["ports"] if port["direction"] == "out")
        third_in = next(port for port in third["ports"] if port["direction"] == "in")
        third_out = next(port for port in third["ports"] if port["direction"] == "out")

        self_loop = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": first["id"],
                "from_port_id": first_out["id"],
                "to_process_id": first["id"],
                "to_port_id": first_in["id"],
            },
        )
        assert self_loop.status_code == 422

        first_to_second = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": first["id"],
                "from_port_id": first_out["id"],
                "to_process_id": second["id"],
                "to_port_id": second_in["id"],
            },
        )
        assert first_to_second.status_code == 200

        duplicate_input = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": third["id"],
                "from_port_id": third_out["id"],
                "to_process_id": second["id"],
                "to_port_id": second_in["id"],
            },
        )
        assert duplicate_input.status_code == 422

        second_to_third = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": second["id"],
                "from_port_id": second_out["id"],
                "to_process_id": third["id"],
                "to_port_id": third_in["id"],
            },
        )
        assert second_to_third.status_code == 200

        cycle = client.post(
            f"/api/workflows/{workflow['id']}/edges",
            json={
                "from_process_id": third["id"],
                "from_port_id": third_out["id"],
                "to_process_id": first["id"],
                "to_port_id": first_in["id"],
            },
        )
        assert cycle.status_code == 422


def test_edges_reject_cross_workflow_and_mismatched_ports(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow_a = client.post("/api/workflows", json={"name": "a"}).json()
        workflow_b = client.post("/api/workflows", json={"name": "b"}).json()
        first = client.post(
            f"/api/workflows/{workflow_a['id']}/processes",
            json={"name": "First", "type": "design"},
        ).json()
        second = client.post(
            f"/api/workflows/{workflow_a['id']}/processes",
            json={"name": "Second", "type": "implement"},
        ).json()
        external = client.post(
            f"/api/workflows/{workflow_b['id']}/processes",
            json={"name": "External", "type": "evaluate"},
        ).json()

        first_out = next(port for port in first["ports"] if port["direction"] == "out")
        second_in = next(port for port in second["ports"] if port["direction"] == "in")
        second_out = next(port for port in second["ports"] if port["direction"] == "out")
        external_in = next(port for port in external["ports"] if port["direction"] == "in")

        cross_workflow = client.post(
            f"/api/workflows/{workflow_a['id']}/edges",
            json={
                "from_process_id": first["id"],
                "from_port_id": first_out["id"],
                "to_process_id": external["id"],
                "to_port_id": external_in["id"],
            },
        )
        assert cross_workflow.status_code == 422

        mismatched_port = client.post(
            f"/api/workflows/{workflow_a['id']}/edges",
            json={
                "from_process_id": first["id"],
                "from_port_id": second_out["id"],
                "to_process_id": second["id"],
                "to_port_id": second_in["id"],
            },
        )
        assert mismatched_port.status_code == 422


def test_qa_answer_flow(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        workflow = client.post("/api/workflows", json={"name": "qa"}).json()
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Ask", "type": "design"},
        ).json()
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
        process = client.post(
            f"/api/workflows/{workflow['id']}/processes",
            json={"name": "Ask", "type": "design"},
        ).json()
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
