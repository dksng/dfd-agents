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
    goal_md TEXT NOT NULL DEFAULT '',
    template_id TEXT NOT NULL DEFAULT 'base',
    agents_md_append TEXT NOT NULL DEFAULT '',
    pos_x REAL NOT NULL DEFAULT 120,
    pos_y REAL NOT NULL DEFAULT 120,
    execution_mode TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS artifact_port (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    artifact_name TEXT NOT NULL,
    artifact_type TEXT NOT NULL CHECK(artifact_type IN ('file','url','text')),
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
    from_process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    from_port_id TEXT NOT NULL REFERENCES artifact_port(id) ON DELETE CASCADE,
    to_process_id TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    to_port_id TEXT NOT NULL REFERENCES artifact_port(id) ON DELETE CASCADE
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
    port_id TEXT NOT NULL REFERENCES artifact_port(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL CHECK(artifact_type IN ('file','url','text')),
    file_path TEXT,
    url TEXT,
    text_value TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_unique_input
ON edge(workflow_id, to_port_id);
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
            conn.executescript(SCHEMA)

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
            ports: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            skills: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            runs: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            if process_ids:
                placeholders = ",".join("?" for _ in process_ids)
                for port in self._fetchall(conn, f"SELECT * FROM artifact_port WHERE process_id IN ({placeholders}) ORDER BY rowid", tuple(process_ids)):
                    port["spec_json"] = _json_load(port.get("spec_json"), {})
                    ports.setdefault(port["process_id"], []).append(port)
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
            edges = self._fetchall(conn, "SELECT * FROM edge WHERE workflow_id = ? ORDER BY rowid", (workflow_id,))
        workflow["layout_json"] = _json_load(workflow.get("layout_json"), {})
        for process in processes:
            process["ports"] = ports.get(process["id"], [])
            process["skills"] = skills.get(process["id"], [])
            process["runs"] = runs.get(process["id"], [])
        workflow["processes"] = processes
        workflow["edges"] = edges
        return workflow

    def get_process(self, process_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (process_id,))
            if not process:
                raise KeyError(f"Process not found: {process_id}")
            ports = self._fetchall(conn, "SELECT * FROM artifact_port WHERE process_id = ? ORDER BY rowid", (process_id,))
            for port in ports:
                port["spec_json"] = _json_load(port.get("spec_json"), {})
            skills = self._fetchall(conn, "SELECT * FROM process_skill WHERE process_id = ? ORDER BY skill_name", (process_id,))
        process["ports"] = ports
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
            ports = data.get("ports") or [
                {"direction": "in", "artifact_name": "input", "artifact_type": "text", "spec_json": {}},
                {"direction": "out", "artifact_name": "output", "artifact_type": "text", "spec_json": {}},
            ]
            for port in ports:
                conn.execute(
                    """
                    INSERT INTO artifact_port(id, process_id, direction, artifact_name, artifact_type, spec_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        port.get("id") or new_id("port"),
                        process_id,
                        port["direction"],
                        port["artifact_name"],
                        port.get("artifact_type", "text"),
                        _json_dump(port.get("spec_json", {})),
                    ),
                )
        return self.get_process(process_id)

    def delete_process(self, process_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM process WHERE id = ?", (process_id,))

    def update_process_config(self, process_id: str, data: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name",
            "type",
            "agent_kind",
            "agent_model",
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
            if data.get("ports") is not None:
                new_port_ids: list[str] = []
                for port in data["ports"]:
                    port_id = port.get("id") or new_id("port")
                    new_port_ids.append(port_id)
                    conn.execute(
                        """
                        INSERT INTO artifact_port(id, process_id, direction, artifact_name, artifact_type, spec_json)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            direction = excluded.direction,
                            artifact_name = excluded.artifact_name,
                            artifact_type = excluded.artifact_type,
                            spec_json = excluded.spec_json
                        """,
                        (
                            port_id,
                            process_id,
                            port["direction"],
                            port["artifact_name"],
                            port.get("artifact_type", "text"),
                            _json_dump(port.get("spec_json", {})),
                        ),
                    )
                if new_port_ids:
                    placeholders = ",".join("?" for _ in new_port_ids)
                    conn.execute(
                        f"DELETE FROM artifact_port WHERE process_id = ? AND id NOT IN ({placeholders})",
                        (process_id, *new_port_ids),
                    )
                else:
                    conn.execute("DELETE FROM artifact_port WHERE process_id = ?", (process_id,))
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
            from_process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (data["from_process_id"],))
            to_process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (data["to_process_id"],))
            if not from_process or not to_process:
                raise ValueError("Both processes must exist")
            if from_process["workflow_id"] != workflow_id or to_process["workflow_id"] != workflow_id:
                raise ValueError("Edges can only connect processes in the same workflow")
            if data["from_process_id"] == data["to_process_id"]:
                raise ValueError("Self-loop edges are not allowed")
            from_port = self._fetchone(conn, "SELECT * FROM artifact_port WHERE id = ?", (data["from_port_id"],))
            to_port = self._fetchone(conn, "SELECT * FROM artifact_port WHERE id = ?", (data["to_port_id"],))
            if not from_port or not to_port:
                raise ValueError("Both ports must exist")
            if from_port["process_id"] != data["from_process_id"] or to_port["process_id"] != data["to_process_id"]:
                raise ValueError("Ports must belong to the connected processes")
            if from_port["direction"] != "out" or to_port["direction"] != "in":
                raise ValueError("Edges must connect an output port to an input port")
            existing_input = self._fetchone(
                conn,
                "SELECT * FROM edge WHERE workflow_id = ? AND to_port_id = ?",
                (workflow_id, data["to_port_id"]),
            )
            if existing_input:
                raise ValueError("Input port already has an upstream edge")
            if self._would_create_cycle(conn, workflow_id, data["from_process_id"], data["to_process_id"]):
                raise ValueError("Edge would create a workflow cycle")
            conn.execute(
                """
                INSERT INTO edge(id, workflow_id, from_process_id, from_port_id, to_process_id, to_port_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    edge_id,
                    workflow_id,
                    data["from_process_id"],
                    data["from_port_id"],
                    data["to_process_id"],
                    data["to_port_id"],
                ),
            )
            edge = self._fetchone(conn, "SELECT * FROM edge WHERE id = ?", (edge_id,))
        return edge

    def _would_create_cycle(
        self,
        conn: sqlite3.Connection,
        workflow_id: str,
        from_process_id: str,
        to_process_id: str,
    ) -> bool:
        adjacency: dict[str, list[str]] = {}
        edges = self._fetchall(
            conn,
            "SELECT from_process_id, to_process_id FROM edge WHERE workflow_id = ?",
            (workflow_id,),
        )
        for edge in edges:
            adjacency.setdefault(edge["from_process_id"], []).append(edge["to_process_id"])
        adjacency.setdefault(from_process_id, []).append(to_process_id)

        stack = [to_process_id]
        visited: set[str] = set()
        while stack:
            current = stack.pop()
            if current == from_process_id:
                return True
            if current in visited:
                continue
            visited.add(current)
            stack.extend(adjacency.get(current, []))
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

    def get_workflow_edges_for_process(self, process_id: str) -> list[dict[str, Any]]:
        process = self.get_process(process_id)
        with self.connect() as conn:
            return self._fetchall(conn, "SELECT * FROM edge WHERE workflow_id = ? AND to_process_id = ?", (process["workflow_id"], process_id))

    def get_port(self, port_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            port = self._fetchone(conn, "SELECT * FROM artifact_port WHERE id = ?", (port_id,))
        if not port:
            raise KeyError(f"Port not found: {port_id}")
        port["spec_json"] = _json_load(port.get("spec_json"), {})
        return port

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
                    "port_id": value["port_id"],
                    "artifact_type": value["artifact_type"],
                    "file_path": value.get("file_path"),
                    "url": value.get("url"),
                    "text_value": value.get("text_value"),
                }
                conn.execute(
                    """
                    INSERT INTO artifact_value(id, run_id, port_id, artifact_type, file_path, url, text_value)
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
