from __future__ import annotations

import secrets
import shutil
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .db import Store
from .events import EventHub
from .execution import ExecutionEngine
from .exceptions import ConflictError, NotFoundError, AppValidationError
from .models import (
    AppSettingsUpdate,
    ArtifactCreate,
    ArtifactUpdate,
    EdgeCreate,
    ProcessConfigUpdate,
    ProcessCreate,
    QAAnswerRequest,
    QARequest,
    ResumeRequest,
    ReviewRequest,
    SubmitRequest,
    WorkflowCreate,
    WorkflowImport,
    WorkflowUpdate,
)
from .pricing import Pricing
from .skills import SkillRegistry
from .workspace import WorkspaceBuilder, safe_name


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

    @app.get("/api/health")
    def health(request: Request) -> dict:
        return {"status": "ok", **request.app.state.engine.describe_adapter()}

    @app.get("/api/settings")
    def get_settings(request: Request) -> dict[str, object]:
        settings = request.app.state.settings
        return {
            "skill_repos": settings.skill_repos,
            "config_root": str(settings.config_root),
            "skill_cache_root": str(settings.skill_cache_root),
        }

    @app.put("/api/settings")
    def update_settings(payload: AppSettingsUpdate, request: Request) -> dict[str, object]:
        settings = request.app.state.settings
        if payload.skill_repos is not None:
            settings.skill_repos = [item.strip() for item in payload.skill_repos if item.strip()]
        settings.save_runtime_settings()
        return {
            "skill_repos": settings.skill_repos,
            "config_root": str(settings.config_root),
            "skill_cache_root": str(settings.skill_cache_root),
        }

    @app.get("/api/templates/{template_id}/agents-base")
    def agents_base(template_id: str, request: Request) -> dict[str, str]:
        settings = request.app.state.settings
        template = settings.template_root / template_id / "AGENTS.md"
        if not template.exists():
            template = settings.template_root / "base" / "AGENTS.md"
        content = template.read_text(encoding="utf-8") if template.exists() else ""
        return {"template_id": template_id, "content": content}

    @app.get("/api/workflows")
    def list_workflows(request: Request) -> list[dict]:
        return request.app.state.store.list_workflows()

    @app.post("/api/workflows")
    def create_workflow(payload: WorkflowCreate, request: Request) -> dict:
        return request.app.state.store.create_workflow(payload.name)

    @app.get("/api/workflows/{workflow_id}")
    def get_workflow(workflow_id: str, request: Request) -> dict:
        return request.app.state.store.get_workflow(workflow_id)

    @app.put("/api/workflows/{workflow_id}")
    def update_workflow(workflow_id: str, payload: WorkflowUpdate, request: Request) -> dict:
        return request.app.state.store.update_workflow(
            workflow_id,
            name=payload.name,
            layout_json=payload.layout_json,
        )

    @app.get("/api/workflows/{workflow_id}/export")
    def export_workflow(workflow_id: str, request: Request) -> JSONResponse:
        document = request.app.state.store.export_workflow(workflow_id)
        filename = f"{document['workflow']['name']}.workflow.json"
        fallback_filename = f"{safe_name(document['workflow']['name'])}.workflow.json"
        return JSONResponse(
            content=document,
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{fallback_filename}"; '
                    f"filename*=UTF-8''{quote(filename)}"
                )
            },
        )

    @app.post("/api/workflows/import")
    def import_workflow(payload: WorkflowImport, request: Request) -> dict:
        return request.app.state.store.import_workflow(payload.document, payload.name)

    @app.delete("/api/workflows/{workflow_id}")
    def delete_workflow(workflow_id: str, request: Request) -> dict[str, bool]:
        request.app.state.store.delete_workflow(workflow_id)
        shutil.rmtree(request.app.state.settings.workflow_root / workflow_id, ignore_errors=True)
        return {"ok": True}

    @app.post("/api/workflows/{workflow_id}/processes")
    def create_process(workflow_id: str, payload: ProcessCreate, request: Request) -> dict:
        return request.app.state.store.create_process(workflow_id, payload.model_dump())

    @app.delete("/api/processes/{process_id}")
    def delete_process(process_id: str, request: Request) -> dict[str, bool]:
        request.app.state.store.delete_process(process_id)
        return {"ok": True}

    @app.post("/api/workflows/{workflow_id}/artifacts")
    def create_artifact(workflow_id: str, payload: ArtifactCreate, request: Request) -> dict:
        return request.app.state.store.create_artifact(workflow_id, payload.model_dump())

    @app.put("/api/artifacts/{artifact_id}")
    def update_artifact(artifact_id: str, payload: ArtifactUpdate, request: Request) -> dict:
        return request.app.state.store.update_artifact(
            artifact_id,
            payload.model_dump(exclude_unset=True),
        )

    @app.delete("/api/artifacts/{artifact_id}")
    def delete_artifact(artifact_id: str, request: Request) -> dict[str, bool]:
        request.app.state.store.delete_artifact(artifact_id)
        return {"ok": True}

    @app.post("/api/artifacts/{artifact_id}/source-file")
    async def upload_artifact_source_file(
        artifact_id: str,
        request: Request,
        filename: str = Query(..., min_length=1),
    ) -> dict:
        store = request.app.state.store
        artifact = store.get_artifact(artifact_id)
        if artifact["type"] != "file":
            raise HTTPException(status_code=422, detail="Only file artifacts can receive file uploads")
        if store.get_edges_for_artifact(artifact_id, "produces"):
            raise HTTPException(status_code=409, detail="Produced artifacts cannot receive source uploads")
        clean_filename = safe_name(Path(filename).name)
        upload_dir = request.app.state.settings.workflow_root / artifact["workflow_id"] / "source_uploads" / artifact_id
        upload_dir.mkdir(parents=True, exist_ok=True)
        target = upload_dir / clean_filename
        target.write_bytes(await request.body())
        return store.update_artifact(artifact_id, {"source_file_path": str(target)})

    @app.put("/api/processes/{process_id}/config")
    def update_process_config(process_id: str, payload: ProcessConfigUpdate, request: Request) -> dict:
        return request.app.state.store.update_process_config(
            process_id,
            payload.model_dump(exclude_unset=True),
        )

    @app.post("/api/workflows/{workflow_id}/edges")
    def create_edge(workflow_id: str, payload: EdgeCreate, request: Request) -> dict:
        return request.app.state.store.create_edge(workflow_id, payload.model_dump())

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
        return await request.app.state.engine.start_process(process_id)

    @app.post("/api/runs/{run_id}/resume")
    async def resume_run(run_id: str, payload: ResumeRequest, request: Request) -> dict:
        return await request.app.state.engine.resume_run(run_id, payload.feedback_text)

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict:
        return request.app.state.store.get_run(run_id)

    @app.post("/api/runs/{run_id}/qa")
    async def create_qa(
        run_id: str,
        payload: QARequest,
        request: Request,
        wait: bool = Query(default=True),
        timeout_seconds: int | None = Query(default=None, ge=0),
    ) -> dict:
        require_orch_token(request)
        return await request.app.state.engine.register_question(
            run_id,
            payload.question_text,
            wait=wait,
            timeout_seconds=timeout_seconds,
        )

    @app.post("/api/qa/{qa_id}/answer")
    async def answer_qa(qa_id: str, payload: QAAnswerRequest, request: Request) -> dict:
        return await request.app.state.engine.answer_question(qa_id, payload.answer_text)

    @app.post("/api/runs/{run_id}/submit")
    async def submit_run(run_id: str, request: Request, _payload: SubmitRequest | None = None) -> dict:
        require_orch_token(request)
        return await request.app.state.engine.submit_run(run_id)

    @app.post("/api/runs/{run_id}/review")
    async def review_run(run_id: str, payload: ReviewRequest, request: Request) -> dict:
        return await request.app.state.engine.review_run(run_id, payload.action, payload.feedback_text)

    @app.get("/api/runs/{run_id}/artifacts/{artifact_id}/download")
    def download_artifact(run_id: str, artifact_id: str, request: Request) -> FileResponse:
        run = request.app.state.store.get_run(run_id)
        artifact = next((item for item in run["artifacts"] if item["artifact_id"] == artifact_id), None)
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
