export function compactModelName(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace("-sonnet-", "-s-")
    .replace("-opus-", "-o-")
    .replace("-haiku-", "-h-");
}

export function simpleLineDiff(before: string, after: string): string {
  if (before === after) {
    return "No changes.";
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  return [
    ...beforeLines.map((line) => `- ${line}`),
    ...afterLines.map((line) => `+ ${line}`)
  ].join("\n");
}

export function sourceFileName(path: string | null | undefined): string {
  if (!path) {
    return "";
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function formatCost(value: number | null | undefined): string {
  return `$${(value ?? 0).toFixed(5)}`;
}

export function downloadJsonDocument(document: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}
