import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { normalizeGoalForDisplay } from "../lib/goal";
import { artifactPayload, processPayload } from "../lib/payloads";
import { skillKey } from "../lib/skills";
import { artifactsConnectedToProcess } from "../lib/workflow";
import type { ArtifactNode, ProcessNode, RunDetail, SkillCandidate, Workflow } from "../types";

type UseDraftsArgs = {
  explicitRunSelectionRef: MutableRefObject<string>;
  loadWorkflow: (id: string) => Promise<Workflow>;
  selectedArtifact: ArtifactNode | null;
  selectedArtifactHasProducer: boolean;
  selectedArtifactId: string;
  selectedProcess: ProcessNode | null;
  selectedProcessId: string;
  setError: (message: string) => void;
  setRunDiffPair: (baseId: string, targetId: string) => void;
  setSelectedRun: Dispatch<SetStateAction<RunDetail | null>>;
  workflow: Workflow | null;
  workflowIdRef: MutableRefObject<string | null>;
};

export function useDrafts({
  explicitRunSelectionRef,
  loadWorkflow,
  selectedArtifact,
  selectedArtifactHasProducer,
  selectedArtifactId,
  selectedProcess,
  selectedProcessId,
  setError,
  setRunDiffPair,
  setSelectedRun,
  workflow,
  workflowIdRef
}: UseDraftsArgs) {
  const [processDraft, setProcessDraft] = useState<ProcessNode | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<ArtifactNode | null>(null);
  const [agentsBase, setAgentsBase] = useState("");
  const savedProcessRef = useRef<string>("");
  const savedArtifactRef = useRef<string>("");
  const processSaveSeqRef = useRef(0);
  const artifactSaveSeqRef = useRef(0);
  const processSaveAbortRef = useRef<AbortController | null>(null);
  const artifactSaveAbortRef = useRef<AbortController | null>(null);

  // Load a process draft only when the selected process identity changes.
  useEffect(() => {
    if (!selectedProcessId) {
      setProcessDraft(null);
      savedProcessRef.current = "";
      setAgentsBase("");
      setSelectedRun(null);
      return;
    }
    if (!selectedProcess) {
      setProcessDraft(null);
      savedProcessRef.current = "";
      setAgentsBase("");
      setSelectedRun(null);
      return;
    }
    const draft = structuredClone(selectedProcess);
    const connectedArtifacts = artifactsConnectedToProcess(workflow, selectedProcess.id);
    draft.goal_md = normalizeGoalForDisplay(draft.goal_md, connectedArtifacts);
    setProcessDraft(draft);
    savedProcessRef.current = JSON.stringify(processPayload(draft, connectedArtifacts));
    setRunDiffPair(selectedProcess.runs?.[1]?.id ?? "", selectedProcess.runs?.[0]?.id ?? "");
    api
      .getAgentsBase(selectedProcess.template_id || "base")
      .then((res) => setAgentsBase(res.content))
      .catch(() => setAgentsBase(""));
    const explicitRunId = explicitRunSelectionRef.current;
    const runToLoad = explicitRunId
      ? selectedProcess.runs?.find((run) => run.id === explicitRunId)
      : selectedProcess.runs?.[0];
    if (runToLoad) {
      explicitRunSelectionRef.current = "";
      void api
        .getRun(runToLoad.id)
        .then(setSelectedRun)
        .catch((exc) => setError(String(exc)));
    } else {
      setSelectedRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProcessId, selectedProcess?.id]);

  useEffect(() => {
    if (!selectedArtifactId) {
      setArtifactDraft(null);
      savedArtifactRef.current = "";
      return;
    }
    if (!selectedArtifact) {
      setArtifactDraft(null);
      savedArtifactRef.current = "";
      return;
    }
    const draft = structuredClone(selectedArtifact);
    setArtifactDraft(draft);
    savedArtifactRef.current = JSON.stringify(artifactPayload(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, selectedArtifact?.id]);

  useEffect(() => {
    if (!processDraft) {
      return;
    }
    const connectedArtifacts = artifactsConnectedToProcess(workflow, processDraft.id);
    const payload = processPayload(processDraft, connectedArtifacts);
    const serialized = JSON.stringify(payload);
    if (serialized === savedProcessRef.current) {
      return;
    }
    processSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++processSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateProcessConfig(processDraft.id, payload, { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== processSaveSeqRef.current) {
            return undefined;
          }
          savedProcessRef.current = serialized;
          if (workflowIdRef.current) {
            return loadWorkflow(workflowIdRef.current);
          }
          return undefined;
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [loadWorkflow, processDraft, setError, workflow, workflowIdRef]);

  useEffect(() => {
    if (!artifactDraft) {
      return;
    }
    const serialized = JSON.stringify(artifactPayload(artifactDraft));
    if (serialized === savedArtifactRef.current) {
      return;
    }
    artifactSaveAbortRef.current?.abort();
    const controller = new AbortController();
    const saveSeq = ++artifactSaveSeqRef.current;
    const timer = window.setTimeout(() => {
      void api
        .updateArtifact(artifactDraft.id, artifactPayload(artifactDraft), { signal: controller.signal })
        .then(() => {
          if (controller.signal.aborted || saveSeq !== artifactSaveSeqRef.current) {
            return undefined;
          }
          savedArtifactRef.current = serialized;
          if (workflowIdRef.current) {
            return loadWorkflow(workflowIdRef.current);
          }
          return undefined;
        })
        .catch((exc) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(String(exc));
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [artifactDraft, loadWorkflow, setError, workflowIdRef]);

  const updateProcessDraft = useCallback(<K extends keyof ProcessNode>(key: K, value: ProcessNode[K]) => {
    setProcessDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const updateArtifactDraft = useCallback(<K extends keyof ArtifactNode>(key: K, value: ArtifactNode[K]) => {
    setArtifactDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const saveProcess = useCallback(async () => {
    if (!processDraft || !workflow) {
      return;
    }
    processSaveAbortRef.current?.abort();
    const payload = processPayload(processDraft, artifactsConnectedToProcess(workflow, processDraft.id));
    ++processSaveSeqRef.current;
    savedProcessRef.current = JSON.stringify(payload);
    await api.updateProcessConfig(processDraft.id, payload);
    await loadWorkflow(workflow.id);
  }, [loadWorkflow, processDraft, workflow]);

  const saveArtifact = useCallback(async () => {
    if (!artifactDraft || !workflow) {
      return;
    }
    artifactSaveAbortRef.current?.abort();
    const payload = artifactPayload(artifactDraft);
    ++artifactSaveSeqRef.current;
    savedArtifactRef.current = JSON.stringify(payload);
    await api.updateArtifact(artifactDraft.id, payload);
    await loadWorkflow(workflow.id);
  }, [artifactDraft, loadWorkflow, workflow]);

  const uploadArtifactSourceFile = useCallback(
    async (file: File | null) => {
      if (!file || !artifactDraft || artifactDraft.type !== "file" || selectedArtifactHasProducer) {
        return;
      }
      try {
        const updated = await api.uploadArtifactSourceFile(artifactDraft.id, file);
        setArtifactDraft(updated);
        savedArtifactRef.current = JSON.stringify(artifactPayload(updated));
        if (workflow) {
          await loadWorkflow(workflow.id);
        }
      } catch (exc) {
        setError(String(exc));
      }
    },
    [artifactDraft, loadWorkflow, selectedArtifactHasProducer, setError, workflow]
  );

  const toggleSkill = useCallback((skill: SkillCandidate, checked: boolean) => {
    setProcessDraft((current) => {
      if (!current) {
        return current;
      }
      const existing = current.skills.filter((item) => `${item.skill_source}:${item.skill_ref}` !== skillKey(skill));
      if (!checked) {
        return { ...current, skills: existing };
      }
      return {
        ...current,
        skills: [
          ...existing,
          {
            skill_name: skill.name,
            skill_source: skill.skill_source,
            skill_ref: skill.skill_ref
          }
        ]
      };
    });
  }, []);

  return {
    agentsBase,
    artifactDraft,
    processDraft,
    saveArtifact,
    saveProcess,
    setArtifactDraft,
    setProcessDraft,
    toggleSkill,
    updateArtifactDraft,
    updateProcessDraft,
    uploadArtifactSourceFile
  };
}
