export function StatusPill({ status }: { status?: string }) {
  const value = status || "draft";
  const labels: Record<string, string> = {
    not_started: "not started",
    stale: "needs rerun",
    upstream_pending: "upstream pending",
    waiting_qa: "waiting qa",
    source_ready: "source ready",
    source_missing: "source missing"
  };
  return <span className={`status ${value}`}>{labels[value] ?? value}</span>;
}
