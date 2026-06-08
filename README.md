# DFD-Agents

`docs/SPEC.md` に基づく、ローカル単一ユーザ向けの工程オーケストレーションMVPです。

## Quick Start

```bash
scripts/orch.sh setup
scripts/orch.sh start
```

`start` はバックエンドをバックグラウンド常駐で起動し、ビルド済みUIを同一ポートで配信します。
既定のURLは `http://127.0.0.1:8000` です。

よく使う管理コマンド:

```bash
scripts/orch.sh status
scripts/orch.sh logs -f
scripts/orch.sh stop
scripts/orch.sh doctor
```

Node.js が古い/無い環境では、ユーザ空間に Node を入れる場合だけ `setup --auto-deps` を使います。
詳細は [docs/setup-script.md](docs/setup-script.md) を参照してください。

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

## Models and Pricing

Model choices and token pricing are loaded from `pricing.yaml` under `ORCH_CONFIG_ROOT`
(`.orch/config/pricing.yaml` by default). Rates are USD per 1M tokens.

```yaml
cost_source: pricing
currency: USD
default_model: claude-sonnet-4-6
models:
  claude-sonnet-4-6:
    enabled: true
    label: Claude Sonnet 4.6
    input: 3.0
    output: 15.0
    cache_read: 0.3
    cache_write_5m: 3.75
    cache_write_1h: 6.0
```

`cost_source: pricing` keeps displayed cost based on this file. Set
`cost_source: result_total_cost` only when Claude Code's `total_cost_usd` should
override local pricing for completed runs.

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
