from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_store
from agent_orchestrator.models import EdgeCreate

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/edges")
def create_edge(workflow_id: str, payload: EdgeCreate, store: Store = Depends(get_store)) -> dict:
    return store.create_edge(workflow_id, payload.model_dump())


@router.delete("/edges/{edge_id}")
def delete_edge(edge_id: str, store: Store = Depends(get_store)) -> dict[str, bool]:
    store.delete_edge(edge_id)
    return {"ok": True}
