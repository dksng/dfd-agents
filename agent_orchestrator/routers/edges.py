from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_client_id, get_hub, get_store
from agent_orchestrator.events import EventHub
from agent_orchestrator.models import EdgeCreate

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/edges")
async def create_edge(
    workflow_id: str,
    payload: EdgeCreate,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict:
    edge = store.create_edge(workflow_id, payload.model_dump())
    await hub.publish_graph(workflow_id, "edge.create", {"edge_id": edge["id"]}, origin=client_id)
    return edge


@router.delete("/edges/{edge_id}")
async def delete_edge(
    edge_id: str,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict[str, bool]:
    workflow_id = store.delete_edge(edge_id)
    if workflow_id:
        await hub.publish_graph(workflow_id, "edge.delete", {"edge_id": edge_id}, origin=client_id)
    return {"ok": True}
