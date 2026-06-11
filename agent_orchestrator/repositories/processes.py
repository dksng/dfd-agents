from __future__ import annotations

from typing import Any

from agent_orchestrator.agent_options import AGENT_EFFORT_VALUES, AGENT_KIND_VALUES, PERMISSION_MODE_VALUES
from agent_orchestrator.db_ids import new_id
from agent_orchestrator.exceptions import AppValidationError, NotFoundError


class ProcessRepository:
    def get_process(self, process_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (process_id,))
            if not process:
                raise NotFoundError(f"Process not found: {process_id}")
            skills = self._fetchall(
                conn, "SELECT * FROM process_skill WHERE process_id = ? ORDER BY skill_name", (process_id,)
            )
        process["skills"] = skills
        return process

    def create_process(self, workflow_id: str, data: dict[str, Any]) -> dict[str, Any]:
        process_id = new_id("proc")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO process(id, workflow_id, name, type, agent_model, pos_x, pos_y)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    process_id,
                    workflow_id,
                    data.get("name", "New Process"),
                    data.get("type", "implement"),
                    data.get("agent_model", "claude-sonnet-4-6"),
                    data.get("pos_x", 120),
                    data.get("pos_y", 120),
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
            "agent_effort",
            "permission_mode",
            "allowed_tools",
            "disallowed_tools",
            "goal_md",
            "template_id",
            "agents_md_append",
            "pos_x",
            "pos_y",
            "execution_mode",
        }
        updates = {key: value for key, value in data.items() if key in allowed and value is not None}
        if "agent_kind" in updates and updates["agent_kind"] not in AGENT_KIND_VALUES:
            raise AppValidationError(f"Invalid agent_kind: {updates['agent_kind']}")
        if "agent_effort" in updates and updates["agent_effort"] not in AGENT_EFFORT_VALUES:
            raise AppValidationError(f"Invalid agent_effort: {updates['agent_effort']}")
        if "permission_mode" in updates and updates["permission_mode"] not in PERMISSION_MODE_VALUES:
            raise AppValidationError(f"Invalid permission_mode: {updates['permission_mode']}")
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
