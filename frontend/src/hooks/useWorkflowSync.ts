import { useEffect, useRef } from "react";
import { CLIENT_ID, eventsWsUrl } from "../api";
import type { GlobalEvent } from "../types";

type Args = {
  /** The workflow currently open on the canvas (so we only reload it when relevant). */
  workflowId?: string;
  /** Reload the open workflow's graph (nodes/edges/config). Debounced by the hook. */
  onGraphChange: () => void;
  /** Refresh the workflow list (membership/name changed elsewhere). */
  onListChange: () => void;
};

/**
 * Subscribes to graph-change events broadcast over the global WebSocket so changes
 * made by another client — a second tab, or an AI agent driving the REST API — are
 * reflected live in this GUI. Events originating from this very client are ignored
 * (the local mutation already updated the canvas), preventing self-reload loops.
 */
export function useWorkflowSync({ workflowId, onGraphChange, onListChange }: Args): void {
  const workflowIdRef = useRef(workflowId);
  const onGraphRef = useRef(onGraphChange);
  const onListRef = useRef(onListChange);
  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);
  useEffect(() => {
    onGraphRef.current = onGraphChange;
  }, [onGraphChange]);
  useEffect(() => {
    onListRef.current = onListChange;
  }, [onListChange]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let pending: number | null = null;
    let closed = false;

    const scheduleGraphReload = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = null;
        onGraphRef.current();
      }, 250);
    };

    const connect = () => {
      socket = new WebSocket(eventsWsUrl());
      socket.onmessage = (message) => {
        let event: GlobalEvent;
        try {
          event = JSON.parse(message.data) as GlobalEvent;
        } catch {
          return;
        }
        if (event.type !== "graph" || !event.action) return;
        // Ignore the echo of our own mutations — the local action already updated us.
        if (event.origin && event.origin === CLIENT_ID) return;

        if (event.action.startsWith("workflow.")) {
          onListRef.current();
          // A rename/import to the open workflow should also refresh the canvas,
          // but a delete of it is handled by the list refresh (selection clears).
          if (event.workflow_id === workflowIdRef.current && event.action !== "workflow.delete") {
            scheduleGraphReload();
          }
          return;
        }
        // process.* / artifact.* / edge.* — only matters for the open workflow.
        if (event.workflow_id === workflowIdRef.current) {
          scheduleGraphReload();
        }
      };
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
      socket.onerror = () => socket?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      if (pending) window.clearTimeout(pending);
      socket?.close();
    };
  }, []);
}
