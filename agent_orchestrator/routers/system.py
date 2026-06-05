from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.config import Settings, normalize_notify_events
from agent_orchestrator.deps import get_engine, get_settings, get_skills
from agent_orchestrator.execution import ExecutionEngine
from agent_orchestrator.models import AppSettingsUpdate
from agent_orchestrator.skills import SkillRegistry

router = APIRouter(prefix="/api")


def _settings_response(settings: Settings) -> dict[str, object]:
    return {
        "skill_repos": settings.skill_repos,
        "config_root": str(settings.config_root),
        "skill_cache_root": str(settings.skill_cache_root),
        "notify_events": normalize_notify_events(settings.notify_events),
        "notify_enabled": settings.notify_enabled,
    }


@router.get("/health")
def health(engine: ExecutionEngine = Depends(get_engine)) -> dict:
    return {"status": "ok", **engine.describe_adapter()}


@router.get("/settings")
def get_app_settings(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    return _settings_response(settings)


@router.put("/settings")
def update_settings(
    payload: AppSettingsUpdate,
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    if payload.skill_repos is not None:
        settings.skill_repos = [item.strip() for item in payload.skill_repos if item.strip()]
    if payload.notify_events is not None:
        settings.notify_events = normalize_notify_events(payload.notify_events)
    if payload.notify_enabled is not None:
        settings.notify_enabled = payload.notify_enabled
    settings.save_runtime_settings()
    return _settings_response(settings)


@router.get("/templates/{template_id}/agents-base")
def agents_base(template_id: str, settings: Settings = Depends(get_settings)) -> dict[str, str]:
    template = settings.template_root / template_id / "AGENTS.md"
    if not template.exists():
        template = settings.template_root / "base" / "AGENTS.md"
    content = template.read_text(encoding="utf-8") if template.exists() else ""
    return {"template_id": template_id, "content": content}


@router.get("/skills")
def list_skills(
    repo: str | None = None,
    refresh: bool = False,
    skills: SkillRegistry = Depends(get_skills),
) -> dict[str, object]:
    return skills.list_skills(repo=repo, refresh=refresh)
