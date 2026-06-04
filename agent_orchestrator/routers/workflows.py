from __future__ import annotations

import shutil
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from agent_orchestrator.config import Settings
from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_settings, get_store
from agent_orchestrator.models import WorkflowCreate, WorkflowImport, WorkflowUpdate
from agent_orchestrator.workspace import safe_name

router = APIRouter(prefix="/api")


@router.get("/workflows")
def list_workflows(store: Store = Depends(get_store)) -> list[dict]:
    return store.list_workflows()


@router.post("/workflows")
def create_workflow(payload: WorkflowCreate, store: Store = Depends(get_store)) -> dict:
    return store.create_workflow(payload.name)


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str, store: Store = Depends(get_store)) -> dict:
    return store.get_workflow(workflow_id)


@router.put("/workflows/{workflow_id}")
def update_workflow(
    workflow_id: str,
    payload: WorkflowUpdate,
    store: Store = Depends(get_store),
) -> dict:
    return store.update_workflow(
        workflow_id,
        name=payload.name,
        layout_json=payload.layout_json,
    )


@router.get("/workflows/{workflow_id}/export")
def export_workflow(workflow_id: str, store: Store = Depends(get_store)) -> JSONResponse:
    document = store.export_workflow(workflow_id)
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


@router.post("/workflows/import")
def import_workflow(payload: WorkflowImport, store: Store = Depends(get_store)) -> dict:
    return store.import_workflow(payload.document, payload.name)


@router.delete("/workflows/{workflow_id}")
def delete_workflow(
    workflow_id: str,
    store: Store = Depends(get_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    store.delete_workflow(workflow_id)
    shutil.rmtree(settings.workflow_root / workflow_id, ignore_errors=True)
    return {"ok": True}


@router.get("/workflows/{workflow_id}/cost")
def workflow_cost(workflow_id: str, store: Store = Depends(get_store)) -> dict:
    return store.workflow_cost(workflow_id)
