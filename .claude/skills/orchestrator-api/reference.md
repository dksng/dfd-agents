# Orchestrator API — full reference

Base URL: `$ORCH_API_BASE` (default `http://127.0.0.1:8002`). All paths below are under it.
Send `content-type: application/json`, `x-orch-client: <your id>`, and (if the server
requires it) `authorization: Bearer $ORCH_TOKEN`. The `x-orch-client` and token are only
*required* on QA/submit endpoints when a token is configured; sending them everywhere is fine.

## Endpoint map

### Workflows
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/workflows` | — | list of workflows |
| POST | `/api/workflows` | `{name}` | workflow |
| GET | `/api/workflows/{wf}` | — | workflow with `processes`, `artifacts`, `edges` |
| PUT | `/api/workflows/{wf}` | `{name?, layout_json?}` | workflow |
| GET | `/api/workflows/{wf}/export` | — | export document (JSON, with download headers) |
| POST | `/api/workflows/import` | `{document, name?}` | workflow |
| DELETE | `/api/workflows/{wf}` | — | `{ok:true}` |
| GET | `/api/workflows/{wf}/cost` | — | `{input_tokens, output_tokens, cost_usd}` |

### Processes (工程)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/workflows/{wf}/processes` | `ProcessCreate` | process |
| PUT | `/api/processes/{pid}/config` | `ProcessConfigUpdate` (partial) | process |
| DELETE | `/api/processes/{pid}` | — | `{ok:true}` |
| POST | `/api/processes/{pid}/run` | — | run object |

### Artifacts (成果物)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/workflows/{wf}/artifacts` | `ArtifactCreate` | artifact |
| PUT | `/api/artifacts/{aid}` | `ArtifactUpdate` (partial) | artifact |
| DELETE | `/api/artifacts/{aid}` | — | `{ok:true}` |
| POST | `/api/artifacts/{aid}/source-file?filename=NAME` | raw bytes (`content-type: application/octet-stream`) | artifact |

### Edges
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/workflows/{wf}/edges` | `{kind, process_id, artifact_id}` | edge |
| DELETE | `/api/edges/{eid}` | — | `{ok:true}` |

### Runs
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/runs/{run}` | — | run with `status`, `artifacts`, `qa`, `logs`, `workdir_path` |
| POST | `/api/runs/{run}/qa?wait=true&timeout_seconds=N` | `{question_text}` | qa (the agent asks; usually not you) |
| POST | `/api/qa/{qa}/answer` | `{answer_text}` | qa (you answer a waiting run) |
| POST | `/api/runs/{run}/submit` | `{note?}` | run (force-submit a running run to review) |
| POST | `/api/runs/{run}/review` | `{action, feedback_text?}` | run |
| POST | `/api/runs/{run}/resume` | `{feedback_text}` | run (restart a rejected run) |
| GET | `/api/runs/{run}/artifacts/{aid}/download` | — | file bytes |
| GET | `/api/runs/{run}/cost` | — | cost summary |

### System
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | adapter status + defaults |
| GET | `/api/settings` | skill_repos, notify_events, notify_enabled |
| PUT | `/api/settings` | update the above |
| GET | `/api/skills?refresh=false` | `{skills:[...], errors:[...]}` available skills (local + git) |
| GET | `/api/templates/{template_id}/agents-base` | base AGENTS.md for a template |
| GET | `/api/attention` | per-workflow counts: `{workflow_id, waiting_qa, in_review, failed}` |

OpenAPI is live at `/openapi.json` and Swagger UI at `/docs` — generate a typed client from there if you prefer.

## Request bodies

### ProcessCreate
```json
{ "name": "New Process", "type": "implement", "pos_x": 120, "pos_y": 120 }
```

