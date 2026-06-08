#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def request(
    base_url: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url + path,
        data=body,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_health(base_url: str, timeout: int = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            request(base_url, "GET", "/api/health")
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError("backend did not become healthy")


def result_total_cost(run: dict[str, Any]) -> float | None:
    for log in reversed(run.get("logs", [])):
        raw = log.get("raw_json")
        try:
            raw_obj = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            continue
        if isinstance(raw_obj, dict) and raw_obj.get("type") == "result":
            return raw_obj.get("total_cost_usd")
    return None


def wait_for_result_event(base_url: str, run_id: str, timeout: int = 30) -> dict[str, Any]:
    deadline = time.time() + timeout
    last_run: dict[str, Any] | None = None
    while time.time() < deadline:
        last_run = request(base_url, "GET", f"/api/runs/{run_id}")
        if result_total_cost(last_run) is not None:
            return last_run
        time.sleep(1)
    if last_run is None:
        raise RuntimeError(f"run {run_id} could not be loaded")
    return last_run


def run_smoke(base_url: str, model: str, *, with_qa: bool, answer: str) -> dict[str, Any]:
    workflow = request(base_url, "POST", "/api/workflows", {"name": "real claude smoke"})
    process = request(
        base_url,
        "POST",
        f"/api/workflows/{workflow['id']}/processes",
        {"name": "Real Claude Smoke", "type": "implement"},
    )
    artifact = request(
        base_url,
        "POST",
        f"/api/workflows/{workflow['id']}/artifacts",
        {"name": "smoke_result", "type": "text", "pos_x": 420, "pos_y": 120},
    )
    request(
        base_url,
        "POST",
        f"/api/workflows/{workflow['id']}/edges",
        {"kind": "produces", "process_id": process["id"], "artifact_id": artifact["id"]},
    )
    goal = (
        "Do not ask questions. Complete the expected text output artifact. "
        "Set the output text value to exactly ORCH_REAL_CLAUDE_OK, preserve output.yaml ids, "
        "then run python3 utils/submit.py."
    )
    append = "This is a smoke test. Do only the minimal file edit and submit command."
    expected = "ORCH_REAL_CLAUDE_OK"
    if with_qa:
        goal = (
            "Do not use the built-in AskUserQuestion tool. First run exactly: "
            "python3 utils/question.py 'What exact token should be written to smoke_result?' . "
            "Then set the expected text output artifact to exactly the stdout answer, preserve output.yaml ids, "
            "and run python3 utils/submit.py."
        )
        append = "This is a paid smoke test. Use utils/question.py via Bash before editing output.yaml."
        expected = answer

    process = request(
        base_url,
        "PUT",
        f"/api/processes/{process['id']}/config",
        {
            "agent_model": model,
            "goal_md": goal,
            "agents_md_append": append,
        },
    )
    run = request(base_url, "POST", f"/api/processes/{process['id']}/run")
    answered = False
    deadline = time.time() + 180
    while time.time() < deadline:
        current = request(base_url, "GET", f"/api/runs/{run['id']}")
        pending = next((qa for qa in current.get("qa", []) if qa["status"] == "pending"), None)
        if with_qa and pending and not answered:
            request(base_url, "POST", f"/api/qa/{pending['id']}/answer", {"answer_text": answer})
            answered = True
        if current["status"] in {"in_review", "approved", "failed", "rejected"}:
            current["smoke_expected_text"] = expected
            current["smoke_answered_qa"] = answered
            return wait_for_result_event(base_url, run["id"])
        time.sleep(2)
    raise RuntimeError(f"run {run['id']} did not finish")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a paid real Claude Code smoke test through the orchestrator.")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--model", default="claude-opus-4-8")
    parser.add_argument("--budget-usd", default="0.25")
    parser.add_argument("--with-qa", action="store_true")
    parser.add_argument("--answer", default="ORCH_REAL_QA_OK")
    parser.add_argument("--data-root", type=Path, default=Path(".orch/real-claude-smoke/data"))
    parser.add_argument("--config-root", type=Path, default=Path(".orch/real-claude-smoke/config"))
    args = parser.parse_args()

    if shutil.which("claude") is None:
        raise SystemExit("claude CLI was not found on PATH")

    base_url = f"http://127.0.0.1:{args.port}"
    env = os.environ.copy()
    env.update(
        {
            "ORCH_CONFIG_ROOT": str(args.config_root),
            "ORCH_DATA_ROOT": str(args.data_root),
            "ORCH_API_BASE": base_url,
            "ORCH_AGENT_MODE": "claude",
            "ORCH_CLAUDE_COMMAND": (
                "claude --print --verbose --output-format stream-json "
                f"--max-budget-usd {args.budget_usd} --permission-mode bypassPermissions"
            ),
        }
    )
    server = subprocess.Popen(
        [sys.executable, "-m", "agent_orchestrator.cli", "serve", "--host", "127.0.0.1", "--port", str(args.port)],
        env=env,
    )
    try:
        wait_health(base_url)
        run = run_smoke(base_url, args.model, with_qa=args.with_qa, answer=args.answer)
        artifact_text = next(
            (item.get("text_value") for item in run["artifacts"] if item["artifact_type"] == "text"), None
        )
        cost = sum(item["cost_usd"] for item in run.get("token_usage", []))
        result_cost = result_total_cost(run)
        expected = args.answer if args.with_qa else "ORCH_REAL_CLAUDE_OK"
        summary = {
            "status": run["status"],
            "run_id": run["id"],
            "session_id": run.get("session_id"),
            "artifact_text": artifact_text,
            "cost_usd": cost,
            "result_total_cost_usd": result_cost,
            "cost_delta": None if result_cost is None else cost - result_cost,
            "qa_answered": any(qa["status"] == "answered" for qa in run.get("qa", [])),
        }
        print(json.dumps(summary, indent=2))
        ok = run["status"] == "in_review" and artifact_text == expected
        if args.with_qa:
            ok = ok and summary["qa_answered"]
        return 0 if ok else 1
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()


if __name__ == "__main__":
    raise SystemExit(main())
