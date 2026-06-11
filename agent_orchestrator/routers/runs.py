from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_engine, get_store, require_orch_token
from agent_orchestrator.execution import ExecutionEngine
from agent_orchestrator.models import QAAnswerRequest, QARequest, ResumeRequest, ReviewRequest, SubmitRequest

router = APIRouter(prefix="/api")
ws_router = APIRouter()


@router.post("/runs/{run_id}/resume")
async def resume_run(
    run_id: str,
    payload: ResumeRequest,
    engine: ExecutionEngine = Depends(get_engine),
) -> dict:
    return await engine.resume_run(run_id, payload.feedback_text)


@router.get("/runs/{run_id}")
def get_run(run_id: str, store: Store = Depends(get_store)) -> dict:
    return store.get_run(run_id)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, engine: ExecutionEngine = Depends(get_engine)) -> dict:
    """Stop a running or QA-waiting run: kill the agent process and mark it failed."""
    return await engine.cancel_run(run_id)


@router.post("/runs/{run_id}/qa")
async def create_qa(
    run_id: str,
    payload: QARequest,
    wait: bool = Query(default=True),
    timeout_seconds: int | None = Query(default=None, ge=0),
    engine: ExecutionEngine = Depends(get_engine),
    _token: None = Depends(require_orch_token),
) -> dict:
    return await engine.register_question(
        run_id,
        payload.question_text,
        wait=wait,
        timeout_seconds=timeout_seconds,
    )


@router.post("/qa/{qa_id}/answer")
async def answer_qa(
    qa_id: str,
    payload: QAAnswerRequest,
    engine: ExecutionEngine = Depends(get_engine),
) -> dict:
    return await engine.answer_question(qa_id, payload.answer_text)


@router.post("/runs/{run_id}/submit")
async def submit_run(
    run_id: str,
    _payload: SubmitRequest | None = None,
    engine: ExecutionEngine = Depends(get_engine),
    _token: None = Depends(require_orch_token),
) -> dict:
    return await engine.submit_run(run_id)


@router.post("/runs/{run_id}/review")
async def review_run(
    run_id: str,
    payload: ReviewRequest,
    engine: ExecutionEngine = Depends(get_engine),
) -> dict:
    return await engine.review_run(run_id, payload.action, payload.feedback_text)


@router.get("/runs/{run_id}/artifacts/{artifact_id}/download")
def download_artifact(run_id: str, artifact_id: str, store: Store = Depends(get_store)) -> FileResponse:
    run = store.get_run(run_id)
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


@router.get("/runs/{run_id}/cost")
def run_cost(run_id: str, store: Store = Depends(get_store)) -> dict:
    return store.run_cost(run_id)


@router.get("/attention")
def attention(store: Store = Depends(get_store)) -> list[dict]:
    """Per-workflow counts of processes whose latest run needs human attention."""
    return store.attention_summary()


@ws_router.websocket("/ws/runs/{run_id}")
async def run_ws(run_id: str, websocket: WebSocket) -> None:
    await websocket.app.state.hub.connect(run_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await websocket.app.state.hub.disconnect(run_id, websocket)


@ws_router.websocket("/ws/events")
async def events_ws(websocket: WebSocket) -> None:
    """Global stream of all run events (cross-workflow), used for notifications/badges."""
    await websocket.app.state.hub.connect_global(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await websocket.app.state.hub.disconnect_global(websocket)
