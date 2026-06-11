import { useCallback, useEffect, useRef, useState } from "react";
import { api, eventsWsUrl } from "../api";
import type { AttentionSummary, GlobalEvent } from "../types";

const STORAGE_KEY = "orch.notify.enabled";
const EMPTY: AttentionSummary = { workflow_id: "", waiting_qa: 0, in_review: 0, failed: 0 };
const DEFAULT_NOTIFY_EVENTS = ["waiting_qa", "in_review", "failed"];
const ATTENTION_EVENTS = ["waiting_qa", "in_review", "failed"] as const;

export type NotificationPermissionState = NotificationPermission | "unsupported";
export type NotificationToast = {
  id: string;
  title: string;
  body: string;
  workflowId: string;
  runId: string;
};

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
  toasts: NotificationToast[];
  dismissToast: (id: string) => void;
};

const supported = typeof window !== "undefined" && "Notification" in window;

export function useNotifications({ resolveLabel, currentRunId, onOpen }: Args): Result {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [permission, setPermission] = useState<NotificationPermissionState>(
    supported ? Notification.permission : "unsupported"
  );
  const [attention, setAttention] = useState<Record<string, AttentionSummary>>({});
  const [notifyEvents, setNotifyEvents] = useState<string[]>(DEFAULT_NOTIFY_EVENTS);
  const [toasts, setToasts] = useState<NotificationToast[]>([]);

  // Keep the latest callbacks/values in refs so the global WS effect runs once.
  const enabledRef = useRef(enabled);
  const currentRunRef = useRef(currentRunId);
  const notifyEventsRef = useRef(notifyEvents);
  const resolveRef = useRef(resolveLabel);
  const onOpenRef = useRef(onOpen);
  const notifiedRef = useRef<Set<string>>(new Set());
  const toastTimersRef = useRef<number[]>([]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    notifyEventsRef.current = notifyEvents;
  }, [notifyEvents]);
  useEffect(() => {
    currentRunRef.current = currentRunId;
  }, [currentRunId]);
  useEffect(() => {
    resolveRef.current = resolveLabel;
  }, [resolveLabel]);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(
    () => () => {
      for (const timer of toastTimersRef.current) {
        window.clearTimeout(timer);
      }
    },
    []
  );

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

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: Omit<NotificationToast, "id">) => {
    const id = `${toast.runId}:${Date.now()}`;
    setToasts((current) => [...current, { ...toast, id }].slice(-4));
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 9000);
    toastTimersRef.current.push(timer);
  }, []);

  const fireNotification = useCallback(
    (event: GlobalEvent) => {
      if (!enabledRef.current) return;

      let status: string | null = null;
      if (event.type === "qa") status = "waiting_qa";
      else if (event.type === "status") {
        const s = (event.payload?.status as string) ?? "";
        if (s) status = s;
      }
      if (!status || !notifyEventsRef.current.includes(status)) return;

      // Only suppress the QA prompt for the run the user is actively viewing
      // (the QA panel is already on screen). Completion/failure should always
      // notify, even while watching the run, so "done" never goes unnoticed.
      if (status === "waiting_qa" && currentRunRef.current === event.run_id && document.visibilityState === "visible") {
        return;
      }

      const dedupeKey = `${event.run_id}:${status}`;
      if (notifiedRef.current.has(dedupeKey)) return;
      notifiedRef.current.add(dedupeKey);

      const label = resolveRef.current?.(event.workflow_id, event.process_id) ?? "a process";
      const titleByStatus: Record<string, string> = {
        waiting_qa: "QA needed",
        in_review: "Ready for review",
        failed: "Run failed",
        approved: "Run approved",
        rejected: "Run rejected"
      };
      const bodyByStatus: Record<string, string> = {
        waiting_qa: `${label} is waiting for your answer.`,
        in_review: `${label} was submitted for review.`,
        failed: `${label} stopped with an error.`,
        approved: `${label} was approved.`,
        rejected: `${label} was rejected.`
      };
      const title = titleByStatus[status];
      const body = bodyByStatus[status];
      if (!title || !body) return;

      // Best-effort desktop popup (may be silently suppressed by the OS, e.g.
      // Windows Focus Assist), so we cannot rely on it being shown.
      if (supported && Notification.permission === "granted") {
        try {
          const notification = new Notification(title, { body, tag: event.run_id });
          notification.onclick = () => {
            window.focus();
            onOpenRef.current?.({ workflowId: event.workflow_id, runId: event.run_id });
            notification.close();
          };
        } catch {
          /* ignore; the in-app toast below is the reliable channel */
        }
      }
      // Always show an in-app toast — reliable regardless of OS/browser settings.
      showToast({ title, body, workflowId: event.workflow_id, runId: event.run_id });
    },
    [showToast]
  );

  useEffect(() => {
    if (!supported) {
      setPermission("unsupported");
    }
    void api
      .getSettings()
      .then((settings) => {
        setNotifyEvents(settings.notify_events?.length ? settings.notify_events : DEFAULT_NOTIFY_EVENTS);
        setEnabled(Boolean(settings.notify_enabled));
        localStorage.setItem(STORAGE_KEY, settings.notify_enabled ? "1" : "0");
      })
      .catch(() => {
        /* Keep local defaults when settings are temporarily unavailable. */
      });
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

  const fireTestNotification = useCallback(() => {
    if (supported && Notification.permission === "granted") {
      try {
        const notification = new Notification("Notifications enabled", {
          body: "You'll be notified on QA, review, and failures."
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        /* ignore; toast below is the reliable confirmation */
      }
    }
    // Reliable in-app confirmation even when the OS suppresses desktop popups.
    showToast({
      title: "Notifications enabled",
      body: "QA / review / failures will appear here (and as desktop popups if your OS allows).",
      workflowId: "",
      runId: ""
    });
  }, [showToast]);

  const toggle = useCallback(() => {
    if (enabled && supported && Notification.permission !== "granted") {
      void Notification.requestPermission().then((result) => {
        setPermission(result);
        if (result === "granted") {
          fireTestNotification();
        } else {
          showToast({
            title: "Desktop notifications blocked",
            body: "Allow notifications for this site in your browser settings (and check OS Focus Assist). In-app toasts will be used meanwhile.",
            workflowId: "",
            runId: ""
          });
        }
      });
      return;
    }

    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    void api
      .updateSettings({ notify_enabled: next })
      .then((settings) => {
        setNotifyEvents(settings.notify_events?.length ? settings.notify_events : DEFAULT_NOTIFY_EVENTS);
      })
      .catch(() => {
        /* Local toggle still works for this tab. */
      });
    if (!next) return;
    if (!supported) {
      showToast({
        title: "Desktop notifications unavailable",
        body: "This browser has no notification support; in-app toasts will be used.",
        workflowId: "",
        runId: ""
      });
      return;
    }
    if (Notification.permission === "granted") {
      fireTestNotification();
      return;
    }
    // Request once (resolves immediately to "denied" if the user blocked it before).
    void Notification.requestPermission().then((result) => {
      setPermission(result);
      if (result === "granted") {
        fireTestNotification();
      } else {
        showToast({
          title: "Desktop notifications blocked",
          body: "Allow notifications for this site in your browser settings (and check OS Focus Assist). In-app toasts will be used meanwhile.",
          workflowId: "",
          runId: ""
        });
      }
    });
  }, [enabled, fireTestNotification, showToast]);

  const attentionFor = useCallback(
    (workflowId: string): AttentionSummary => {
      const source = attention[workflowId] ?? { ...EMPTY, workflow_id: workflowId };
      const visible = new Set(
        notifyEvents.filter((event) => ATTENTION_EVENTS.includes(event as (typeof ATTENTION_EVENTS)[number]))
      );
      return {
        workflow_id: workflowId,
        waiting_qa: visible.has("waiting_qa") ? source.waiting_qa : 0,
        in_review: visible.has("in_review") ? source.in_review : 0,
        failed: visible.has("failed") ? source.failed : 0
      };
    },
    [attention, notifyEvents]
  );

  return { enabled, permission, toggle, attentionFor, toasts, dismissToast };
}
