import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, wsUrl } from "../api";
import type { CostSummary, RunDetail, TokenUsage, Workflow } from "../types";

function appendUnique<T extends { id: string }>(items: T[], item: T): T[] {
  if (items.some((current) => current.id === item.id)) {
    return items;
  }
  return [...items, item];
}

type UseRunStreamArgs = {
  selectedRun: RunDetail | null;
  setSelectedRun: Dispatch<SetStateAction<RunDetail | null>>;
  setWorkflow: Dispatch<SetStateAction<Workflow | null>>;
  setCost: Dispatch<SetStateAction<CostSummary | null>>;
  workflowIdRef: RefObject<string | null>;
  loadWorkflow: (id: string) => Promise<Workflow>;
  setError: (message: string) => void;
};

export function useRunStream({
  selectedRun,
  setSelectedRun,
  setWorkflow,
  setCost,
  workflowIdRef,
  loadWorkflow,
  setError
}: UseRunStreamArgs) {
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    if (!selectedRun?.id) {
      return;
    }
    const socket = new WebSocket(wsUrl(selectedRun.id));
    socket.onopen = () => setWsConnected(true);
    socket.onclose = () => setWsConnected(false);
    socket.onerror = () => setWsConnected(false);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as { type: string; payload: Record<string, unknown> };
      if (event.type === "log") {
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                logs: appendUnique(current.logs, event.payload as unknown as RunDetail["logs"][number])
              }
            : current
        );
        return;
      }
      if (event.type === "usage") {
        const usageEvent = event.payload as unknown as TokenUsage;
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                token_usage: appendUnique(current.token_usage, usageEvent)
              }
            : current
        );
        setWorkflow((current) =>
          current
            ? {
                ...current,
                processes: current.processes.map((process) => ({
                  ...process,
                  runs: process.runs.map((run) =>
                    run.id === usageEvent.run_id
                      ? {
                          ...run,
                          input_tokens: (run.input_tokens ?? 0) + usageEvent.input_tokens,
                          output_tokens: (run.output_tokens ?? 0) + usageEvent.output_tokens,
                          cache_read: (run.cache_read ?? 0) + usageEvent.cache_read,
                          cache_write: (run.cache_write ?? 0) + usageEvent.cache_write,
                          cost_usd: (run.cost_usd ?? 0) + usageEvent.cost_usd
                        }
                      : run
                  )
                }))
              }
            : current
        );
        setCost((current) =>
          current
            ? {
                input_tokens: current.input_tokens + usageEvent.input_tokens,
                output_tokens: current.output_tokens + usageEvent.output_tokens,
                cache_read: current.cache_read + usageEvent.cache_read,
                cache_write: current.cache_write + usageEvent.cache_write,
                cost_usd: current.cost_usd + usageEvent.cost_usd
              }
            : current
        );
        return;
      }
      void api
        .getRun(selectedRun.id)
        .then(setSelectedRun)
        .catch((exc) => setError(String(exc)));
      const workflowId = workflowIdRef.current;
      if (workflowId) {
        void loadWorkflow(workflowId);
      }
    };
    return () => {
      socket.close();
      setWsConnected(false);
    };
  }, [loadWorkflow, selectedRun?.id, setCost, setError, setSelectedRun, setWorkflow, workflowIdRef]);

  useEffect(() => {
    if (!selectedRun?.id || wsConnected || !["running", "waiting_qa", "draft"].includes(selectedRun.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void api
        .getRun(selectedRun.id)
        .then(setSelectedRun)
        .catch((exc) => setError(String(exc)));
      if (workflowIdRef.current) {
        void loadWorkflow(workflowIdRef.current);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadWorkflow, selectedRun?.id, selectedRun?.status, setError, setSelectedRun, workflowIdRef, wsConnected]);

  return { wsConnected };
}
