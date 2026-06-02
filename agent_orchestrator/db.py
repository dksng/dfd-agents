from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _json_dump(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"))


def _json_load(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workflow (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    layout_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS process (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    agent_kind TEXT NOT NULL DEFAULT 'claude',
    agent_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    agent_effort TEXT NOT NULL DEFAULT 'medium',
    goal_md TEXT NOT NULL DEFAULT '',
    template_id TEXT NOT NULL DEFAULT 'base',
    agents_md_append TEXT NOT NULL DEFAULT '',
    pos_x REAL NOT NULL DEFAULT 120,
    pos_y REAL NOT NULL DEFAULT 120,
    execution_mode TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS artifact (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file','url','text')),
    pos_x REAL NOT NULL DEFAULT 360,
    pos_y REAL NOT NULL DEFAULT 160,
    source_text TEXT,
    source_url TEXT,
    source_file_path TEXT,
    spec_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS process_skill (
    process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    skill_source TEXT NOT NULL CHECK(skill_source IN ('local','git')),
    skill_ref TEXT NOT NULL,
    PRIMARY KEY (process_id, skill_name, skill_source, skill_ref)
);

CREATE TABLE IF NOT EXISTS edge (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('produces','consumes')),
    process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    parent_run_id TEXT REFERENCES run(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    input_snapshot_json TEXT NOT NULL DEFAULT '{}',
    output_snapshot_json TEXT NOT NULL DEFAULT '{}',
    workdir_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_token_usage (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_log (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS qa (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    answer_text TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    answered_at TEXT
);

CREATE TABLE IF NOT EXISTS review (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    feedback_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS artifact_value (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL CHECK(artifact_type IN ('file','url','text')),
    file_path TEXT,
    url TEXT,
    text_value TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_unique_producer
ON edge(workflow_id, artifact_id)
WHERE kind = 'produces';

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_unique_consumer
ON edge(process_id, artifact_id, kind)
WHERE kind = 'consumes';
"""


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init(self) -> None:
        with self.connect() as conn:
            if self._schema_needs_reset(conn):
                self._reset_schema(conn)
            conn.executescript(SCHEMA)
            self._apply_additive_migrations(conn)
            conn.execute("PRAGMA user_version = 2")

    def _apply_additive_migrations(self, conn: sqlite3.Connection) -> None:
        """Add new nullable/defaulted columns to existing tables without a full reset."""
        if "agent_effort" not in self._table_columns(conn, "process"):
            conn.execute("ALTER TABLE process ADD COLUMN agent_effort TEXT NOT NULL DEFAULT 'medium'")

    def _table_columns(self, conn: sqlite3.Connection, table: str) -> set[str]:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    def _table_exists(self, conn: sqlite3.Connection, table: str) -> bool:
        row = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
        return row is not None

    def _schema_needs_reset(self, conn: sqlite3.Connection) -> bool:
        if not self._table_exists(conn, "workflow"):
            return False
        if self._table_exists(conn, "artifact_port"):
            return True
        if self._table_exists(conn, "edge") and "kind" not in self._table_columns(conn, "edge"):
            return True
        if self._table_exists(conn, "artifact_value") and "artifact_id" not in self._table_columns(conn, "artifact_value"):
            return True
        if not self._table_exists(conn, "artifact"):
            return True
        return False

    def _reset_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute("PRAGMA foreign_keys = OFF")
        for table in [
            "artifact_value",
            "review",
            "qa",
            "run_token_usage",
            "run_log",
            "run",
            "edge",
            "process_skill",
            "artifact_port",
            "artifact",
            "process",
            "workflow",
        ]:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.execute("PRAGMA foreign_keys = ON")

    def _fetchone(self, conn: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def _fetchall(self, conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def create_workflow(self, name: str) -> dict[str, Any]:
        workflow_id = new_id("wf")
        ts = now_iso()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO workflow(id, name, created_at, updated_at, layout_json) VALUES (?, ?, ?, ?, ?)",
                (workflow_id, name, ts, ts, "{}"),
            )
        return self.get_workflow(workflow_id)

    def list_workflows(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = self._fetchall(conn, "SELECT * FROM workflow ORDER BY updated_at DESC")
        for row in rows:
            row["layout_json"] = _json_load(row.get("layout_json"), {})
        return rows

    def update_workflow(self, workflow_id: str, *, name: str | None = None, layout_json: dict[str, Any] | None = None) -> dict[str, Any]:
        assignments: list[str] = ["updated_at = ?"]
        params: list[Any] = [now_iso()]
        if name is not None:
            assignments.append("name = ?")
            params.append(name)
        if layout_json is not None:
            assignments.append("layout_json = ?")
            params.append(_json_dump(layout_json))
        params.append(workflow_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE workflow SET {', '.join(assignments)} WHERE id = ?", tuple(params))
        return self.get_workflow(workflow_id)

    def get_workflow(self, workflow_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            workflow = self._fetchone(conn, "SELECT * FROM workflow WHERE id = ?", (workflow_id,))
            if not workflow:
                raise KeyError(f"Workflow not found: {workflow_id}")
            processes = self._fetchall(conn, "SELECT * FROM process WHERE workflow_id = ? ORDER BY rowid", (workflow_id,))
            process_ids = [process["id"] for process in processes]
            skills: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            runs: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            if process_ids:
                placeholders = ",".join("?" for _ in process_ids)
                for skill in self._fetchall(conn, f"SELECT * FROM process_skill WHERE process_id IN ({placeholders}) ORDER BY skill_name", tuple(process_ids)):
                    skills.setdefault(skill["process_id"], []).append(skill)
                for run in self._fetchall(
                    conn,
                    f"SELECT * FROM run WHERE process_id IN ({placeholders}) ORDER BY started_at DESC",
                    tuple(process_ids),
                ):
                    run["input_snapshot_json"] = _json_load(run.get("input_snapshot_json"), {})
                    run["output_snapshot_json"] = _json_load(run.get("output_snapshot_json"), {})
                    runs.setdefault(run["process_id"], []).append(run)
            artifacts = self._fetchall(conn, "SELECT * FROM artifact WHERE workflow_id = ? ORDER BY rowid", (workflow_id,))
            for artifact in artifacts:
                artifact["spec_json"] = _json_load(artifact.get("spec_json"), {})
            edges = self._fetchall(conn, "SELECT * FROM edge WHERE workflow_id = ? ORDER BY rowid", (workflow_id,))
        workflow["layout_json"] = _json_load(workflow.get("layout_json"), {})
        for process in processes:
            process["skills"] = skills.get(process["id"], [])
            process["runs"] = runs.get(process["id"], [])
        workflow["processes"] = processes
        workflow["artifacts"] = artifacts
        workflow["edges"] = edges
        return workflow

    def get_process(self, process_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (process_id,))
            if not process:
                raise KeyError(f"Process not found: {process_id}")
            skills = self._fetchall(conn, "SELECT * FROM process_skill WHERE process_id = ? ORDER BY skill_name", (process_id,))
        process["skills"] = skills
        return process

    def create_process(self, workflow_id: str, data: dict[str, Any]) -> dict[str, Any]:
        process_id = new_id("proc")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO process(id, workflow_id, name, type, pos_x, pos_y)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    process_id,
                    workflow_id,
                    data.get("name", "New Process"),
                    data.get("type", "implement"),
                    data.get("pos_x", 120),
                    data.get("pos_y", 120),
                ),
            )
        return self.get_process(process_id)

    def delete_process(self, process_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM process WHERE id = ?", (process_id,))

    def create_artifact(self, workflow_id: str, data: dict[str, Any]) -> dict[str, Any]:
        artifact_id = new_id("artifact")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO artifact(
                    id, workflow_id, name, type, pos_x, pos_y,
                    source_text, source_url, source_file_path, spec_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    workflow_id,
                    data.get("name", "New Artifact"),
                    data.get("type", "text"),
                    data.get("pos_x", 360),
                    data.get("pos_y", 160),
                    data.get("source_text"),
                    data.get("source_url"),
                    data.get("source_file_path"),
                    _json_dump(data.get("spec_json", {})),
                ),
            )
        return self.get_artifact(artifact_id)

    def get_artifact(self, artifact_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            artifact = self._fetchone(conn, "SELECT * FROM artifact WHERE id = ?", (artifact_id,))
        if not artifact:
            raise KeyError(f"Artifact not found: {artifact_id}")
        artifact["spec_json"] = _json_load(artifact.get("spec_json"), {})
        return artifact

    def update_artifact(self, artifact_id: str, data: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name",
            "type",
            "pos_x",
            "pos_y",
            "source_text",
            "source_url",
            "source_file_path",
            "spec_json",
        }
        updates = {key: value for key, value in data.items() if key in allowed}
        if "spec_json" in updates:
            updates["spec_json"] = _json_dump(updates["spec_json"] or {})
        if updates:
            assignments = ", ".join(f"{key} = ?" for key in updates)
            with self.connect() as conn:
                conn.execute(f"UPDATE artifact SET {assignments} WHERE id = ?", (*updates.values(), artifact_id))
        return self.get_artifact(artifact_id)

    def delete_artifact(self, artifact_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM artifact WHERE id = ?", (artifact_id,))

    def update_process_config(self, process_id: str, data: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name",
            "type",
            "agent_kind",
            "agent_model",
            "agent_effort",
            "goal_md",
            "template_id",
            "agents_md_append",
            "pos_x",
            "pos_y",
            "execution_mode",
        }
        updates = {key: value for key, value in data.items() if key in allowed and value is not None}
        with self.connect() as conn:
            if updates:
                assignments = ", ".join(f"{key} = ?" for key in updates)
                conn.execute(f"UPDATE process SET {assignments} WHERE id = ?", (*updates.values(), process_id))
            if data.get("skills") is not None:
                conn.execute("DELETE FROM process_skill WHERE process_id = ?", (process_id,))
                for skill in data["skills"]:
                    conn.execute(
                        """
                        INSERT INTO process_skill(process_id, skill_name, skill_source, skill_ref)
                        VALUES (?, ?, ?, ?)
                        """,
                        (process_id, skill["skill_name"], skill["skill_source"], skill["skill_ref"]),
                    )
        return self.get_process(process_id)

    def create_edge(self, workflow_id: str, data: dict[str, Any]) -> dict[str, Any]:
        edge_id = new_id("edge")
        with self.connect() as conn:
            kind = data["kind"]
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (data["process_id"],))
            artifact = self._fetchone(conn, "SELECT * FROM artifact WHERE id = ?", (data["artifact_id"],))
            if not process or not artifact:
                raise ValueError("Process and artifact must exist")
            if process["workflow_id"] != workflow_id or artifact["workflow_id"] != workflow_id:
                raise ValueError("Edges can only connect nodes in the same workflow")
            existing = self._fetchone(
                conn,
                "SELECT * FROM edge WHERE workflow_id = ? AND kind = ? AND process_id = ? AND artifact_id = ?",
                (workflow_id, kind, data["process_id"], data["artifact_id"]),
            )
            if existing:
                raise ValueError("Edge already exists")
            if kind == "produces":
                producer = self._fetchone(
                    conn,
                    "SELECT * FROM edge WHERE workflow_id = ? AND kind = 'produces' AND artifact_id = ?",
                    (workflow_id, data["artifact_id"]),
                )
                if producer:
                    raise ValueError("Artifact already has a producer")
            if self._would_create_cycle(conn, workflow_id, kind, data["process_id"], data["artifact_id"]):
                raise ValueError("Edge would create a workflow cycle")
            conn.execute(
                """
                INSERT INTO edge(id, workflow_id, kind, process_id, artifact_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (edge_id, workflow_id, kind, data["process_id"], data["artifact_id"]),
            )
            edge = self._fetchone(conn, "SELECT * FROM edge WHERE id = ?", (edge_id,))
        return edge

    def _would_create_cycle(
        self,
        conn: sqlite3.Connection,
        workflow_id: str,
        kind: str,
        process_id: str,
        artifact_id: str,
    ) -> bool:
        edges = self._fetchall(conn, "SELECT kind, process_id, artifact_id FROM edge WHERE workflow_id = ?", (workflow_id,))
        edges.append({"kind": kind, "process_id": process_id, "artifact_id": artifact_id})
        producers: dict[str, str] = {}
        consumers: dict[str, list[str]] = {}
        for edge in edges:
            if edge["kind"] == "produces":
                producers[edge["artifact_id"]] = edge["process_id"]
            else:
                consumers.setdefault(edge["artifact_id"], []).append(edge["process_id"])

        adjacency: dict[str, list[str]] = {}
        for artifact, producer in producers.items():
            for consumer in consumers.get(artifact, []):
                adjacency.setdefault(producer, []).append(consumer)

        visited: set[str] = set()
        active: set[str] = set()

        def visit(process: str) -> bool:
            if process in active:
                return True
            if process in visited:
                return False
            visited.add(process)
            active.add(process)
            for next_process in adjacency.get(process, []):
                if visit(next_process):
                    return True
            active.remove(process)
            return False

        for process in list(adjacency):
            if visit(process):
                return True
        return False

    def delete_edge(self, edge_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM edge WHERE id = ?", (edge_id,))

    def create_run(
        self,
        process_id: str,
        *,
        status: str,
        workdir_path: str,
        parent_run_id: str | None = None,
        session_id: str | None = None,
        input_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        run_id = new_id("run")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO run(
                    id, process_id, parent_run_id, status, session_id, started_at,
                    input_snapshot_json, output_snapshot_json, workdir_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    process_id,
                    parent_run_id,
                    status,
                    session_id,
                    now_iso(),
                    _json_dump(input_snapshot or {}),
                    "{}",
                    workdir_path,
                ),
            )
        return self.get_run(run_id)

    def update_run(self, run_id: str, **updates: Any) -> dict[str, Any]:
        if "input_snapshot_json" in updates:
            updates["input_snapshot_json"] = _json_dump(updates["input_snapshot_json"])
        if "output_snapshot_json" in updates:
            updates["output_snapshot_json"] = _json_dump(updates["output_snapshot_json"])
        if updates.get("status") in {"approved", "failed", "in_review", "rejected"} and "ended_at" not in updates:
            updates["ended_at"] = now_iso()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self.connect() as conn:
            conn.execute(f"UPDATE run SET {assignments} WHERE id = ?", (*updates.values(), run_id))
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            run = self._fetchone(conn, "SELECT * FROM run WHERE id = ?", (run_id,))
            if not run:
                raise KeyError(f"Run not found: {run_id}")
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (run["process_id"],))
            logs = self._fetchall(conn, "SELECT * FROM run_log WHERE run_id = ? ORDER BY ts, rowid", (run_id,))
            usage = self._fetchall(conn, "SELECT * FROM run_token_usage WHERE run_id = ? ORDER BY ts, rowid", (run_id,))
            qas = self._fetchall(conn, "SELECT * FROM qa WHERE run_id = ? ORDER BY created_at", (run_id,))
            reviews = self._fetchall(conn, "SELECT * FROM review WHERE run_id = ? ORDER BY created_at", (run_id,))
            artifacts = self._fetchall(conn, "SELECT * FROM artifact_value WHERE run_id = ? ORDER BY rowid", (run_id,))
        run["input_snapshot_json"] = _json_load(run.get("input_snapshot_json"), {})
        run["output_snapshot_json"] = _json_load(run.get("output_snapshot_json"), {})
        run["process"] = process
        run["logs"] = logs
        run["token_usage"] = usage
        run["qa"] = qas
        run["reviews"] = reviews
        run["artifacts"] = artifacts
        return run

    def latest_approved_run(self, process_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            run = self._fetchone(
                conn,
                """
                SELECT * FROM run
                WHERE process_id = ? AND status = 'approved'
                ORDER BY started_at DESC, rowid DESC
                LIMIT 1
                """,
                (process_id,),
            )
        if not run:
            return None
        return self.get_run(run["id"])

    def get_edges_for_process(self, process_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        process = self.get_process(process_id)
        params: list[Any] = [process["workflow_id"], process_id]
        kind_clause = ""
        if kind is not None:
            kind_clause = " AND kind = ?"
            params.append(kind)
        with self.connect() as conn:
            return self._fetchall(
                conn,
                f"SELECT * FROM edge WHERE workflow_id = ? AND process_id = ?{kind_clause} ORDER BY rowid",
                tuple(params),
            )

    def get_edges_for_artifact(self, artifact_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        artifact = self.get_artifact(artifact_id)
        params: list[Any] = [artifact["workflow_id"], artifact_id]
        kind_clause = ""
        if kind is not None:
            kind_clause = " AND kind = ?"
            params.append(kind)
        with self.connect() as conn:
            return self._fetchall(
                conn,
                f"SELECT * FROM edge WHERE workflow_id = ? AND artifact_id = ?{kind_clause} ORDER BY rowid",
                tuple(params),
            )

    def add_log(self, run_id: str, level: str, message: str, raw_json: dict[str, Any] | None = None) -> dict[str, Any]:
        log_id = new_id("log")
        row = {
            "id": log_id,
            "run_id": run_id,
            "ts": now_iso(),
            "level": level,
            "message": message,
            "raw_json": _json_dump(raw_json or {}),
        }
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO run_log(id, run_id, ts, level, message, raw_json) VALUES (?, ?, ?, ?, ?, ?)",
                tuple(row.values()),
            )
        row["raw_json"] = raw_json or {}
        return row

    def add_usage(
        self,
        run_id: str,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_read: int,
        cache_write: int,
        cost_usd: float,
        model: str,
    ) -> dict[str, Any]:
        usage_id = new_id("usage")
        row = {
            "id": usage_id,
            "run_id": run_id,
            "ts": now_iso(),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cost_usd": cost_usd,
            "model": model,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO run_token_usage(
                    id, run_id, ts, input_tokens, output_tokens, cache_read, cache_write, cost_usd, model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(row.values()),
            )
        return row

    def create_qa(self, run_id: str, question_text: str) -> dict[str, Any]:
        qa_id = new_id("qa")
        row = {
            "id": qa_id,
            "run_id": run_id,
            "question_text": question_text,
            "answer_text": None,
            "status": "pending",
            "created_at": now_iso(),
            "answered_at": None,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO qa(id, run_id, question_text, answer_text, status, created_at, answered_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(row.values()),
            )
        return row

    def answer_qa(self, qa_id: str, answer_text: str) -> dict[str, Any]:
        with self.connect() as conn:
            existing = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
            if not existing:
                raise KeyError(f"QA not found: {qa_id}")
            if existing["status"] != "pending":
                raise ValueError(f"QA is not pending: {existing['status']}")
            conn.execute(
                "UPDATE qa SET answer_text = ?, status = 'answered', answered_at = ? WHERE id = ?",
                (answer_text, now_iso(), qa_id),
            )
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise KeyError(f"QA not found: {qa_id}")
        return qa

    def timeout_qa(self, qa_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            cursor = conn.execute(
                "UPDATE qa SET status = 'timed_out', answered_at = ? WHERE id = ? AND status = 'pending'",
                (now_iso(), qa_id),
            )
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise KeyError(f"QA not found: {qa_id}")
        qa["timed_out_by_this_call"] = cursor.rowcount == 1
        return qa

    def get_qa(self, qa_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise KeyError(f"QA not found: {qa_id}")
        return qa

    def replace_artifact_values(self, run_id: str, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        with self.connect() as conn:
            conn.execute("DELETE FROM artifact_value WHERE run_id = ?", (run_id,))
            for value in values:
                row = {
                    "id": new_id("av"),
                    "run_id": run_id,
                    "artifact_id": value["artifact_id"],
                    "artifact_type": value["artifact_type"],
                    "file_path": value.get("file_path"),
                    "url": value.get("url"),
                    "text_value": value.get("text_value"),
                }
                conn.execute(
                    """
                    INSERT INTO artifact_value(id, run_id, artifact_id, artifact_type, file_path, url, text_value)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    tuple(row.values()),
                )
                rows.append(row)
        return rows

    def create_review(self, run_id: str) -> dict[str, Any]:
        review_id = new_id("review")
        row = {
            "id": review_id,
            "run_id": run_id,
            "status": "pending",
            "feedback_text": "",
            "created_at": now_iso(),
            "resolved_at": None,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO review(id, run_id, status, feedback_text, created_at, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                tuple(row.values()),
            )
        return row

    def resolve_review(self, run_id: str, status: str, feedback_text: str) -> dict[str, Any]:
        with self.connect() as conn:
            existing = self._fetchone(
                conn,
                "SELECT * FROM review WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
                (run_id,),
            )
            if not existing:
                review = self.create_review(run_id)
                review_id = review["id"]
            else:
                review_id = existing["id"]
            conn.execute(
                "UPDATE review SET status = ?, feedback_text = ?, resolved_at = ? WHERE id = ?",
                (status, feedback_text, now_iso(), review_id),
            )
            row = self._fetchone(conn, "SELECT * FROM review WHERE id = ?", (review_id,))
        if not row:
            raise KeyError(f"Review not found for run: {run_id}")
        return row

    def run_cost(self, run_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = self._fetchone(
                conn,
                """
                SELECT
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(cache_read), 0) AS cache_read,
                    COALESCE(SUM(cache_write), 0) AS cache_write,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM run_token_usage WHERE run_id = ?
                """,
                (run_id,),
            )
        return row or {}

    def workflow_cost(self, workflow_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = self._fetchone(
                conn,
                """
                SELECT
                    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(u.cache_read), 0) AS cache_read,
                    COALESCE(SUM(u.cache_write), 0) AS cache_write,
                    COALESCE(SUM(u.cost_usd), 0) AS cost_usd
                FROM run_token_usage u
                JOIN run r ON r.id = u.run_id
                JOIN process p ON p.id = r.process_id
                WHERE p.workflow_id = ?
                """,
                (workflow_id,),
            )
        return row or {}
