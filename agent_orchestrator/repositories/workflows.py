from __future__ import annotations

from typing import Any

from agent_orchestrator.db_ids import new_id, now_iso
from agent_orchestrator.db_json import json_dump, json_load
from agent_orchestrator.exceptions import AppValidationError, ConflictError, NotFoundError


class WorkflowRepository:
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
            row["layout_json"] = json_load(row.get("layout_json"), {})
        return rows

    def update_workflow(
        self, workflow_id: str, *, name: str | None = None, layout_json: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        assignments: list[str] = ["updated_at = ?"]
        params: list[Any] = [now_iso()]
        if name is not None:
            assignments.append("name = ?")
            params.append(name)
        if layout_json is not None:
            assignments.append("layout_json = ?")
            params.append(json_dump(layout_json))
        params.append(workflow_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE workflow SET {', '.join(assignments)} WHERE id = ?", tuple(params))
        return self.get_workflow(workflow_id)

    def get_workflow(self, workflow_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            workflow = self._fetchone(conn, "SELECT * FROM workflow WHERE id = ?", (workflow_id,))
            if not workflow:
                raise NotFoundError(f"Workflow not found: {workflow_id}")
            processes = self._fetchall(
                conn, "SELECT * FROM process WHERE workflow_id = ? ORDER BY rowid", (workflow_id,)
            )
            process_ids = [process["id"] for process in processes]
            skills: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            runs: dict[str, list[dict[str, Any]]] = {process_id: [] for process_id in process_ids}
            if process_ids:
                placeholders = ",".join("?" for _ in process_ids)
                for skill in self._fetchall(
                    conn,
                    f"SELECT * FROM process_skill WHERE process_id IN ({placeholders}) ORDER BY skill_name",
                    tuple(process_ids),
                ):
                    skills.setdefault(skill["process_id"], []).append(skill)
                run_rows = self._fetchall(
                    conn,
                    f"SELECT * FROM run WHERE process_id IN ({placeholders}) ORDER BY started_at DESC",
                    tuple(process_ids),
                )
                run_ids = [run["id"] for run in run_rows]
                usage_by_run: dict[str, dict[str, Any]] = {}
                if run_ids:
                    run_placeholders = ",".join("?" for _ in run_ids)
                    for usage in self._fetchall(
                        conn,
                        f"""
                        SELECT
                            run_id,
                            COALESCE(SUM(input_tokens), 0) AS input_tokens,
                            COALESCE(SUM(output_tokens), 0) AS output_tokens,
                            COALESCE(SUM(cache_read), 0) AS cache_read,
                            COALESCE(SUM(cache_write), 0) AS cache_write,
                            COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
                            COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
                            COALESCE(SUM(cost_usd), 0) AS cost_usd
                        FROM run_token_usage
                        WHERE run_id IN ({run_placeholders})
                        GROUP BY run_id
                        """,
                        tuple(run_ids),
                    ):
                        usage_by_run[usage["run_id"]] = usage
                for run in run_rows:
                    run["input_snapshot_json"] = json_load(run.get("input_snapshot_json"), {})
                    run["output_snapshot_json"] = json_load(run.get("output_snapshot_json"), {})
                    usage = usage_by_run.get(run["id"], {})
                    run["input_tokens"] = usage.get("input_tokens", 0)
                    run["output_tokens"] = usage.get("output_tokens", 0)
                    run["cache_read"] = usage.get("cache_read", 0)
                    run["cache_write"] = usage.get("cache_write", 0)
                    run["cache_write_5m"] = usage.get("cache_write_5m", 0)
                    run["cache_write_1h"] = usage.get("cache_write_1h", 0)
                    run["cost_usd"] = usage.get("cost_usd", 0)
                    runs.setdefault(run["process_id"], []).append(run)
            artifacts = self._fetchall(
                conn, "SELECT * FROM artifact WHERE workflow_id = ? ORDER BY rowid", (workflow_id,)
            )
            for artifact in artifacts:
                artifact["spec_json"] = json_load(artifact.get("spec_json"), {})
            edges = self._fetchall(conn, "SELECT * FROM edge WHERE workflow_id = ? ORDER BY rowid", (workflow_id,))
        workflow["layout_json"] = json_load(workflow.get("layout_json"), {})
        for process in processes:
            process["skills"] = skills.get(process["id"], [])
            process["runs"] = runs.get(process["id"], [])
        workflow["processes"] = processes
        workflow["artifacts"] = artifacts
        workflow["edges"] = edges
        return workflow

    def export_workflow(self, workflow_id: str) -> dict[str, Any]:
        workflow = self.get_workflow(workflow_id)
        return {
            "format_version": 1,
            "tool": "dfd-agents",
            "exported_at": now_iso(),
            "workflow": {
                "name": workflow["name"],
                "layout_json": workflow["layout_json"],
            },
            "processes": [
                {
                    "ref": process["id"],
                    "name": process["name"],
                    "type": process["type"],
                    "agent_kind": process["agent_kind"],
                    "agent_model": process["agent_model"],
                    "agent_effort": process["agent_effort"],
                    "permission_mode": process["permission_mode"],
                    "allowed_tools": process["allowed_tools"],
                    "disallowed_tools": process["disallowed_tools"],
                    "goal_md": process["goal_md"],
                    "template_id": process["template_id"],
                    "agents_md_append": process["agents_md_append"],
                    "execution_mode": process["execution_mode"],
                    "pos_x": process["pos_x"],
                    "pos_y": process["pos_y"],
                    "skills": [
                        {
                            "skill_name": skill["skill_name"],
                            "skill_source": skill["skill_source"],
                            "skill_ref": skill["skill_ref"],
                        }
                        for skill in process.get("skills", [])
                    ],
                }
                for process in workflow["processes"]
            ],
            "artifacts": [
                {
                    "ref": artifact["id"],
                    "name": artifact["name"],
                    "type": artifact["type"],
                    "pos_x": artifact["pos_x"],
                    "pos_y": artifact["pos_y"],
                    "source_text": artifact.get("source_text"),
                    "source_url": artifact.get("source_url"),
                    "source_file_path": artifact.get("source_file_path"),
                    "spec_json": artifact.get("spec_json") or {},
                }
                for artifact in workflow["artifacts"]
            ],
            "edges": [
                {
                    "kind": edge["kind"],
                    "process_ref": edge["process_id"],
                    "artifact_ref": edge["artifact_id"],
                }
                for edge in workflow["edges"]
            ],
        }

    def import_workflow(self, document: dict[str, Any], name: str | None = None) -> dict[str, Any]:
        if document.get("format_version") != 1:
            raise AppValidationError("Unsupported workflow export format_version")
        workflow_doc = document.get("workflow") or {}
        workflow_id = new_id("wf")
        ts = now_iso()
        workflow_name = name or workflow_doc.get("name") or "Imported Workflow"
        artifact_refs: dict[str, str] = {}
        process_refs: dict[str, str] = {}
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO workflow(id, name, created_at, updated_at, layout_json) VALUES (?, ?, ?, ?, ?)",
                (
                    workflow_id,
                    workflow_name,
                    ts,
                    ts,
                    json_dump(workflow_doc.get("layout_json") or {}),
                ),
            )

            for artifact in document.get("artifacts") or []:
                ref = str(artifact.get("ref") or "")
                if not ref:
                    raise AppValidationError("Artifact is missing ref")
                artifact_id = new_id("artifact")
                artifact_refs[ref] = artifact_id
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
                        artifact.get("name", "Imported Artifact"),
                        artifact.get("type", "text"),
                        artifact.get("pos_x", 360),
                        artifact.get("pos_y", 160),
                        artifact.get("source_text"),
                        artifact.get("source_url"),
                        artifact.get("source_file_path"),
                        json_dump(artifact.get("spec_json") or {}),
                    ),
                )

            for process in document.get("processes") or []:
                ref = str(process.get("ref") or "")
                if not ref:
                    raise AppValidationError("Process is missing ref")
                process_id = new_id("proc")
                process_refs[ref] = process_id
                goal_md = str(process.get("goal_md", ""))
                for old_ref, new_ref in artifact_refs.items():
                    goal_md = goal_md.replace(f"{{{{artifact:{old_ref}}}}}", f"{{{{artifact:{new_ref}}}}}")
                conn.execute(
                    """
                    INSERT INTO process(
                        id, workflow_id, name, type, agent_kind, agent_model, agent_effort,
                        permission_mode, allowed_tools, disallowed_tools, goal_md, template_id,
                        agents_md_append, pos_x, pos_y, execution_mode
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        process_id,
                        workflow_id,
                        process.get("name", "Imported Process"),
                        process.get("type", "implement"),
                        process.get("agent_kind", "claude"),
                        process.get("agent_model", "claude-sonnet-4-6"),
                        process.get("agent_effort", "medium"),
                        process.get("permission_mode", ""),
                        process.get("allowed_tools", ""),
                        process.get("disallowed_tools", ""),
                        goal_md,
                        process.get("template_id", "base"),
                        process.get("agents_md_append", ""),
                        process.get("pos_x", 120),
                        process.get("pos_y", 120),
                        process.get("execution_mode", "manual"),
                    ),
                )
                for skill in process.get("skills") or []:
                    conn.execute(
                        """
                        INSERT INTO process_skill(process_id, skill_name, skill_source, skill_ref)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            process_id,
                            skill["skill_name"],
                            skill["skill_source"],
                            skill["skill_ref"],
                        ),
                    )

            for edge in document.get("edges") or []:
                kind = edge.get("kind")
                process_id = process_refs.get(str(edge.get("process_ref") or ""))
                artifact_id = artifact_refs.get(str(edge.get("artifact_ref") or ""))
                if kind not in {"produces", "consumes"} or not process_id or not artifact_id:
                    raise AppValidationError("Edge references unknown process or artifact")
                existing = self._fetchone(
                    conn,
                    "SELECT * FROM edge WHERE workflow_id = ? AND kind = ? AND process_id = ? AND artifact_id = ?",
                    (workflow_id, kind, process_id, artifact_id),
                )
                if existing:
                    raise AppValidationError("Edge already exists")
                if kind == "produces":
                    producer = self._fetchone(
                        conn,
                        "SELECT * FROM edge WHERE workflow_id = ? AND kind = 'produces' AND artifact_id = ?",
                        (workflow_id, artifact_id),
                    )
                    if producer:
                        raise AppValidationError("Artifact already has a producer")
                if self._would_create_cycle(conn, workflow_id, kind, process_id, artifact_id):
                    raise AppValidationError("Edge would create a workflow cycle")
                conn.execute(
                    """
                    INSERT INTO edge(id, workflow_id, kind, process_id, artifact_id)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (new_id("edge"), workflow_id, kind, process_id, artifact_id),
                )
        return self.get_workflow(workflow_id)

    def workflow_has_active_runs(self, workflow_id: str) -> bool:
        with self.connect() as conn:
            row = self._fetchone(
                conn,
                """
                SELECT r.id
                FROM run r
                JOIN process p ON p.id = r.process_id
                WHERE p.workflow_id = ? AND r.status IN ('running', 'waiting_qa')
                LIMIT 1
                """,
                (workflow_id,),
            )
        return row is not None

    def delete_workflow(self, workflow_id: str) -> None:
        with self.connect() as conn:
            workflow = self._fetchone(conn, "SELECT * FROM workflow WHERE id = ?", (workflow_id,))
            if not workflow:
                raise NotFoundError(f"Workflow not found: {workflow_id}")
            active = self._fetchone(
                conn,
                """
                SELECT r.id
                FROM run r
                JOIN process p ON p.id = r.process_id
                WHERE p.workflow_id = ? AND r.status IN ('running', 'waiting_qa')
                LIMIT 1
                """,
                (workflow_id,),
            )
            if active:
                raise ConflictError("Workflow has active runs; stop them first")
            conn.execute("DELETE FROM workflow WHERE id = ?", (workflow_id,))

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
                    COALESCE(SUM(u.cache_write_5m), 0) AS cache_write_5m,
                    COALESCE(SUM(u.cache_write_1h), 0) AS cache_write_1h,
                    COALESCE(SUM(u.cost_usd), 0) AS cost_usd
                FROM run_token_usage u
                JOIN run r ON r.id = u.run_id
                JOIN process p ON p.id = r.process_id
                WHERE p.workflow_id = ?
                """,
                (workflow_id,),
            )
        return row or {}
