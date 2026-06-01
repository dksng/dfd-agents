#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    api_base = os.environ["ORCH_API_BASE"].rstrip("/")
    run_id = os.environ["ORCH_RUN_ID"]
    token = os.environ.get("ORCH_TOKEN", "")
    qa_timeout = int(os.environ.get("ORCH_QA_TIMEOUT_SECONDS", "3600"))
    question = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
    if not question:
        raise SystemExit("question text is required")

    body = json.dumps({"question_text": question}).encode("utf-8")
    query = urllib.parse.urlencode({"timeout_seconds": qa_timeout})
    request = urllib.request.Request(
        f"{api_base}/api/runs/{run_id}/qa?{query}",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=qa_timeout + 15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"question failed: HTTP {exc.code} {detail}", file=sys.stderr)
        raise SystemExit(1) from exc
    except TimeoutError as exc:
        print(f"question failed: timed out after {qa_timeout + 15} seconds", file=sys.stderr)
        raise SystemExit(1) from exc
    answer = payload.get("answer_text") or ""
    print(answer)


if __name__ == "__main__":
    main()
