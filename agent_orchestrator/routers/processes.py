from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_client_id, get_engine, get_hub, get_store
from agent_orchestrator.events import EventHub
from agent_orchestrator.execution import ExecutionEngine
from agent_orchestrator.models import ProcessConfigUpdate, ProcessCreate

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/processes")
async def create_process(
    workflow_id: str,
    payload: ProcessCreate,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict:
    process = store.create_process(workflow_id, payload.model_dump())
    await hub.publish_graph(workflow_id, "process.create", {"process_id": process["id"]}, origin=client_id)
    return process


@router.delete("/processes/{process_id}")
async def delete_process(
    process_id: str,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict[str, bool]:
    process = store.get_process(process_id)
    store.delete_process(process_id)
    await hub.publish_graph(process["workflow_id"], "process.delete", {"process_id": process_id}, origin=client_id)
    return {"ok": True}


@router.put("/processes/{process_id}/config")
async def update_process_config(
    process_id: str,
    payload: ProcessConfigUpdate,
    store: Store = Depends(get_store),
    hub: EventHub = Depends(get_hub),
    client_id: str = Depends(get_client_id),
) -> dict:
    process = store.update_process_config(
        process_id,
        payload.model_dump(exclude_unset=True),
    )
    await hub.publish_graph(process["workflow_id"], "process.config", {"process_id": process_id}, origin=client_id)
    return process


@router.post("/processes/{process_id}/run")
async def run_process(process_id: str, engine: ExecutionEngine = Depends(get_engine)) -> dict:
    return await engine.start_process(process_id)