### ProcessConfigUpdate (all fields optional; send only what you change)
| Field | Type / allowed values | Notes |
|---|---|---|
| `name` | string | display name |
| `type` | string label, e.g. `design` `implement` `review` `evaluate` | a hint/label; drives default goal template & display, not hard behavior |
| `agent_kind` | string | which agent backend (e.g. `claude`); defaults to server adapter |
| `agent_model` | string, e.g. `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` | empty = adapter default |
| `agent_effort` | `low` `medium` `high` `xhigh` `max` | reasoning effort |
| `permission_mode` | `""` `default` `acceptEdits` `bypassPermissions` `plan` `dontAsk` `auto` | `""` inherits global default |
| `allowed_tools` | string | comma list, Claude `--allowedTools` syntax, e.g. `Read,Edit,Bash(git *)`; empty inherits default |
| `disallowed_tools` | string | comma list `--disallowedTools` |
| `goal_md` | markdown | **the instruction the agent works to** — the most important field |
| `template_id` | string | AGENTS.md template id (default `base`) |
| `agents_md_append` | markdown | appended to the rendered AGENTS.md for this process |
| `execution_mode` | string | reserved |
| `pos_x`, `pos_y` | number | canvas position |
| `skills` | `[SkillSelection]` | skills to load (see below) |

### SkillSelection
```json
{ "skill_name": "docx", "skill_source": "local", "skill_ref": "docx" }
```
`skill_source` is `local` or `git`. For `git`, `skill_ref` is the repo ref. List candidates with `GET /api/skills`.

### ArtifactCreate / ArtifactUpdate
```json
{ "name": "result", "type": "text", "source_text": null, "source_url": null,
  "source_file_path": null, "spec_json": {}, "pos_x": 360, "pos_y": 160 }
```
`type` ∈ `file` `url` `text`. For an **input** artifact you can set `source_text` / `source_url`,
or upload bytes via the `source-file` endpoint (file type only). A **produced** artifact (it has
a `produces` edge) cannot take a source upload.

### Edge
```json
{ "kind": "produces", "process_id": "proc_...", "artifact_id": "art_..." }
```
`kind` ∈ `produces` (process → artifact) | `consumes` (artifact → process).
Rejected (422) if: artifact already has a producer (`produces`), edge already exists, or the
edge would create a cycle.

### Review / Resume / QA-answer
```json
// review
{ "action": "approve" }
{ "action": "reject", "feedback_text": "Fix the failing test." }
// resume (after reject)
{ "feedback_text": "Address the review and resubmit." }
// answer a waiting_qa run
{ "answer_text": "Use the main branch." }
```

## Run object (shape you read)

```jsonc
{
  "id": "run_...",
  "process_id": "proc_...",
  "status": "running|waiting_qa|in_review|approved|rejected|failed|draft",
  "workdir_path": "/.../runs/run_...",
  "artifacts": [ { "artifact_id": "...", "artifact_type": "text|url|file",
                   "value": "...", "file_path": "result.md" } ],
  "qa": [ { "id": "qa_...", "question_text": "...", "answer_text": null,
            "status": "pending|answered|timed_out" } ],
  "logs": [ ... ]
}
```

## WebSocket events

Connect (no auth handshake needed beyond the URL):
- `ws(s)://HOST/ws/runs/{run_id}` — one run.
- `ws(s)://HOST/ws/events` — all runs + all graph changes.

Event JSON:
```jsonc
// run progress
{ "type": "status", "run_id": "...", "process_id": "...", "workflow_id": "...",
  "payload": { "status": "in_review" } }
// agent asked a question
{ "type": "qa", "run_id": "...", "payload": { "qa_id": "...", "question_text": "..." } }
// structure changed (you or someone else edited the graph)
{ "type": "graph", "action": "process.create", "workflow_id": "...",
  "origin": "agent-claude", "payload": { "process_id": "..." } }
```
`action` ∈ `workflow.{create,update,import,delete}`, `process.{create,delete,config}`,
`artifact.{create,update,delete}`, `edge.{create,delete}`. **Ignore events whose `origin`
equals your own `x-orch-client` id** — that's the echo of your own change.

## Export / import document

`GET /api/workflows/{wf}/export` returns a self-contained JSON document (`{workflow, processes,
artifacts, edges, ...}`). Feed it back verbatim as `{"document": <that>, "name": "optional new name"}`
to `POST /api/workflows/import` to clone a workflow. This is the easiest way to template a
pipeline: build once, export, then import + tweak per job.
