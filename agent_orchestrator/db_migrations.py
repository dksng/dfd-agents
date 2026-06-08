from __future__ import annotations

import sqlite3


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    return row is not None


def schema_needs_reset(conn: sqlite3.Connection) -> bool:
    if not table_exists(conn, "workflow"):
        return False
    if table_exists(conn, "artifact_port"):
        return True
    if table_exists(conn, "edge") and "kind" not in table_columns(conn, "edge"):
        return True
    if table_exists(conn, "artifact_value") and "artifact_id" not in table_columns(conn, "artifact_value"):
        return True
    return not table_exists(conn, "artifact")


def reset_schema(conn: sqlite3.Connection) -> None:
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


def apply_additive_migrations(conn: sqlite3.Connection) -> None:
    """Add new nullable/defaulted columns to existing tables without a full reset."""
    process_columns = table_columns(conn, "process")
    if "agent_effort" not in process_columns:
        conn.execute("ALTER TABLE process ADD COLUMN agent_effort TEXT NOT NULL DEFAULT 'medium'")
    for column in ("permission_mode", "allowed_tools", "disallowed_tools"):
        if column not in process_columns:
            conn.execute(f"ALTER TABLE process ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    usage_columns = table_columns(conn, "run_token_usage")
    for column in ("cache_write_5m", "cache_write_1h"):
        if column not in usage_columns:
            conn.execute(f"ALTER TABLE run_token_usage ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
