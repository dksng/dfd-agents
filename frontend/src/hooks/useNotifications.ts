import { useCallback, useEffect, useRef, useState } from "react";
import { api, eventsWsUrl } from "../api";
import type { AttentionSummary, GlobalEvent } from "../types";

const STORAGE_KEY = "orch.notify.enabled";
const EMPTY: AttentionSummary = { workflow_id: "", waiting_qa: 0, in_review: 0, failed: 0 };

export type NotificationPermissionState = NotificationPermission | "unsupported";

type Args = {
  /** Resolve a human label (e.g. process name) for the notification body. */
  resolveLabel?: (workflowId: string, processId: string) => string | undefined;
  /** Currently viewed run; notifications for it are suppressed while the tab is visible. */
  currentRunId?: string;
  /** Click handler to navigate to the run that raised the notification. */
  onOpen?: (target: { workflowId: string; runId: string }) => void;
};

type Result = {
  enabled: boolean;
  permission: NotificationPermissionState;
  toggle: () => void;
  attentionFor: (workflowId: string) => AttentionSummary;
};

const supported = typeof window !== "undefined" && "Notification" in window;

export function useNotifications({ resolveLabel, currentRunId, onOpen }: Args): Result {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (!supported) return false;
    return localStorage.getItem(STORAGE_KEY) === "1" && Notification.permission === "granted";
  });
  const [permission, setPermission] = useState<NotificationPermissionState>(
    supported ? Notification.permission : "unsupported"
  );
  const [attention, setAttention] = useState<Record<string, AttentionSummary>>({});

  // Keep the latest callbacks/values in refs so the global WS effect runs once.
  const enabledRef = useRef(enabled);
  const currentRunRef = useRef(currentRunId);
  const resolveRef = useRef(resolveLabel);
  const onOpenRef = useRef(onOpen);
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    currentRunRef.current = currentRunId;
  }, [currentRunId]);
  useEffect(() => {
    resolveRef.current = resolveLabel;
  }, [resolveLabel]);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  const refreshAttention = useCallback(async () => {
    try {
      const rows = await api.getAttention();
      const map: Record<string, AttentionSummary> = {};
      for (const row of rows) map[row.workflow_id] = row;
      setAttention(map);
    } catch {
      /* ignore transient errors */
    }
  }, []);

  const fireNotification = useCallback((event: GlobalEvent) => {
    if (!supported || !enabledRef.current || Notification.permission !== "granted") return;

    let status: "waiting_qa" | "in_review" | "failed" | null = null;
    if (event.type === "qa") status = "waiting_qa";
    else if (event.type === "status") {
      const s = (event.payload?.status as string) ?? "";
      if (s === "in_review" || s === "failed") status = s;
    }
    if (!status) return;

    // Suppress for the run the user is actively viewing in a visible tab.
    if (currentRunRef.current === event.run_id && document.visibilityState === "visible") return;

    const dedupeKey = `${event.run_id}:${status}`;
    if (notifiedRef.current.has(dedupeKey)) return;
    notifiedRef.current.add(dedupeKey);

    const label = resolveRef.current?.(event.workflow_id, event.process_id) ?? "a process";
    const title =
      status === "waiting_qa"
        ? "QA needed"
        : status === "in_review"
          ? "Ready for review"
          : "Run failed";
    const body =
      status === "waiting_qa"
        ? `${label} is waiting for your answer.`
        : status === "in_review"
          ? `${label} was submitted for review.`
          : `${label} stopped with an error.`;

    try {
      const notification = new Notification(title, { body, tag: event.run_id });
      notification.onclick = () => {
        window.focus();
        onOpenRef.current?.({ workflowId: event.workflow_id, runId: event.run_id });
        notification.close();
      };
    } catch {
      /* notification construction can throw on some browsers; ignore */
    }
  }, []);

  // Single global events WebSocket (cross-workflow) + initial attention load.
  useEffect(() => {
    void refreshAttention();
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let closed = false;
    let pending: number | null = null;

    const scheduleRefresh = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = null;
        void refreshAttention();
      }, 300);
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
        // Any QA/status transition can change the attention backlog.
        if (event.type === "status" || event.type.startsWith("qa")) {
          scheduleRefresh();
        }
        fireNotification(event);
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
  }, [refreshAttention, fireNotification]);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (enabled) {
      setEnabled(false);
      localStorage.setItem(STORAGE_KEY, "0");
      return;
    }
    if (Notification.permission === "granted") {
      setEnabled(true);
      localStorage.setItem(STORAGE_KEY, "1");
      return;
    }
    void Notification.requestPermission().then((result) => {
      setPermission(result);
      if (result === "granted") {
        setEnabled(true);
        localStorage.setItem(STORAGE_KEY, "1");
      }
    });
  }, [enabled]);

  const attentionFor = useCallback(
    (workflowId: string): AttentionSummary => attention[workflowId] ?? { ...EMPTY, workflow_id: workflowId },
    [attention]
  );

  return { enabled, permission, toggle, attentionFor };
}
