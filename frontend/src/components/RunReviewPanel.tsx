import { ChevronDown, ChevronRight, Check, MessageSquare, Play, RefreshCw, X } from "lucide-react";
import { artifactDownloadUrl } from "../api";
import { formatCost } from "../lib/format";
import type { ArtifactNode, CostSummary, QAItem, ReviewItem, RunDetail, RunSummary } from "../types";
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
  diffBaseId: string;
  diffTargetId: string;
  diffText: string;
  diffLoading: boolean;
  onToggleExpanded: () => void;
  onResumeRun: () => void;
  onQaAnswerChange: (value: string) => void;
  onAnswerQA: () => void;
  onFeedbackChange: (value: string) => void;
  onReview: (action: "approve" | "reject") => void;
  onDiffBaseChange: (runId: string) => void;
  onDiffTargetChange: (runId: string) => void;
  onLoadDiff: () => void;
};

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
  diffBaseId,
  diffTargetId,
  diffText,
  diffLoading,
  onToggleExpanded,
  onResumeRun,
  onQaAnswerChange,
  onAnswerQA,
  onFeedbackChange,
  onReview,
  onDiffBaseChange,
  onDiffTargetChange,
  onLoadDiff
}: RunReviewPanelProps) {
  if (!selectedRun) {
    return null;
  }

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

          <div className="panel-title compact">
            <strong>Version Diff</strong>
          </div>
          <div className="diff-controls">
            <select value={diffBaseId} onChange={(event) => onDiffBaseChange(event.target.value)}>
              <option value="">Base run</option>
              {processRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id.slice(0, 12)} ({run.status})
                </option>
              ))}
            </select>
            <select value={diffTargetId} onChange={(event) => onDiffTargetChange(event.target.value)}>
              <option value="">Target run</option>
              {processRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id.slice(0, 12)} ({run.status})
                </option>
              ))}
            </select>
            <button className="icon-text" onClick={onLoadDiff} disabled={diffLoading}>
              <RefreshCw size={15} />
              Diff
            </button>
          </div>
          {diffText && <pre className="diff-view">{diffText}</pre>}
        </>
      )}

      <div className="panel-title compact">
        <strong>Artifacts</strong>
        <span className="muted-line">{selectedRun.artifacts.length}</span>
      </div>
      {selectedRun.artifacts.length === 0 && <div className="muted-line">No artifacts submitted.</div>}
      {selectedRun.artifacts.length > 0 && (
        <div className="artifact-list">
          {selectedRun.artifacts.map((artifact) => {
            const label = artifactById.get(artifact.artifact_id)?.name ?? artifact.artifact_id.slice(0, 12);
            return (
              <div key={artifact.id} className="artifact-row">
                <span>{label}</span>
                {artifact.artifact_type === "file" && (
                  <a href={artifactDownloadUrl(selectedRun.id, artifact.artifact_id)} target="_blank" rel="noreferrer">
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
      )}
    </div>
  );
}
