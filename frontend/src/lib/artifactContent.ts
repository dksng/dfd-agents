import { artifactDownloadUrl } from "../api";
import type { ArtifactValue, RunDetail } from "../types";

export async function artifactContent(run: Pick<RunDetail, "id">, artifact: ArtifactValue): Promise<string> {
  if (artifact.artifact_type === "text") {
    return artifact.text_value ?? "";
  }
  if (artifact.artifact_type === "url") {
    return artifact.url ?? "";
  }
  const response = await fetch(artifactDownloadUrl(run.id, artifact.artifact_id));
  if (!response.ok) {
    return `[download failed: ${response.status}]`;
  }
  return response.text();
}
