from __future__ import annotations

from typing import Any

from agent_orchestrator.db_ids import new_id
from agent_orchestrator.db_json import json_dump, json_load
from agent_orchestrator.exceptions import NotFoundError


class ArtifactRepository:
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
                    json_dump(data.get("spec_json", {})),
                ),
            )
        return self.get_artifact(artifact_id)

    def get_artifact(self, artifact_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            artifact = self._fetchone(conn, "SELECT * FROM artifact WHERE id = ?", (artifact_id,))
        if not artifact:
            raise NotFoundError(f"Artifact not found: {artifact_id}")
        artifact["spec_json"] = json_load(artifact.get("spec_json"), {})
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
            updates["spec_json"] = json_dump(updates["spec_json"] or {})
        if updates:
            assignments = ", ".join(f"{key} = ?" for key in updates)
            with self.connect() as conn:
                conn.execute(f"UPDATE artifact SET {assignments} WHERE id = ?", (*updates.values(), artifact_id))
        return self.get_artifact(artifact_id)

    def delete_artifact(self, artifact_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM artifact WHERE id = ?", (artifact_id,))
