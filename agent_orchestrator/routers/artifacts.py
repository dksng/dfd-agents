from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from agent_orchestrator.config import Settings
from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_client_id, get_hub, get_settings, get_store
from agent_orchestrator.events import EventHub
from agent_orchestrator.models import ArtifactCreate, ArtifactUpdate
from agent_orchestrator.workspace import safe_name

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/artifacts")
async def create_artifact(
    workflow_id: str,
    payload: ArtifactCreate,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict:
    artifact = store.create_artifact(workflow_id, payload.model_dump())
    await hub.publish_graph(workflow_id, "artifact.create", {"artifact_id": artifact["id"]}, origin=client_id)
    return artifact


@router.put("/artifacts/{artifact_id}")
async def update_artifact(
    artifact_id: str,
    payload: ArtifactUpdate,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict:
    artifact = store.update_artifact(
        artifact_id,
        payload.model_dump(exclude_unset=True),
    )
    await hub.publish_graph(artifact["workflow_id"], "artifact.update", {"artifact_id": artifact_id}, origin=client_id)
    return artifact


@router.delete("/artifacts/{artifact_id}")
async def delete_artifact(
    artifact_id: str,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict[str, bool]:
    artifact = store.get_artifact(artifact_id)
    store.delete_artifact(artifact_id)
    await hub.publish_graph(artifact["workflow_id"], "artifact.delete", {"artifact_id": artifact_id}, origin=client_id)
    return {"ok": True}


@router.post("/artifacts/{artifact_id}/source-file")
async def upload_artifact_source_file(
    artifact_id: str,
    request: Request,
    filename: str = Query(..., min_length=1),
    store: Store = Depends(get_store),
    settings: Settings = Depends(get_settings),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
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
    with target.open("wb") as handle:
        async for chunk in request.stream():
            handle.write(chunk)
    updated = store.update_artifact(artifact_id, {"source_file_path": str(target)})
    await hub.publish_graph(updated["workflow_id"], "artifact.update", {"artifact_id": artifact_id}, origin=client_id)
    return updated
