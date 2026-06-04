import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { artifactContent } from "../lib/artifactContent";
import type { ArtifactValue, RunDetail, Workflow } from "../types";

type UseArtifactPreviewArgs = {
  workflow: Workflow | null;
  selectedArtifactId: string;
  setError: (message: string) => void;
};

export function useArtifactPreview({ workflow, selectedArtifactId, setError }: UseArtifactPreviewArgs) {
  const [artifactApprovedRun, setArtifactApprovedRun] = useState<RunDetail | null>(null);
  const [artifactApprovedValue, setArtifactApprovedValue] = useState<ArtifactValue | null>(null);
  const [artifactPreviewText, setArtifactPreviewText] = useState("");
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const artifactPreviewSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++artifactPreviewSeqRef.current;
    setArtifactApprovedRun(null);
    setArtifactApprovedValue(null);
    setArtifactPreviewText("");
    setArtifactPreviewLoading(false);

    if (!workflow || !selectedArtifactId) {
      return;
    }
    const producerEdge = workflow.edges.find(
      (edge) => edge.kind === "produces" && edge.artifact_id === selectedArtifactId
    );
    const producer = producerEdge ? workflow.processes.find((process) => process.id === producerEdge.process_id) : null;
    const approvedRun = producer?.runs.find((run) => run.status === "approved");
    if (!approvedRun) {
      return;
    }

    setArtifactPreviewLoading(true);
    void api
      .getRun(approvedRun.id)
      .then(async (run) => {
        if (seq !== artifactPreviewSeqRef.current) {
          return;
        }
        const value = run.artifacts.find((artifact) => artifact.artifact_id === selectedArtifactId) ?? null;
        setArtifactApprovedRun(run);
        setArtifactApprovedValue(value);
        if (!value) {
          setArtifactPreviewText("");
          return;
        }
        const content = await artifactContent(run, value);
        if (seq === artifactPreviewSeqRef.current) {
          setArtifactPreviewText(content);
        }
      })
      .catch((exc) => {
        if (seq === artifactPreviewSeqRef.current) {
          setError(String(exc));
        }
      })
      .finally(() => {
        if (seq === artifactPreviewSeqRef.current) {
          setArtifactPreviewLoading(false);
        }
      });
  }, [selectedArtifactId, setError, workflow]);

  return {
    artifactApprovedRun,
    artifactApprovedValue,
    artifactPreviewText,
    artifactPreviewLoading
  };
}
