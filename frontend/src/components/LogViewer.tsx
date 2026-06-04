import { AlertTriangle, ArrowDown, Bot, ChevronDown, ChevronRight, Search, Settings, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { classifyLog, LOG_FILTERS, type ClassifiedLog, type LogCategory } from "../lib/logClassify";
import type { RunLog } from "../types";

function categoryIcon(category: LogCategory) {
  if (category === "agent") return <Bot size={14} />;
  if (category === "tool") return <Terminal size={14} />;
  if (category === "error") return <AlertTriangle size={14} />;
  return <Settings size={14} />;
}

function LogCard({ entry, showRaw }: { entry: ClassifiedLog; showRaw: boolean }) {
  const [open, setOpen] = useState(entry.isError);
  const hasBody = Boolean(entry.body && entry.body.trim()) || showRaw;
  return (
    <div className={`log-card ${entry.category}`}>
      <button className="log-card-head" onClick={() => hasBody && setOpen((value) => !value)}>
        <span className="log-cat">{categoryIcon(entry.category)}</span>
        <time>{new Date(entry.ts).toLocaleTimeString()}</time>
        <span className="log-title">{entry.title}</span>
        {hasBody && (
          <span className="log-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        )}
      </button>
      {open && hasBody && (
        <div className="log-body">
          {entry.body && entry.body.trim() && <pre>{entry.body}</pre>}
          {showRaw && <pre className="log-raw">{JSON.stringify(entry.raw, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

export function LogViewer({ logs, status }: { logs: RunLog[]; status: string }) {
  const [filter, setFilter] = useState<"all" | LogCategory>("all");
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const classified = useMemo(
    () => logs.map(classifyLog).filter((entry): entry is ClassifiedLog => entry !== null),
    [logs]
  );
  const counts = useMemo(() => {
    const values: Record<string, number> = { all: classified.length, agent: 0, tool: 0, system: 0, error: 0 };
    for (const entry of classified) {
      values[entry.category] += 1;
    }
    return values;
  }, [classified]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return classified.filter((entry) => {
      if (filter !== "all" && entry.category !== filter) return false;
      if (
        normalizedQuery &&
        !(entry.title.toLowerCase().includes(normalizedQuery) || entry.body.toLowerCase().includes(normalizedQuery))
      ) {
        return false;
      }
      return true;
    });
  }, [classified, filter, query]);

  const running = status === "running" || status === "waiting_qa" || status === "draft";
  const lastTool = useMemo(
    () => [...classified].reverse().find((entry) => entry.category === "tool" && entry.tool !== "result"),
    [classified]
  );
  const finished = status === "in_review" || status === "approved" || status === "rejected";
  const lastAgent = useMemo(() => [...classified].reverse().find((entry) => entry.category === "agent"), [classified]);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible.length, follow]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFollow(atBottom);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollow(true);
  };

  return (
    <div className="log-viewer">
      {finished && lastAgent && (
        <div className="log-pinned">
          <span className="log-pinned-label">
            <Bot size={13} /> Final agent message
          </span>
          <pre>{lastAgent.body || lastAgent.title}</pre>
        </div>
      )}
      <div className="log-toolbar">
        <div className="log-filters">
          {LOG_FILTERS.map((filterOption) => (
            <button
              key={filterOption.key}
              className={`log-filter ${filter === filterOption.key ? "active" : ""}`}
              onClick={() => setFilter(filterOption.key)}
            >
              {filterOption.label}
              <span className="log-count">{counts[filterOption.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="log-search">
          <Search size={13} />
          <input value={query} placeholder="Filter logs..." onChange={(event) => setQuery(event.target.value)} />
        </div>
        <label className="log-raw-toggle">
          <input type="checkbox" checked={showRaw} onChange={(event) => setShowRaw(event.target.checked)} />
          Raw
        </label>
      </div>

      <div className="log-cards" ref={scrollRef} onScroll={onScroll}>
        {visible.length === 0 && <div className="muted-line">No log entries.</div>}
        {visible.map((entry) => (
          <LogCard key={entry.id} entry={entry} showRaw={showRaw} />
        ))}
      </div>

      <div className="log-footer">
        {running && (
          <span className="log-running">
            <span className="dot" /> {lastTool ? `Running ${lastTool.title}` : "Running..."}
          </span>
        )}
        {!follow && (
          <button className="log-jump" onClick={jumpToLatest}>
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
