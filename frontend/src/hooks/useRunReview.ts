import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { artifactContent } from "../lib/artifactContent";
import { simpleLineDiff } from "../lib/format";
import type { ArtifactNode, RunDetail, Workflow } from "../types";

type UseRunReviewArgs = {
  artifactById: Map<string, ArtifactNode>;
  loadWorkflow: (id: string) => Promise<Workflow>;
  selectedRun: RunDetail | null;
  setError: (message: string) => void;
  setSelectedRun: (run: RunDetail | null) => void;
  workflowId: string | null;
};

export function useRunReview({
  artifactById,
  loadWorkflow,
  selectedRun,
  setError,
  setSelectedRun,
  workflowId
}: UseRunReviewArgs) {
  const [feedback, setFeedback] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const [diffBaseId, setDiffBaseId] = useState("");
  const [diffTargetId, setDiffTargetId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const reviewAutoCollapseKeyRef = useRef("");

  const selectedRunId = selectedRun?.id;
  const selectedRunStatus = selectedRun?.status;
  const pendingQA = selectedRun?.qa.find((item) => item.status === "pending");
  const currentReview = selectedRun?.reviews[selectedRun.reviews.length - 1];

  useEffect(() => {
    if (!selectedRunId) {
      reviewAutoCollapseKeyRef.current = "";
      setReviewExpanded(true);
      return;
    }
    const key = `${selectedRunId}:${selectedRunStatus}`;
    if (reviewAutoCollapseKeyRef.current === key) {
      return;
    }
    reviewAutoCollapseKeyRef.current = key;
    setReviewExpanded(selectedRunStatus !== "approved");
  }, [selectedRunId, selectedRunStatus]);

  const answerQA = useCallback(async () => {
    if (!selectedRun || !pendingQA || !qaAnswer.trim()) {
      return;
    }
    await api.answerQA(pendingQA.id, qaAnswer);
    setQaAnswer("");
    setSelectedRun(await api.getRun(selectedRun.id));
  }, [pendingQA, qaAnswer, selectedRun, setSelectedRun]);

  const reviewRun = useCallback(
    async (action: "approve" | "reject") => {
      if (!selectedRun) {
        return;
      }
      const result = await api.reviewRun(selectedRun.id, action, feedback);
      setSelectedRun(result);
      setFeedback("");
      if (workflowId) {
        await loadWorkflow(workflowId);
      }
    },
    [feedback, loadWorkflow, selectedRun, setSelectedRun, workflowId]
  );

  const resumeSelectedRun = useCallback(async () => {
    if (!selectedRun || selectedRun.status !== "failed") {
      return;
    }
    const result = await api.resumeRun(selectedRun.id, feedback);
    setSelectedRun(result);
    setFeedback("");
    if (workflowId) {
      await loadWorkflow(workflowId);
    }
  }, [feedback, loadWorkflow, selectedRun, setSelectedRun, workflowId]);

  const setRunDiffPair = useCallback((baseId: string, targetId: string) => {
    setDiffBaseId(baseId);
    setDiffTargetId(targetId);
    setDiffText("");
  }, []);

  const loadRunDiff = useCallback(async () => {
    if (!diffBaseId || !diffTargetId || diffBaseId === diffTargetId) {
      setDiffText("");
      return;
    }
    setDiffLoading(true);
    try {
      const [base, target] = await Promise.all([api.getRun(diffBaseId), api.getRun(diffTargetId)]);
      const artifactIds = Array.from(
        new Set([
          ...base.artifacts.map((artifact) => artifact.artifact_id),
          ...target.artifacts.map((artifact) => artifact.artifact_id)
        ])
      );
      const sections: string[] = [];
      for (const artifactId of artifactIds) {
        const beforeArtifact = base.artifacts.find((artifact) => artifact.artifact_id === artifactId);
        const afterArtifact = target.artifacts.find((artifact) => artifact.artifact_id === artifactId);
        const before = beforeArtifact ? await artifactContent(base, beforeArtifact) : "";
        const after = afterArtifact ? await artifactContent(target, afterArtifact) : "";
        sections.push(`## ${artifactById.get(artifactId)?.name ?? artifactId}\n${simpleLineDiff(before, after)}`);
      }
      setDiffText(sections.join("\n\n"));
    } catch (exc) {
      setError(String(exc));
    } finally {
      setDiffLoading(false);
    }
  }, [artifactById, diffBaseId, diffTargetId, setError]);

  return {
    answerQA,
    currentReview,
    diffBaseId,
    diffLoading,
    diffTargetId,
    diffText,
    feedback,
    loadRunDiff,
    pendingQA,
    qaAnswer,
    resumeSelectedRun,
    reviewExpanded,
    reviewRun,
    setDiffBaseId,
    setDiffTargetId,
    setFeedback,
    setQaAnswer,
    setRunDiffPair,
    setReviewExpanded
  };
}
