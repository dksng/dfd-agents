from __future__ import annotations

from fastapi import APIRouter, Depends

from agent_orchestrator.db import Store
from agent_orchestrator.deps import get_engine, get_store
from agent_orchestrator.execution import ExecutionEngine
from agent_orchestrator.models import ProcessConfigUpdate, ProcessCreate

router = APIRouter(prefix="/api")


@router.post("/workflows/{workflow_id}/processes")
def create_process(workflow_id: str, payload: ProcessCreate, store: Store = Depends(get_store)) -> dict:
    return store.create_process(workflow_id, payload.model_dump())


@router.delete("/processes/{process_id}")
def delete_process(process_id: str, store: Store = Depends(get_store)) -> dict[str, bool]:
    store.delete_process(process_id)
    return {"ok": True}


@router.put("/processes/{process_id}/config")
def update_process_config(
    process_id: str,
    payload: ProcessConfigUpdate,
    store: Store = Depends(get_store),
) -> dict:
    return store.update_process_config(
        process_id,
        payload.model_dump(exclude_unset=True),
    )


@router.post("/processes/{process_id}/run")
async def run_process(process_id: str, engine: ExecutionEngine = Depends(get_engine)) -> dict:
    return await engine.start_process(process_id)
