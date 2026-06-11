from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NOTIFY_EVENTS = ["waiting_qa", "in_review", "failed"]
VALID_NOTIFY_EVENTS = {"waiting_qa", "in_review", "failed", "approved", "rejected"}


def _split_env_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _positive_int_env(name: str, default: int) -> int:
    value = _int_env(name, default)
    return value if value > 0 else default


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def normalize_notify_events(items: list[str] | None) -> list[str]:
    if not items:
        return list(DEFAULT_NOTIFY_EVENTS)
    events: list[str] = []
    for item in items:
        event = str(item).strip()
        if event in VALID_NOTIFY_EVENTS and event not in events:
            events.append(event)
    return events or list(DEFAULT_NOTIFY_EVENTS)


class Settings(BaseModel):
    project_root: Path = PROJECT_ROOT
    config_root: Path = Field(
        default_factory=lambda: Path(os.getenv("ORCH_CONFIG_ROOT", PROJECT_ROOT / ".orch" / "config"))
    )
    data_root: Path = Field(default_factory=lambda: Path(os.getenv("ORCH_DATA_ROOT", PROJECT_ROOT / ".orch" / "data")))
    api_token: str = Field(default_factory=lambda: os.getenv("ORCH_TOKEN", "dev-token"))
    skill_repos: list[str] = Field(default_factory=lambda: _split_env_list(os.getenv("ORCH_SKILL_REPOS")))
    agent_mode: str = Field(default_factory=lambda: os.getenv("ORCH_AGENT_MODE", "auto"))
    claude_command: str = Field(
        default_factory=lambda: os.getenv(
            "ORCH_CLAUDE_COMMAND",
            "claude --print --verbose --output-format stream-json",
        )
    )
    claude_stream_limit_bytes: int = Field(
        default_factory=lambda: _positive_int_env("ORCH_CLAUDE_STREAM_LIMIT_BYTES", 16 * 1024 * 1024)
    )
    copilot_command: str = Field(default_factory=lambda: os.getenv("ORCH_COPILOT_COMMAND", "copilot"))
    copilot_stream_limit_bytes: int = Field(
        default_factory=lambda: _positive_int_env("ORCH_COPILOT_STREAM_LIMIT_BYTES", 16 * 1024 * 1024)
    )
    api_base: str = Field(default_factory=lambda: os.getenv("ORCH_API_BASE", "http://127.0.0.1:8000"))
    qa_timeout_seconds: int = Field(default_factory=lambda: _int_env("ORCH_QA_TIMEOUT_SECONDS", 3600))
    # 工程が permission_mode を空("")にしているときに使うグローバル既定。
    default_permission_mode: str = Field(default_factory=lambda: os.getenv("ORCH_DEFAULT_PERMISSION_MODE", "default"))
    # allowed/disallowed はカンマ区切り（パターンに空白を含むため空白区切りは不可）。
    default_allowed_tools: str = Field(
        default_factory=lambda: os.getenv(
            "ORCH_DEFAULT_ALLOWED_TOOLS",
            "Read,Edit,Write,"
            "Bash(python3 *),Bash(python *),Bash(git *),Bash(ls *),Bash(cat *),"
            "Bash(grep *),Bash(rg *),Bash(find *),Bash(mkdir *),Bash(sed *)",
        )
    )
    default_disallowed_tools: str = Field(default_factory=lambda: os.getenv("ORCH_DEFAULT_DISALLOWED_TOOLS", ""))
    # Copilot CLI uses a different permission grammar (for example: write,shell(git:*)).
    default_copilot_allowed_tools: str = Field(
        default_factory=lambda: os.getenv("ORCH_DEFAULT_COPILOT_ALLOWED_TOOLS", "")
    )
    default_copilot_disallowed_tools: str = Field(
        default_factory=lambda: os.getenv("ORCH_DEFAULT_COPILOT_DISALLOWED_TOOLS", "")
    )
    notify_events: list[str] = Field(
        default_factory=lambda: normalize_notify_events(_split_env_list(os.getenv("ORCH_NOTIFY_EVENTS")))
    )
    notify_enabled: bool = Field(default_factory=lambda: _bool_env("ORCH_NOTIFY_ENABLED", False))

    @property
    def db_path(self) -> Path:
        return self.data_root / "app.db"

    @property
    def workflow_root(self) -> Path:
        return self.data_root / "workflows"

    @property
    def skill_cache_root(self) -> Path:
        return self.config_root / "skills_cache"

    @property
    def pricing_path(self) -> Path:
        return self.config_root / "pricing.yaml"

    @property
    def runtime_settings_path(self) -> Path:
        return self.config_root / "runtime_settings.json"

    @property
    def template_root(self) -> Path:
        return PROJECT_ROOT / "agent_orchestrator" / "templates"

    def ensure_dirs(self) -> None:
        self.config_root.mkdir(parents=True, exist_ok=True)
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.workflow_root.mkdir(parents=True, exist_ok=True)
        self.skill_cache_root.mkdir(parents=True, exist_ok=True)

    def load_runtime_settings(self) -> None:
        if not self.runtime_settings_path.exists():
            return
        data = json.loads(self.runtime_settings_path.read_text(encoding="utf-8"))
        skill_repos = data.get("skill_repos")
        if isinstance(skill_repos, list):
            self.skill_repos = [str(item).strip() for item in skill_repos if str(item).strip()]
        notify_events = data.get("notify_events")
        if isinstance(notify_events, list):
            self.notify_events = normalize_notify_events([str(item) for item in notify_events])
        notify_enabled = data.get("notify_enabled")
        if isinstance(notify_enabled, bool):
            self.notify_enabled = notify_enabled

    def save_runtime_settings(self) -> None:
        self.config_root.mkdir(parents=True, exist_ok=True)
        payload = {
            "skill_repos": self.skill_repos,
            "notify_events": normalize_notify_events(self.notify_events),
            "notify_enabled": self.notify_enabled,
        }
        self.runtime_settings_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def load_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    settings.load_runtime_settings()
    return settings
