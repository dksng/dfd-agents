import { useMemo } from "react";
import type { Workflow } from "../types";

export function useSelectedWorkflowItems(
  workflow: Workflow | null,
  selectedProcessId: string,
  selectedArtifactId: string
) {
  const selectedProcess = useMemo(
    () => workflow?.processes.find((process) => process.id === selectedProcessId) ?? null,
    [selectedProcessId, workflow]
  );

  const selectedArtifact = useMemo(
    () => workflow?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null,
    [selectedArtifactId, workflow]
  );

  const selectedArtifactProducer = useMemo(
    () =>
      selectedArtifactId
        ? (workflow?.edges.find((edge) => edge.kind === "produces" && edge.artifact_id === selectedArtifactId) ?? null)
        : null,
    [selectedArtifactId, workflow]
  );

  const selectedArtifactProducerName = useMemo(
    () =>
      selectedArtifactProducer
        ? (workflow?.processes.find((process) => process.id === selectedArtifactProducer.process_id)?.name ??
          "upstream process")
        : "",
    [selectedArtifactProducer, workflow]
  );

  const artifactById = useMemo(
    () => new Map((workflow?.artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [workflow]
  );

  return {
    artifactById,
    selectedArtifact,
    selectedArtifactProducer,
    selectedArtifactProducerName,
    selectedProcess
  };
}
