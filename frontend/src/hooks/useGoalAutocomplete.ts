import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { artifactDisplayLabel } from "../lib/goal";
import type { ArtifactNode, ProcessNode, Workflow } from "../types";

type UseGoalAutocompleteArgs = {
  processDraft: ProcessNode | null;
  setProcessDraft: Dispatch<SetStateAction<ProcessNode | null>>;
  workflow: Workflow | null;
};

function artifactsConnectedToProcess(workflow: Workflow | null, processId: string): ArtifactNode[] {
  if (!workflow) {
    return [];
  }
  const connectedIds = new Set(
    workflow.edges.filter((edge) => edge.process_id === processId).map((edge) => edge.artifact_id)
  );
  return workflow.artifacts.filter((artifact) => connectedIds.has(artifact.id));
}

export function useGoalAutocomplete({ processDraft, setProcessDraft, workflow }: UseGoalAutocompleteArgs) {
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [goalCursor, setGoalCursor] = useState(0);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);

  const goalArtifacts = useMemo(() => {
    return processDraft ? artifactsConnectedToProcess(workflow, processDraft.id) : [];
  }, [processDraft, workflow]);

  const onGoalChange = useCallback(
    (value: string, cursor: number) => {
      setProcessDraft((current) => (current ? { ...current, goal_md: value } : current));
      setGoalCursor(cursor);
      setSuggestOpen(cursor > 0 && value[cursor - 1] === "/");
    },
    [setProcessDraft]
  );

  const insertArtifactToken = useCallback(
    (artifact: ArtifactNode) => {
      if (!processDraft) {
        return;
      }
      const before = processDraft.goal_md.slice(0, Math.max(goalCursor - 1, 0));
      const after = processDraft.goal_md.slice(goalCursor);
      const token = `{${artifactDisplayLabel(artifact, goalArtifacts)}}`;
      const next = `${before}${token}${after}`;
      setProcessDraft((current) => (current ? { ...current, goal_md: next } : current));
      setSuggestOpen(false);
      window.setTimeout(() => {
        const position = before.length + token.length;
        goalRef.current?.setSelectionRange(position, position);
        goalRef.current?.focus();
      }, 0);
    },
    [goalArtifacts, goalCursor, processDraft, setProcessDraft]
  );

  return {
    goalArtifacts,
    goalRef,
    insertArtifactToken,
    onGoalChange,
    suggestOpen
  };
}
