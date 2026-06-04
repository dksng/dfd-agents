from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.config import Settings
from agent_orchestrator.deps import get_engine, get_settings, get_skills
from agent_orchestrator.execution import ExecutionEngine
from agent_orchestrator.models import AppSettingsUpdate
from agent_orchestrator.skills import SkillRegistry

router = APIRouter(prefix="/api")


@router.get("/health")
def health(engine: ExecutionEngine = Depends(get_engine)) -> dict:
    return {"status": "ok", **engine.describe_adapter()}


@router.get("/settings")
def get_app_settings(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    return {
        "skill_repos": settings.skill_repos,
        "config_root": str(settings.config_root),
        "skill_cache_root": str(settings.skill_cache_root),
    }


@router.put("/settings")
def update_settings(
    payload: AppSettingsUpdate,
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    if payload.skill_repos is not None:
        settings.skill_repos = [item.strip() for item in payload.skill_repos if item.strip()]
    settings.save_runtime_settings()
    return {
        "skill_repos": settings.skill_repos,
        "config_root": str(settings.config_root),
        "skill_cache_root": str(settings.skill_cache_root),
    }


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
