from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .db import Store
from .events import EventHub
from .exceptions import AppValidationError, ConflictError, NotFoundError
from .execution import ExecutionEngine
from .pricing import Pricing
from .routers import artifacts, edges, processes, runs, system, workflows
from .skills import SkillRegistry
from .workspace import WorkspaceBuilder


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
    settings.load_runtime_settings()
    store = Store(settings.db_path)
    store.init()
    hub = EventHub()
    pricing = Pricing(settings.pricing_path)
    skills = SkillRegistry(settings)
    workspace = WorkspaceBuilder(settings, store, skills)
    engine = ExecutionEngine(settings, store, hub, pricing, workspace)

    app = FastAPI(title="Agent Process Orchestrator")
    app.state.settings = settings
    app.state.store = store
    app.state.hub = hub
    app.state.engine = engine
    app.state.pricing = pricing
    app.state.skills = skills

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1):\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(NotFoundError)
    async def not_found_handler(_request: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict_handler(_request: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(AppValidationError)
    async def validation_handler(_request: Request, exc: AppValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(TimeoutError)
    async def timeout_handler(_request: Request, exc: TimeoutError) -> JSONResponse:
        return JSONResponse(status_code=408, content={"detail": str(exc)})

    app.include_router(system.router)
    app.include_router(workflows.router)
    app.include_router(processes.router)
    app.include_router(artifacts.router)
    app.include_router(edges.router)
    app.include_router(runs.router)
    app.include_router(runs.ws_router)

    dist_dir = settings.project_root / "frontend" / "dist"
    if dist_dir.exists():
        app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")

    return app


app = create_app()
