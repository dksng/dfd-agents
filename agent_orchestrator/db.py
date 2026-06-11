from __future__ import annotations

import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from .db_connection import connect_sqlite
from .db_migrations import apply_additive_migrations, reset_schema, schema_needs_reset
from .db_schema import SCHEMA
from .repositories import ArtifactRepository, EdgeRepository, ProcessRepository, RunRepository, WorkflowRepository


class Store(WorkflowRepository, ProcessRepository, ArtifactRepository, EdgeRepository, RunRepository):
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self):
        return connect_sqlite(self.db_path)

    def init(self) -> None:
        with self.connect() as conn:
            needs_reset = schema_needs_reset(conn)
        if needs_reset:
            self._backup_before_reset()
        with self.connect() as conn:
            if needs_reset:
                reset_schema(conn)
            conn.executescript(SCHEMA)
            apply_additive_migrations(conn)
            conn.execute("PRAGMA user_version = 3")

    def _backup_before_reset(self) -> None:
        """Copy the database aside before a legacy-schema reset drops all tables."""
        if not self.db_path.exists():
            return
        backup = self.db_path.with_name(f"{self.db_path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(self.db_path, backup)

    def _fetchone(self, conn: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def _fetchall(self, conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
