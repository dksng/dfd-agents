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


def request(base_url: str, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
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


def run_smoke(base_url: str, model: str) -> dict[str, Any]:
    workflow = request(base_url, "POST", "/api/workflows", {"name": "real claude smoke"})
    process = request(
        base_url,
        "POST",
        f"/api/workflows/{workflow['id']}/processes",
        {"name": "Real Claude Smoke", "type": "implement"},
    )
    output_port = next(port for port in process["ports"] if port["direction"] == "out")
    process = request(
        base_url,
        "PUT",
        f"/api/processes/{process['id']}/config",
        {
            "agent_model": model,
            "goal_md": (
                "Do not ask questions. Complete the expected text output artifact. "
                "Set the output text value to exactly ORCH_REAL_CLAUDE_OK, preserve output.yaml ids, "
                "then run python3 utils/submit.py."
            ),
            "ports": [
                {
                    "id": output_port["id"],
                    "direction": "out",
                    "artifact_name": "smoke_result",
                    "artifact_type": "text",
                    "spec_json": {},
                }
            ],
            "agents_md_append": "This is a smoke test. Do only the minimal file edit and submit command.",
        },
    )
    run = request(base_url, "POST", f"/api/processes/{process['id']}/run")
    deadline = time.time() + 180
    while time.time() < deadline:
        current = request(base_url, "GET", f"/api/runs/{run['id']}")
        if current["status"] in {"in_review", "approved", "failed", "rejected"}:
            return current
        time.sleep(2)
    raise RuntimeError(f"run {run['id']} did not finish")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a paid real Claude Code smoke test through the orchestrator.")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--model", default="claude-opus-4-8")
    parser.add_argument("--budget-usd", default="0.25")
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
        run = run_smoke(base_url, args.model)
        artifact_text = next((item.get("text_value") for item in run["artifacts"] if item["artifact_type"] == "text"), None)
        summary = {
            "status": run["status"],
            "run_id": run["id"],
            "session_id": run.get("session_id"),
            "artifact_text": artifact_text,
            "cost_usd": sum(item["cost_usd"] for item in run.get("token_usage", [])),
        }
        print(json.dumps(summary, indent=2))
        return 0 if run["status"] == "in_review" and artifact_text == "ORCH_REAL_CLAUDE_OK" else 1
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()


if __name__ == "__main__":
    raise SystemExit(main())

