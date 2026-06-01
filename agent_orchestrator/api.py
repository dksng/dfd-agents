from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .db import Store
from .events import EventHub
from .execution import ExecutionEngine
from .models import (
    EdgeCreate,
    ProcessConfigUpdate,
    ProcessCreate,
    QAAnswerRequest,
    QARequest,
    ResumeRequest,
    ReviewRequest,
    SubmitRequest,
    WorkflowCreate,
    WorkflowUpdate,
)
from .pricing import Pricing
from .skills import SkillRegistry
from .workspace import WorkspaceBuilder


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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
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
    app.state.skills = skills

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1):\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/workflows")
    def list_workflows(request: Request) -> list[dict]:
        return request.app.state.store.list_workflows()

    @app.post("/api/workflows")
    def create_workflow(payload: WorkflowCreate, request: Request) -> dict:
        return request.app.state.store.create_workflow(payload.name)

    @app.get("/api/workflows/{workflow_id}")
    def get_workflow(workflow_id: str, request: Request) -> dict:
        try:
            return request.app.state.store.get_workflow(workflow_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.put("/api/workflows/{workflow_id}")
    def update_workflow(workflow_id: str, payload: WorkflowUpdate, request: Request) -> dict:
        try:
            return request.app.state.store.update_workflow(
                workflow_id,
                name=payload.name,
                layout_json=payload.layout_json,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/workflows/{workflow_id}/processes")
    def create_process(workflow_id: str, payload: ProcessCreate, request: Request) -> dict:
        try:
            return request.app.state.store.create_process(workflow_id, payload.model_dump())
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/processes/{process_id}")
    def delete_process(process_id: str, request: Request) -> dict[str, bool]:
        request.app.state.store.delete_process(process_id)
        return {"ok": True}

    @app.put("/api/processes/{process_id}/config")
    def update_process_config(process_id: str, payload: ProcessConfigUpdate, request: Request) -> dict:
        try:
            return request.app.state.store.update_process_config(
                process_id,
                payload.model_dump(exclude_unset=True),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/workflows/{workflow_id}/edges")
    def create_edge(workflow_id: str, payload: EdgeCreate, request: Request) -> dict:
        try:
            return request.app.state.store.create_edge(workflow_id, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/api/edges/{edge_id}")
    def delete_edge(edge_id: str, request: Request) -> dict[str, bool]:
        request.app.state.store.delete_edge(edge_id)
        return {"ok": True}

    @app.get("/api/skills")
    def list_skills(
        request: Request,
        repo: str | None = None,
        refresh: bool = False,
    ) -> dict[str, object]:
        return request.app.state.skills.list_skills(repo=repo, refresh=refresh)

    @app.post("/api/processes/{process_id}/run")
    async def run_process(process_id: str, request: Request) -> dict:
        try:
            return await request.app.state.engine.start_process(process_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/runs/{run_id}/resume")
    async def resume_run(run_id: str, payload: ResumeRequest, request: Request) -> dict:
        try:
            return await request.app.state.engine.resume_run(run_id, payload.feedback_text)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict:
        try:
            return request.app.state.store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/runs/{run_id}/qa")
    async def create_qa(
        run_id: str,
        payload: QARequest,
        request: Request,
        wait: bool = Query(default=True),
        timeout_seconds: int | None = Query(default=None, ge=0),
    ) -> dict:
        require_orch_token(request)
        try:
            return await request.app.state.engine.register_question(
                run_id,
                payload.question_text,
                wait=wait,
                timeout_seconds=timeout_seconds,
            )
        except TimeoutError as exc:
            raise HTTPException(status_code=408, detail=str(exc)) from exc

    @app.post("/api/qa/{qa_id}/answer")
    async def answer_qa(qa_id: str, payload: QAAnswerRequest, request: Request) -> dict:
        try:
            return await request.app.state.engine.answer_question(qa_id, payload.answer_text)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/runs/{run_id}/submit")
    async def submit_run(run_id: str, request: Request, _payload: SubmitRequest | None = None) -> dict:
        require_orch_token(request)
        try:
            return await request.app.state.engine.submit_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/runs/{run_id}/review")
    async def review_run(run_id: str, payload: ReviewRequest, request: Request) -> dict:
        try:
            return await request.app.state.engine.review_run(run_id, payload.action, payload.feedback_text)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/runs/{run_id}/artifacts/{port_id}/download")
    def download_artifact(run_id: str, port_id: str, request: Request) -> FileResponse:
        run = request.app.state.store.get_run(run_id)
        artifact = next((item for item in run["artifacts"] if item["port_id"] == port_id), None)
        if not artifact or artifact["artifact_type"] != "file" or not artifact["file_path"]:
            raise HTTPException(status_code=404, detail="File artifact not found")
        workdir = Path(run["workdir_path"]).resolve()
        path = (workdir / artifact["file_path"]).resolve()
        if not path.is_relative_to(workdir):
            raise HTTPException(status_code=403, detail="File artifact path escapes run workdir")
        if not path.exists():
            raise HTTPException(status_code=404, detail="File does not exist")
        return FileResponse(path)

    @app.get("/api/workflows/{workflow_id}/cost")
    def workflow_cost(workflow_id: str, request: Request) -> dict:
        return request.app.state.store.workflow_cost(workflow_id)

    @app.get("/api/runs/{run_id}/cost")
    def run_cost(run_id: str, request: Request) -> dict:
        return request.app.state.store.run_cost(run_id)

    @app.websocket("/ws/runs/{run_id}")
    async def run_ws(run_id: str, websocket: WebSocket) -> None:
        await websocket.app.state.hub.connect(run_id, websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await websocket.app.state.hub.disconnect(run_id, websocket)

    dist_dir = settings.project_root / "frontend" / "dist"
    if dist_dir.exists():
        app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")

    return app


app = create_app()
