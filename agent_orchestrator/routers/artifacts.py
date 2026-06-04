from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from agent_orchestrator.config import Settings
from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_settings, get_store
from agent_orchestrator.models import ArtifactCreate, ArtifactUpdate
from agent_orchestrator.workspace import safe_name

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/artifacts")
def create_artifact(workflow_id: str, payload: ArtifactCreate, store: Store = Depends(get_store)) -> dict:
    return store.create_artifact(workflow_id, payload.model_dump())


@router.put("/artifacts/{artifact_id}")
def update_artifact(artifact_id: str, payload: ArtifactUpdate, store: Store = Depends(get_store)) -> dict:
    return store.update_artifact(
        artifact_id,
        payload.model_dump(exclude_unset=True),
    )


@router.delete("/artifacts/{artifact_id}")
def delete_artifact(artifact_id: str, store: Store = Depends(get_store)) -> dict[str, bool]:
    store.delete_artifact(artifact_id)
    return {"ok": True}


@router.post("/artifacts/{artifact_id}/source-file")
async def upload_artifact_source_file(
    artifact_id: str,
    request: Request,
    filename: str = Query(..., min_length=1),
    store: Store = Depends(get_store),
    settings: Settings = Depends(get_settings),
) -> dict:
    artifact = store.get_artifact(artifact_id)
    if artifact["type"] != "file":
        raise HTTPException(status_code=422, detail="Only file artifacts can receive file uploads")
    if store.get_edges_for_artifact(artifact_id, "produces"):
        raise HTTPException(status_code=409, detail="Produced artifacts cannot receive source uploads")
    clean_filename = safe_name(Path(filename).name)
    upload_dir = settings.workflow_root / artifact["workflow_id"] / "source_uploads" / artifact_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / clean_filename
    target.write_bytes(await request.body())
    return store.update_artifact(artifact_id, {"source_file_path": str(target)})
