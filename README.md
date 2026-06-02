# Agent Process Orchestrator

`docs/SPEC.md` に基づく、ローカル単一ユーザ向けの工程オーケストレーションMVPです。

## Backend

```bash
python3 -m pip install -e ".[dev]"
agent-orch serve --host 127.0.0.1 --port 8000
```

Environment variables:

- `ORCH_CONFIG_ROOT`: config directory. Defaults to `.orch/config`.
- `ORCH_DATA_ROOT`: SQLite and run workspace directory. Defaults to `.orch/data`.
- `ORCH_SKILL_REPOS`: comma-separated local paths or `owner/repo[@ref]` remote skill repositories.
- `ORCH_AGENT_MODE`: `auto`, `claude`, or `mock`. `auto` uses Claude when the command exists, otherwise the local mock adapter.
- `ORCH_CLAUDE_COMMAND`: Claude Code command. Defaults to `claude --print --verbose --output-format stream-json`.
- `ORCH_QA_TIMEOUT_SECONDS`: maximum time `utils/question.py` waits for a UI answer. Defaults to `3600`.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Test

```bash
python3 -m pytest
cd frontend
npm run build
```

## Real Claude Smoke

This smoke test invokes the real Claude Code CLI and can spend API/subscription credits.

```bash
python3 scripts/real_claude_smoke.py --port 8010 --budget-usd 0.25
python3 scripts/real_claude_smoke.py --port 8011 --budget-usd 0.35 --with-qa
```

Expected result: the run reaches `in_review`, has a `session_id`, and the text artifact is `ORCH_REAL_CLAUDE_OK`.
With `--with-qa`, the script answers the orchestrator QA callback and expects `ORCH_REAL_QA_OK`.
