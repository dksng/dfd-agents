from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .api import create_app
from .config import load_settings


def api_base_for(host: str, port: int) -> str:
    """URL agent subprocesses use to call back into this server."""
    client_host = "127.0.0.1" if host in {"", "0.0.0.0", "::"} else host
    if ":" in client_host and not client_host.startswith("["):
        client_host = f"[{client_host}]"
    return f"http://{client_host}:{port}"


def main() -> None:
    parser = argparse.ArgumentParser(prog="agent-orch")
    subparsers = parser.add_subparsers(dest="command")
    serve = subparsers.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--config-root", type=Path)
    serve.add_argument("--data-root", type=Path)
    args = parser.parse_args()

    if args.command in {None, "serve"}:
        settings = load_settings()
        if getattr(args, "config_root", None):
            settings.config_root = args.config_root
        if getattr(args, "data_root", None):
            settings.data_root = args.data_root
        if not os.getenv("ORCH_API_BASE"):
            # Keep utils/question.py and utils/submit.py pointed at the actual
            # serve port instead of the :8000 default.
            settings.api_base = api_base_for(args.host, args.port)
        settings.ensure_dirs()
        uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
