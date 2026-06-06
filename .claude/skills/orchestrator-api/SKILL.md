---
name: orchestrator-api
description: "Use this skill when an agent needs to build or operate a workflow inside this DFD agent-process orchestrator over its REST API instead of the GUI — creating workflows, adding process/artifact nodes and produces/consumes edges, configuring a process's goal/model/effort/permissions/skills, running a process, watching run progress over WebSocket, answering its QA, and approving/rejecting/resuming runs. Triggers include requests to 'build a workflow via the API', 'have the agent design the DFD', 'drive the orchestrator headless', or any programmatic create/run/review against the orchestrator backend (default http://127.0.0.1:8002). Not for editing the React GUI itself."
license: MIT
---

# Orchestrator API

Drive this DFD agent-process orchestrator programmatically. The backend (FastAPI) is the
single source of truth; the human React GUI is just one client. Every change you make over
the REST API is broadcast over a WebSocket, so the human's canvas updates **live** — you and
a person can co-edit the same workflow.

## Mental model (DFD: 工程→成果物→工程)

A **workflow** is a directed graph of two node kinds joined by typed edges:

- **process (工程)** — a unit of agent work. Has a goal, an agent model/effort, permissions, and optional skills.
- **artifact (成果物)** — a data node: `text`, `url`, or `file`.
- **edge** — `produces` (process → artifact, the process's output) or `consumes` (artifact → process, an input). One artifact has **at most one producer**; cycles are rejected.

A process runs an agent that reads its consumed artifacts + goal, does the work, and writes its produced artifacts. The run then goes to **in_review** for a human (or you) to approve/reject.

## Environment

| Var | Meaning | Default |
|-----|---------|---------|
| `ORCH_API_BASE` | Backend base URL | `http://127.0.0.1:8002` |
| `ORCH_TOKEN` | Bearer token; **only required if the server has one set** | unset |

On every request send two headers:

- `content-type: application/json`
- `x-orch-client: <a stable id for you>` — tags your changes so they don't echo back to you and so the human GUI can tell agent edits apart. Pick any string, e.g. `agent-claude`.
- If `ORCH_TOKEN` is set: `authorization: Bearer $ORCH_TOKEN`.

Confirm the server is up and which agent adapter is active before building:

```bash
curl -s "$ORCH_API_BASE/api/health"   # -> active_adapter: "claude" | "mock", default_permission_mode, default_allowed_tools
```

`mock` means runs are simulated (safe for dry runs); `claude` means real, billable agent runs.

## The standard loop

Use the helper for brevity (`scripts/orch_api.sh` wraps curl + the headers + `jq`):

```bash
export ORCH_API_BASE=http://127.0.0.1:8002
export ORCH_CLIENT=agent-claude          # your x-orch-client id
# export ORCH_TOKEN=...                   # only if the server requires it
O=.claude/skills/orchestrator-api/scripts/orch_api.sh

# 1. Create the workflow
wf=$("$O" post /api/workflows '{"name":"Pipeline built by agent"}' | jq -r .id)

# 2. Add nodes
impl=$("$O" post /api/workflows/$wf/processes '{"name":"Implement","type":"implement"}' | jq -r .id)
out=$( "$O" post /api/workflows/$wf/artifacts '{"name":"result.md","type":"file"}'        | jq -r .id)

# 3. Wire process -> artifact (produces)
"$O" post /api/workflows/$wf/edges "{\"kind\":\"produces\",\"process_id\":\"$impl\",\"artifact_id\":\"$out\"}"

# 4. Configure the process (goal is the key field)
"$O" put /api/processes/$impl/config '{
  "goal_md": "Implement X. Write the result to result.md.",
  "agent_model": "claude-opus-4-8",
  "agent_effort": "medium",
  "permission_mode": "",
  "allowed_tools": "",
  "disallowed_tools": ""
}'

# 5. Run it (returns a run object with an id)
run=$("$O" post /api/processes/$impl/run '' | jq -r .id)

# 6. Wait for it to settle, then read the run
"$O" get /api/runs/$run | jq '{status, artifacts}'
```

To feed one process's output into the next, add a `consumes` edge from the produced artifact
to the downstream process, then run the downstream process. Build the whole graph first, then
run processes in dependency order (a process should run after the artifacts it consumes exist
and their producers have been approved).

## Run lifecycle

A run's `status` moves through:

```
running ──► in_review ──►(review approve)──► approved
   │            ▲          (review reject) ──► rejected ──►(resume)──► running
   ├─► waiting_qa ─(answer)─► running
   └─► failed
```

- **in_review** — the agent finished and submitted output. Inspect `artifacts`, then `POST /api/runs/{id}/review` with `{"action":"approve"}` or `{"action":"reject","feedback_text":"..."}`.
- **waiting_qa** — the agent asked a question mid-run. Read `qa` on the run, answer it with `POST /api/qa/{qa_id}/answer {"answer_text":"..."}`; the run resumes.
- **rejected** — restart with feedback via `POST /api/runs/{id}/resume {"feedback_text":"..."}`.
- **failed** — the agent errored; inspect the run, fix config/goal, run again.

Don't busy-poll tightly. Either poll `GET /api/runs/{id}` every ~1–2s, or subscribe to events (below).

## Watching progress (WebSocket)

- `ws /ws/runs/{run_id}` — events for one run (logs, status transitions, qa).
- `ws /ws/events` — global stream across all workflows. Two event shapes:
  - run events: `{type:"status"|"qa"|..., run_id, process_id, workflow_id, payload:{status,...}}`
  - graph events (structure changed): `{type:"graph", action:"process.create"|"edge.delete"|..., workflow_id, origin, payload}` — `origin` is the `x-orch-client` of whoever made the change; ignore events where `origin` equals your own id.

Poll-based control works fine if you don't want a WS client; events are an optimization.

## Gotchas

- **One producer per artifact.** A second `produces` edge to the same artifact → 422. Cycles → 422.
- **`permission_mode: ""` inherits the global default** (see `/api/health`). For unattended runs that must not block on permission prompts, set a concrete mode (e.g. `acceptEdits` or `bypassPermissions`) and scope `allowed_tools` — but only with the user's authorization.
- **File artifacts**: an agent-produced file is downloaded via `GET /api/runs/{run_id}/artifacts/{artifact_id}/download`. To attach a *source* file to an input artifact, `POST /api/artifacts/{id}/source-file?filename=...` with the raw bytes.
- **Idempotency**: there is none. Re-POSTing creates duplicates. Track ids you create.
- **mock vs claude**: develop/validate the graph wiring under `mock` (no cost), switch the server to `claude` for real execution.

## Full reference

See `reference.md` for the complete endpoint table, every process-config field with allowed
values (models, efforts, permission modes), artifact/edge shapes, skill attachment, and the
export/import document format.
