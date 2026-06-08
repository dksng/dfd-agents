from __future__ import annotations

from typing import Any

from agent_orchestrator.db_ids import new_id, now_iso
from agent_orchestrator.db_json import json_dump, json_load
from agent_orchestrator.exceptions import ConflictError, NotFoundError


class RunRepository:
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
                    json_dump(input_snapshot or {}),
                    "{}",
                    workdir_path,
                ),
            )
        return self.get_run(run_id)

    def update_run(self, run_id: str, **updates: Any) -> dict[str, Any]:
        if "input_snapshot_json" in updates:
            updates["input_snapshot_json"] = json_dump(updates["input_snapshot_json"])
        if "output_snapshot_json" in updates:
            updates["output_snapshot_json"] = json_dump(updates["output_snapshot_json"])
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
                raise NotFoundError(f"Run not found: {run_id}")
            process = self._fetchone(conn, "SELECT * FROM process WHERE id = ?", (run["process_id"],))
            logs = self._fetchall(conn, "SELECT * FROM run_log WHERE run_id = ? ORDER BY ts, rowid", (run_id,))
            usage = self._fetchall(conn, "SELECT * FROM run_token_usage WHERE run_id = ? ORDER BY ts, rowid", (run_id,))
            qas = self._fetchall(conn, "SELECT * FROM qa WHERE run_id = ? ORDER BY created_at", (run_id,))
            reviews = self._fetchall(conn, "SELECT * FROM review WHERE run_id = ? ORDER BY created_at", (run_id,))
            artifacts = self._fetchall(conn, "SELECT * FROM artifact_value WHERE run_id = ? ORDER BY rowid", (run_id,))
            usage_summary = self._fetchone(
                conn,
                """
                SELECT
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(cache_read), 0) AS cache_read,
                    COALESCE(SUM(cache_write), 0) AS cache_write,
                    COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
                    COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM run_token_usage WHERE run_id = ?
                """,
                (run_id,),
            )
        run["input_snapshot_json"] = json_load(run.get("input_snapshot_json"), {})
        run["output_snapshot_json"] = json_load(run.get("output_snapshot_json"), {})
        run.update(usage_summary or {})
        run["process"] = process
        run["logs"] = logs
        run["token_usage"] = usage
        run["qa"] = qas
        run["reviews"] = reviews
        run["artifacts"] = artifacts
        return run

    ATTENTION_STATUSES = ("waiting_qa", "in_review", "failed")

    def attention_summary(self) -> list[dict[str, Any]]:
        """Per-workflow counts of processes whose latest run is in an attention status.

        Derived from current state (no notification store): the badge reflects the
        actual backlog needing human action and auto-clears as runs transition.
        """
        with self.connect() as conn:
            rows = self._fetchall(
                conn,
                """
                SELECT p.workflow_id AS workflow_id, latest.status AS status, COUNT(*) AS n
                FROM process p
                JOIN run latest ON latest.id = (
                    SELECT id FROM run WHERE process_id = p.id
                    ORDER BY started_at DESC, rowid DESC LIMIT 1
                )
                WHERE latest.status IN ('waiting_qa', 'in_review', 'failed')
                GROUP BY p.workflow_id, latest.status
                """,
            )
        summary: dict[str, dict[str, Any]] = {}
        for row in rows:
            entry = summary.setdefault(
                row["workflow_id"],
                {"workflow_id": row["workflow_id"], "waiting_qa": 0, "in_review": 0, "failed": 0},
            )
            entry[row["status"]] = row["n"]
        return list(summary.values())

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

    def add_log(self, run_id: str, level: str, message: str, raw_json: dict[str, Any] | None = None) -> dict[str, Any]:
        log_id = new_id("log")
        row = {
            "id": log_id,
            "run_id": run_id,
            "ts": now_iso(),
            "level": level,
            "message": message,
            "raw_json": json_dump(raw_json or {}),
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
        cache_write_5m: int,
        cache_write_1h: int,
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
            "cache_write_5m": cache_write_5m,
            "cache_write_1h": cache_write_1h,
            "cost_usd": cost_usd,
            "model": model,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO run_token_usage(
                    id, run_id, ts, input_tokens, output_tokens, cache_read, cache_write,
                    cache_write_5m, cache_write_1h, cost_usd, model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                raise NotFoundError(f"QA not found: {qa_id}")
            if existing["status"] != "pending":
                raise ConflictError(f"QA is not pending: {existing['status']}")
            conn.execute(
                "UPDATE qa SET answer_text = ?, status = 'answered', answered_at = ? WHERE id = ?",
                (answer_text, now_iso(), qa_id),
            )
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise NotFoundError(f"QA not found: {qa_id}")
        return qa

    def timeout_qa(self, qa_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            cursor = conn.execute(
                "UPDATE qa SET status = 'timed_out', answered_at = ? WHERE id = ? AND status = 'pending'",
                (now_iso(), qa_id),
            )
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise NotFoundError(f"QA not found: {qa_id}")
        qa["timed_out_by_this_call"] = cursor.rowcount == 1
        return qa

    def get_qa(self, qa_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            qa = self._fetchone(conn, "SELECT * FROM qa WHERE id = ?", (qa_id,))
        if not qa:
            raise NotFoundError(f"QA not found: {qa_id}")
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
            raise NotFoundError(f"Review not found for run: {run_id}")
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
                    COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
                    COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM run_token_usage WHERE run_id = ?
                """,
                (run_id,),
            )
        return row or {}
