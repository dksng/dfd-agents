import type { RunLog } from "../types";

export type LogCategory = "agent" | "tool" | "system" | "error";

export interface ClassifiedLog {
  id: string;
  ts: string;
  category: LogCategory;
  title: string;
  body: string;
  tool?: string;
  isError: boolean;
  raw: unknown;
}

export const LOG_FILTERS: { key: "all" | LogCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "agent", label: "Agent" },
  { key: "tool", label: "Tools" },
  { key: "system", label: "System" },
  { key: "error", label: "Errors" }
];

export function firstLine(text: string): string {
  const line = (text || "").trim().split(/\r?\n/)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}...` : line;
}

export function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  if (name === "Bash") {
    return pick("command") || pick("cmd") || pick("description");
  }
  if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") {
    return pick("file_path") || pick("path");
  }
  if (name === "Grep" || name === "Glob") {
    return pick("pattern") || pick("query");
  }
  if (name === "WebFetch") {
    return pick("url");
  }
  if (name === "Task") {
    return pick("description");
  }
  const json = JSON.stringify(input);
  return json.length > 100 ? `${json.slice(0, 100)}...` : json;
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object") {
          return (block as { text?: string }).text ?? "";
        }
        return String(block);
      })
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

export function classifyLog(log: RunLog): ClassifiedLog | null {
  const base = { id: log.id, ts: log.ts, raw: log.raw_json };
  const raw = (log.raw_json ?? {}) as Record<string, unknown>;
  const eventType = typeof raw.type === "string" ? raw.type : "";

  if (log.level === "error") {
    return { ...base, category: "error", title: log.message, body: log.message, isError: true };
  }

  const message = (raw.message ?? {}) as Record<string, unknown>;
  const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];

  if (eventType === "assistant") {
    const toolUse = content.find((block) => block?.type === "tool_use");
    if (toolUse) {
      const name = String(toolUse.name ?? "tool");
      const inputSummary = summarizeToolInput(name, toolUse.input as Record<string, unknown>);
      return {
        ...base,
        category: "tool",
        tool: name,
        title: inputSummary ? `${name}  ${inputSummary}` : name,
        body: JSON.stringify(toolUse.input ?? {}, null, 2),
        isError: false
      };
    }
    const text = content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n")
      .trim();
    if (text) {
      return { ...base, category: "agent", title: firstLine(text), body: text, isError: false };
    }
    return null;
  }

  if (eventType === "user") {
    const toolResult = content.find((block) => block?.type === "tool_result");
    if (toolResult) {
      const isError = Boolean(toolResult.is_error);
      const text = toolResultText(toolResult.content);
      return {
        ...base,
        category: isError ? "error" : "tool",
        tool: "result",
        title: `${isError ? "Tool error: " : "-> "}${firstLine(text) || "(empty)"}`,
        body: text,
        isError
      };
    }
    return null;
  }

  if (eventType === "result") {
    const text = String(raw.result ?? raw.subtype ?? log.message);
    return { ...base, category: "system", title: `result: ${firstLine(text)}`, body: text, isError: false };
  }

  if (eventType) {
    return null;
  }

  return { ...base, category: "system", title: log.message, body: log.message, isError: false };
}
