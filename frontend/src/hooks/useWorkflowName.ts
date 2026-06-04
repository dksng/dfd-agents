import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Workflow } from "../types";

type UseWorkflowNameArgs = {
  setError: (message: string) => void;
  setWorkflow: Dispatch<SetStateAction<Workflow | null>>;
  setWorkflows: Dispatch<SetStateAction<Workflow[]>>;
  workflow: Workflow | null;
};

export function useWorkflowName({ setError, setWorkflow, setWorkflows, workflow }: UseWorkflowNameArgs) {
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const workflowSaveSeqRef = useRef(0);
  const workflowSaveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setWorkflowNameDraft(workflow?.name ?? "");
  }, [workflow?.id, workflow?.name]);

  useEffect(() => {
    if (!workflow || workflowNameDraft === workflow.name) {
      return;
    }
    const id = workflow.id;
    workflowSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++workflowSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateWorkflow(id, { name: workflowNameDraft }, { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== workflowSaveSeqRef.current) {
            return;
          }
          setWorkflows((items) => items.map((item) => (item.id === id ? { ...item, name: workflowNameDraft } : item)));
          setWorkflow((current) => (current && current.id === id ? { ...current, name: workflowNameDraft } : current));
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [setError, setWorkflow, setWorkflows, workflow, workflowNameDraft]);

  return { setWorkflowNameDraft, workflowNameDraft };
}
