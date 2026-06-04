import type { ArtifactNode } from "../types";

export function artifactDisplayLabel(artifact: ArtifactNode, artifacts: ArtifactNode[]): string {
  const duplicateName = artifacts.some((item) => item.id !== artifact.id && item.name === artifact.name);
  return duplicateName ? `${artifact.name} #${artifact.id.slice(-6)}` : artifact.name;
}

export function normalizeGoalForDisplay(goal: string, artifacts: ArtifactNode[]): string {
  return goal.replace(/\{\{artifact:([^}]+)\}\}/g, (_match, id: string) => {
    const artifact = artifacts.find((item) => item.id === id);
    return artifact ? `{${artifactDisplayLabel(artifact, artifacts)}}` : `{${id}}`;
  });
}

export function normalizeGoalForStorage(goal: string, artifacts: ArtifactNode[]): string {
  const nameCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    nameCounts.set(artifact.name, (nameCounts.get(artifact.name) ?? 0) + 1);
  }
  const artifactByLabel = new Map<string, ArtifactNode>();
  const artifactByUniqueName = new Map<string, ArtifactNode>();
  for (const artifact of artifacts) {
    artifactByLabel.set(artifactDisplayLabel(artifact, artifacts), artifact);
    if ((nameCounts.get(artifact.name) ?? 0) === 1) {
      artifactByUniqueName.set(artifact.name, artifact);
    }
  }
  return goal.replace(/\{([^{}]+)\}/g, (match, label: string) => {
    const artifact = artifactByLabel.get(label) ?? artifactByUniqueName.get(label);
    return artifact ? `{{artifact:${artifact.id}}}` : match;
  });
}
