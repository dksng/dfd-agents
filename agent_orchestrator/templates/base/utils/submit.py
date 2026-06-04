#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.request


def main() -> None:
    api_base = os.environ["ORCH_API_BASE"].rstrip("/")
    run_id = os.environ["ORCH_RUN_ID"]
    token = os.environ.get("ORCH_TOKEN", "")
    body = json.dumps({}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base}/api/runs/{run_id}/submit",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        print(response.read().decode("utf-8"))


if __name__ == "__main__":
    main()
