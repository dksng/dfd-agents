import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import { downloadJsonDocument } from "../lib/format";
import type { CostSummary, Workflow } from "../types";

type WorkflowSelectionMode = "processOnly" | "artifactFallback";

type UseWorkflowActionsArgs = {
  onClearSelection: () => void;
  onWorkflowLoaded: (workflow: Workflow, mode: WorkflowSelectionMode) => void;
  setError: (message: string) => void;
};

export function useWorkflowActions({ onClearSelection, onWorkflowLoaded, setError }: UseWorkflowActionsArgs) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const workflowImportRef = useRef<HTMLInputElement | null>(null);

  const loadWorkflow = useCallback(async (id: string) => {
    const data = await api.getWorkflow(id);
    setWorkflow(data);
    setCost(await api.workflowCost(id));
    return data;
  }, []);

  const loadInitialWorkflow = useCallback(async () => {
    let list = await api.listWorkflows();
    if (list.length === 0) {
      const created = await api.createWorkflow("Default Workflow");
      list = [created];
    }
    setWorkflows(list);
    const full = await loadWorkflow(list[0].id);
    onWorkflowLoaded(full, "processOnly");
    return full;
  }, [loadWorkflow, onWorkflowLoaded]);

  const selectWorkflow = useCallback(
    async (workflowId: string) => {
      if (!workflowId) {
        return;
      }
      const full = await loadWorkflow(workflowId);
      onWorkflowLoaded(full, "processOnly");
    },
    [loadWorkflow, onWorkflowLoaded]
  );

  const createWorkflow = useCallback(async () => {
    const created = await api.createWorkflow("New Workflow");
    setWorkflows((items) => [created, ...items]);
    const full = await loadWorkflow(created.id);
    onWorkflowLoaded(full, "processOnly");
  }, [loadWorkflow, onWorkflowLoaded]);

  const exportCurrentWorkflow = useCallback(async () => {
    if (!workflow) {
      return;
    }
    try {
      const { document, filename } = await api.exportWorkflow(workflow.id);
      downloadJsonDocument(document, filename);
    } catch (exc) {
      setError(String(exc));
    }
  }, [setError, workflow]);

  const importWorkflowFile = useCallback(
    async (file: File | null) => {
      if (!file) {
        return;
      }
      try {
        const document = JSON.parse(await file.text());
        const created = await api.importWorkflow(document);
        setWorkflows(await api.listWorkflows());
        const full = await loadWorkflow(created.id);
        onWorkflowLoaded(full, "artifactFallback");
      } catch (exc) {
        setError(String(exc));
      } finally {
        if (workflowImportRef.current) {
          workflowImportRef.current.value = "";
        }
      }
    },
    [loadWorkflow, onWorkflowLoaded, setError]
  );

  const deleteCurrentWorkflow = useCallback(async () => {
    if (!workflow) {
      return;
    }
    const confirmed = window.confirm(`Delete workflow "${workflow.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteWorkflow(workflow.id);
      const list = await api.listWorkflows();
      setWorkflows(list);
      onClearSelection();
      if (list.length > 0) {
        const full = await loadWorkflow(list[0].id);
        onWorkflowLoaded(full, "artifactFallback");
      } else {
        setWorkflow(null);
        setCost(null);
      }
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadWorkflow, onClearSelection, onWorkflowLoaded, setError, workflow]);

  const refreshWorkflow = useCallback(async () => {
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }, [loadWorkflow, workflow]);

  return {
    cost,
    createWorkflow,
    deleteCurrentWorkflow,
    exportCurrentWorkflow,
    importWorkflowFile,
    loadInitialWorkflow,
    loadWorkflow,
    refreshWorkflow,
    selectWorkflow,
    setCost,
    setWorkflow,
    setWorkflows,
    workflow,
    workflowImportRef,
    workflows
  };
}
