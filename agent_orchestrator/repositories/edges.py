from __future__ import annotations

import sqlite3
from typing import Any

from agent_orchestrator.db_ids import new_id
from agent_orchestrator.exceptions import AppValidationError


class EdgeRepository:
    def create_edge(self, workflow_id: str, data: dict[str, Any]) -> dict[str, Any]:
        edge_id = new_id("edge")
        with self.connect() as conn:
            kind = data["kind"]
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (data["process_id"],))
            artifact = self._fetchone(conn, "SELECT * FROM artifact WHERE id = ?", (data["artifact_id"],))
            if not process or not artifact:
                raise AppValidationError("Process and artifact must exist")
            if process["workflow_id"] != workflow_id or artifact["workflow_id"] != workflow_id:
                raise AppValidationError("Edges can only connect nodes in the same workflow")
            existing = self._fetchone(
                conn,
                "SELECT * FROM edge WHERE workflow_id = ? AND kind = ? AND process_id = ? AND artifact_id = ?",
                (workflow_id, kind, data["process_id"], data["artifact_id"]),
            )
            if existing:
                raise AppValidationError("Edge already exists")
            if kind == "produces":
                producer = self._fetchone(
                    conn,
                    "SELECT * FROM edge WHERE workflow_id = ? AND kind = 'produces' AND artifact_id = ?",
                    (workflow_id, data["artifact_id"]),
                )
                if producer:
                    raise AppValidationError("Artifact already has a producer")
            if self._would_create_cycle(conn, workflow_id, kind, data["process_id"], data["artifact_id"]):
                raise AppValidationError("Edge would create a workflow cycle")
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
        edges = self._fetchall(
            conn, "SELECT kind, process_id, artifact_id FROM edge WHERE workflow_id = ?", (workflow_id,)
        )
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

        return any(visit(process) for process in list(adjacency))

    def delete_edge(self, edge_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM edge WHERE id = ?", (edge_id,))

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
