import type { ArtifactNode, Workflow } from "../types";

export function artifactsConnectedToProcess(workflow: Workflow | null, processId: string): ArtifactNode[] {
  if (!workflow) {
    return [];
  }
  const connectedIds = new Set(
    workflow.edges.filter((edge) => edge.process_id === processId).map((edge) => edge.artifact_id)
  );
  return workflow.artifacts.filter((artifact) => connectedIds.has(artifact.id));
}
