from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

from .config import Settings
from .db import Store
from .events import EventHub
from .execution import ExecutionEngine
from .skills import SkillRegistry


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> Store:
    return request.app.state.store


def get_engine(request: Request) -> ExecutionEngine:
    return request.app.state.engine


def get_hub(request: Request) -> EventHub:
    return request.app.state.hub


def get_skills(request: Request) -> SkillRegistry:
    return request.app.state.skills


def require_orch_token(request: Request) -> None:
    expected = request.app.state.settings.api_token
    if not expected:
        return
    authorization = request.headers.get("authorization", "")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Missing ORCH_TOKEN bearer token")
    token = authorization[len(prefix) :]
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid ORCH_TOKEN bearer token")
