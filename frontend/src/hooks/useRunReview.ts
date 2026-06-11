import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RunDetail, RunSummary, Workflow } from "../types";

type UseRunReviewArgs = {
  loadWorkflow: (id: string) => Promise<Workflow>;
  processRuns: RunSummary[];
  selectedRun: RunDetail | null;
  setError: (message: string) => void;
  setSelectedRun: (run: RunDetail | null) => void;
  workflowId: string | null;
};

export function useRunReview({
  loadWorkflow,
  processRuns,
  selectedRun,
  setError,
  setSelectedRun,
  workflowId
}: UseRunReviewArgs) {
  const [feedback, setFeedback] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const [versionRunId, setVersionRunId] = useState("");
  const [versionRun, setVersionRun] = useState<RunDetail | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
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

  useEffect(() => {
    if (!selectedRunId) {
      setVersionRunId("");
      setVersionRun(null);
      return;
    }
    const candidates = processRuns.filter((run) => run.id !== selectedRunId);
    setVersionRunId((current) => (candidates.some((run) => run.id === current) ? current : (candidates[0]?.id ?? "")));
  }, [processRuns, selectedRunId]);

  useEffect(() => {
    if (!versionRunId) {
      setVersionRun(null);
      return;
    }
    let cancelled = false;
    setVersionLoading(true);
    void api
      .getRun(versionRunId)
      .then((run) => {
        if (!cancelled) {
          setVersionRun(run);
        }
      })
      .catch((exc) => {
        if (!cancelled) {
          setError(String(exc));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setVersionLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setError, versionRunId]);

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

  const cancelSelectedRun = useCallback(async () => {
    if (!selectedRun || (selectedRun.status !== "running" && selectedRun.status !== "waiting_qa")) {
      return;
    }
    try {
      const result = await api.cancelRun(selectedRun.id);
      setSelectedRun(result);
      if (workflowId) {
        await loadWorkflow(workflowId);
      }
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadWorkflow, selectedRun, setError, setSelectedRun, workflowId]);

  return {
    answerQA,
    cancelSelectedRun,
    currentReview,
    feedback,
    pendingQA,
    qaAnswer,
    resumeSelectedRun,
    reviewExpanded,
    reviewRun,
    setFeedback,
    setQaAnswer,
    setReviewExpanded,
    setVersionRunId,
    versionLoading,
    versionRun,
    versionRunId
  };
}
