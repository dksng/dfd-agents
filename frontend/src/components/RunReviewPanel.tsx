import { ChevronDown, ChevronRight, Check, MessageSquare, Play, X } from "lucide-react";
import { artifactDownloadUrl } from "../api";
import { formatCost } from "../lib/format";
import type { ArtifactNode, ArtifactValue, CostSummary, QAItem, ReviewItem, RunDetail, RunSummary } from "../types";
import { StatusPill } from "./StatusPill";

type RunReviewPanelProps = {
  selectedRun: RunDetail | null;
  usage: CostSummary;
  reviewExpanded: boolean;
  pendingQA: QAItem | undefined;
  currentReview: ReviewItem | undefined;
  processRuns: RunSummary[];
  artifactById: Map<string, ArtifactNode>;
  qaAnswer: string;
  feedback: string;
  versionRunId: string;
  versionRun: RunDetail | null;
  versionLoading: boolean;
  onToggleExpanded: () => void;
  onResumeRun: () => void;
  onQaAnswerChange: (value: string) => void;
  onAnswerQA: () => void;
  onFeedbackChange: (value: string) => void;
  onReview: (action: "approve" | "reject") => void;
  onVersionRunChange: (runId: string) => void;
};

function runOptionLabel(run: RunSummary | RunDetail): string {
  return `${run.id.slice(0, 12)} (${run.status})`;
}

function ArtifactRows({
  artifacts,
  artifactById,
  runId
}: {
  artifacts: ArtifactValue[];
  artifactById: Map<string, ArtifactNode>;
  runId: string;
}) {
  if (artifacts.length === 0) {
    return <div className="muted-line">No artifacts submitted.</div>;
  }
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => {
        const label = artifactById.get(artifact.artifact_id)?.name ?? artifact.artifact_id.slice(0, 12);
        return (
          <div key={artifact.id} className="artifact-row">
            <span>{label}</span>
            {artifact.artifact_type === "file" && (
              <a href={artifactDownloadUrl(runId, artifact.artifact_id)} target="_blank" rel="noreferrer">
                {artifact.file_path}
              </a>
            )}
            {artifact.artifact_type === "url" && (
              <a href={artifact.url ?? ""} target="_blank" rel="noreferrer">
                {artifact.url}
              </a>
            )}
            {artifact.artifact_type === "text" && <textarea readOnly value={artifact.text_value ?? ""} rows={3} />}
          </div>
        );
      })}
    </div>
  );
}

export function RunReviewPanel({
  selectedRun,
  usage,
  reviewExpanded,
  pendingQA,
  currentReview,
  processRuns,
  artifactById,
  qaAnswer,
  feedback,
  versionRunId,
  versionRun,
  versionLoading,
  onToggleExpanded,
  onResumeRun,
  onQaAnswerChange,
  onAnswerQA,
  onFeedbackChange,
  onReview,
  onVersionRunChange
}: RunReviewPanelProps) {
  if (!selectedRun) {
    return null;
  }
  const versionOptions = processRuns.filter((run) => run.id !== selectedRun.id);

  return (
    <div className="review-panel embedded-review">
      <div className="panel-title">
        <strong>Run Review</strong>
        <div className="button-cluster">
          <StatusPill status={selectedRun.status} />
          <button
            className="icon-button"
            title={reviewExpanded ? "Collapse review" : "Expand review"}
            onClick={onToggleExpanded}
          >
            {reviewExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
      </div>
      <div className="run-review-meta">
        <span>{selectedRun.id.slice(0, 12)}</span>
        <span>{usage.input_tokens} in</span>
        <span>{usage.output_tokens} out</span>
        <strong>{formatCost(usage.cost_usd)}</strong>
      </div>

      <div className="panel-title compact">
        <strong>Artifacts</strong>
        <span className="muted-line">{selectedRun.artifacts.length}</span>
      </div>
      <ArtifactRows artifacts={selectedRun.artifacts} artifactById={artifactById} runId={selectedRun.id} />

      {reviewExpanded && (
        <>
          {selectedRun.status === "failed" && (
            <button className="icon-text" onClick={onResumeRun}>
              <Play size={15} />
              Resume
            </button>
          )}

          {pendingQA && (
            <div className="qa-block">
              <div className="panel-title compact">
                <strong>QA</strong>
                <MessageSquare size={15} />
              </div>
              <p>{pendingQA.question_text}</p>
              <textarea value={qaAnswer} onChange={(event) => onQaAnswerChange(event.target.value)} rows={3} />
              <button className="icon-text" onClick={onAnswerQA}>
                <Check size={15} />
                Answer
              </button>
            </div>
          )}

          <div className="panel-title compact">
            <strong>Review</strong>
            {currentReview && <StatusPill status={currentReview.status} />}
          </div>
          <textarea value={feedback} onChange={(event) => onFeedbackChange(event.target.value)} rows={4} />
          <div className="button-row">
            <button
              className="icon-text"
              onClick={() => onReview("approve")}
              disabled={selectedRun.status !== "in_review"}
            >
              <Check size={15} />
              Approve
            </button>
            <button
              className="icon-text danger"
              onClick={() => onReview("reject")}
              disabled={selectedRun.status !== "in_review"}
            >
              <X size={15} />
              Reject
            </button>
          </div>

          {versionOptions.length > 0 && (
            <>
              <div className="panel-title compact">
                <strong>Old Version</strong>
              </div>
              <div className="version-controls">
                <select value={versionRunId} onChange={(event) => onVersionRunChange(event.target.value)}>
                  <option value="">Select old run</option>
                  {versionOptions.map((run) => (
                    <option key={run.id} value={run.id}>
                      {runOptionLabel(run)}
                    </option>
                  ))}
                </select>
              </div>
              {versionLoading && <div className="muted-line">Loading old version...</div>}
              {versionRun && (
                <>
                  <div className="version-meta">
                    <span>{versionRun.id.slice(0, 12)}</span>
                    <StatusPill status={versionRun.status} />
                    <span>{new Date(versionRun.started_at).toLocaleString()}</span>
                  </div>
                  <ArtifactRows
                    artifacts={versionRun.artifacts}
                    artifactById={artifactById}
                    runId={versionRun.id}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
