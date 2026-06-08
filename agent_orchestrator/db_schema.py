from __future__ import annotations

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
    agent_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    agent_effort TEXT NOT NULL DEFAULT 'medium',
    permission_mode TEXT NOT NULL DEFAULT '',
    allowed_tools TEXT NOT NULL DEFAULT '',
    disallowed_tools TEXT NOT NULL DEFAULT '',
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
    cache_write_5m INTEGER NOT NULL DEFAULT 0,
    cache_write_1h INTEGER NOT NULL DEFAULT 0,
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
