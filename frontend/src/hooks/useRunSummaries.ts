import { useMemo } from "react";
import type { CostSummary, RunDetail, RunSummary, Workflow } from "../types";

function totalUsage(run: RunDetail | null): CostSummary {
  return (run?.token_usage ?? []).reduce(
    (acc, item) => ({
      input_tokens: acc.input_tokens + item.input_tokens,
      output_tokens: acc.output_tokens + item.output_tokens,
      cache_read: acc.cache_read + item.cache_read,
      cache_write: acc.cache_write + item.cache_write,
      cost_usd: acc.cost_usd + item.cost_usd
    }),
    { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
  );
}

export function useRunSummaries(workflow: Workflow | null, selectedRun: RunDetail | null) {
  const usage = useMemo(() => totalUsage(selectedRun), [selectedRun]);
  const runProcessSummaries = useMemo(
    () =>
      (workflow?.processes ?? []).map((process) => {
        const runs = [...process.runs].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
        const latestRun: RunSummary | undefined = runs[0];
        const totalCost = runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
        return { process, runs, latestRun, totalCost };
      }),
    [workflow]
  );
  const workflowRunCost = useMemo(
    () => runProcessSummaries.reduce((sum, item) => sum + item.totalCost, 0),
    [runProcessSummaries]
  );

  return { runProcessSummaries, usage, workflowRunCost };
}
