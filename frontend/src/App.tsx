import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node
} from "@xyflow/react";
import {
  Check,
  Download,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, artifactDownloadUrl, wsUrl } from "./api";
import type {
  ArtifactValue,
  ArtifactPort,
  ArtifactType,
  CostSummary,
  ProcessNode,
  RunDetail,
  SkillCandidate,
  Workflow
} from "./types";

type ProcessNodeData = {
  process: ProcessNode;
  selected: boolean;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
};

function StatusPill({ status }: { status?: string }) {
  return <span className={`status ${status || "draft"}`}>{status || "draft"}</span>;
}

function ProcessFlowNode({ data }: { data: ProcessNodeData }) {
  const inputs = data.process.ports.filter((port) => port.direction === "in");
  const outputs = data.process.ports.filter((port) => port.direction === "out");
  const latest = data.process.runs?.[0];

  return (
    <div
      className={`flow-node ${data.selected ? "selected" : ""}`}
      onClick={() => data.onSelect(data.process.id)}
    >
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: `${28 + index * 22}px` }}
        />
      ))}
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: `${28 + index * 22}px` }}
        />
      ))}
      <div className="node-topline">
        <strong>{data.process.name}</strong>
        <button
          className="icon-button"
          title="Run"
          onClick={(event) => {
            event.stopPropagation();
            data.onRun(data.process.id);
          }}
        >
          <Play size={15} />
        </button>
      </div>
      <div className="node-meta">
        <span>{data.process.type}</span>
        <StatusPill status={latest?.status} />
      </div>
      <div className="node-ports">
        <div>
          {inputs.map((port) => (
            <span key={port.id}>{port.artifact_name}</span>
          ))}
        </div>
        <div>
          {outputs.map((port) => (
            <span key={port.id}>{port.artifact_name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { process: ProcessFlowNode };

function blankPort(direction: "in" | "out"): ArtifactPort {
  return {
    id: "",
    process_id: "",
    direction,
    artifact_name: direction === "in" ? "input" : "output",
    artifact_type: "text",
    spec_json: {}
  };
}

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

function appendUnique<T extends { id: string }>(items: T[], item: T): T[] {
  if (items.some((current) => current.id === item.id)) {
    return items;
  }
  return [...items, item];
}

function skillKey(skill: Pick<SkillCandidate, "skill_source" | "skill_ref">): string {
  return `${skill.skill_source}:${skill.skill_ref}`;
}

function simpleLineDiff(before: string, after: string): string {
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

export function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [draft, setDraft] = useState<ProcessNode | null>(null);
  const [skills, setSkills] = useState<SkillCandidate[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [feedback, setFeedback] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [diffBaseId, setDiffBaseId] = useState("");
  const [diffTargetId, setDiffTargetId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [goalCursor, setGoalCursor] = useState(0);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const workflowIdRef = useRef<string | null>(null);

  const loadWorkflow = useCallback(async (id: string) => {
    const data = await api.getWorkflow(id);
    setWorkflow(data);
    setCost(await api.workflowCost(id));
    return data;
  }, []);

  const loadInitial = useCallback(async () => {
    try {
      let list = await api.listWorkflows();
      if (list.length === 0) {
        const created = await api.createWorkflow("Default Workflow");
        list = [created];
      }
      setWorkflows(list);
      const full = await loadWorkflow(list[0].id);
      setSelectedProcessId(full.processes[0]?.id ?? "");
      const skillResponse = await api.listSkills(false);
      setSkills(skillResponse.skills);
    } catch (exc) {
      setError(String(exc));
    }
  }, [loadWorkflow]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    workflowIdRef.current = workflow?.id ?? null;
  }, [workflow?.id]);

  const selectedProcess = useMemo(
    () => workflow?.processes.find((process) => process.id === selectedProcessId) ?? null,
    [selectedProcessId, workflow]
  );

  useEffect(() => {
    setDraft(selectedProcess ? structuredClone(selectedProcess) : null);
    const latestRun = selectedProcess?.runs?.[0];
    setDiffBaseId(selectedProcess?.runs?.[1]?.id ?? "");
    setDiffTargetId(selectedProcess?.runs?.[0]?.id ?? "");
    setDiffText("");
    if (latestRun) {
      void api.getRun(latestRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
    } else {
      setSelectedRun(null);
    }
  }, [selectedProcess]);

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
                logs: appendUnique(
                  current.logs,
                  event.payload as unknown as RunDetail["logs"][number]
                )
              }
            : current
        );
        return;
      }
      if (event.type === "usage") {
        setSelectedRun((current) =>
          current && current.id === selectedRun.id
            ? {
                ...current,
                token_usage: appendUnique(
                  current.token_usage,
                  event.payload as unknown as RunDetail["token_usage"][number]
                )
              }
            : current
        );
        return;
      }
      void api.getRun(selectedRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
      const workflowId = workflowIdRef.current;
      if (workflowId) {
        void loadWorkflow(workflowId);
      }
    };
    return () => {
      socket.close();
      setWsConnected(false);
    };
  }, [loadWorkflow, selectedRun?.id]);

  useEffect(() => {
    if (
      !selectedRun?.id ||
      wsConnected ||
      !["running", "waiting_qa", "draft"].includes(selectedRun.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api.getRun(selectedRun.id).then(setSelectedRun).catch((exc) => setError(String(exc)));
      if (workflowIdRef.current) {
        void loadWorkflow(workflowIdRef.current);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadWorkflow, selectedRun?.id, selectedRun?.status, wsConnected]);

  const nodes = useMemo<Node<ProcessNodeData>[]>(
    () =>
      (workflow?.processes ?? []).map((process) => ({
        id: process.id,
        type: "process",
        position: { x: process.pos_x, y: process.pos_y },
        data: {
          process,
          selected: process.id === selectedProcessId,
          onSelect: setSelectedProcessId,
          onRun: (id: string) => void runProcess(id)
        }
      })),
    [selectedProcessId, workflow]
  );

  const edges = useMemo<Edge[]>(
    () =>
      (workflow?.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.from_process_id,
        target: edge.to_process_id,
        sourceHandle: edge.from_port_id,
        targetHandle: edge.to_port_id,
        markerEnd: { type: MarkerType.ArrowClosed },
        className: "workflow-edge"
      })),
    [workflow]
  );

  async function addProcess() {
    if (!workflow) {
      return;
    }
    const created = await api.createProcess(workflow.id, {
      name: `Process ${workflow.processes.length + 1}`,
      type: "implement",
      pos_x: 140 + workflow.processes.length * 40,
      pos_y: 140 + workflow.processes.length * 36
    });
    await loadWorkflow(workflow.id);
    setSelectedProcessId(created.id);
  }

  async function saveProcess() {
    if (!draft || !workflow) {
      return;
    }
    const payload = {
      name: draft.name,
      type: draft.type,
      agent_kind: draft.agent_kind,
      agent_model: draft.agent_model,
      goal_md: draft.goal_md,
      template_id: draft.template_id,
      agents_md_append: draft.agents_md_append,
      execution_mode: draft.execution_mode,
      pos_x: draft.pos_x,
      pos_y: draft.pos_y,
      ports: draft.ports.map((port) => ({
        id: port.id || undefined,
        direction: port.direction,
        artifact_name: port.artifact_name,
        artifact_type: port.artifact_type,
        spec_json: port.spec_json ?? {}
      })),
      skills: draft.skills
    };
    await api.updateProcessConfig(draft.id, payload);
    await loadWorkflow(workflow.id);
  }

  async function runProcess(processId: string) {
    const run = await api.runProcess(processId);
    setSelectedRun(run);
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function deleteSelectedProcess() {
    if (!draft || !workflow) {
      return;
    }
    await api.deleteProcess(draft.id);
    setSelectedProcessId("");
    await loadWorkflow(workflow.id);
  }

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!workflow || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
        return;
      }
      await api.createEdge(workflow.id, {
        from_process_id: connection.source,
        from_port_id: connection.sourceHandle,
        to_process_id: connection.target,
        to_port_id: connection.targetHandle
      });
      await loadWorkflow(workflow.id);
    },
    [loadWorkflow, workflow]
  );

  async function updateNodePosition(nodeId: string, x: number, y: number) {
    if (!workflow) {
      return;
    }
    await api.updateProcessConfig(nodeId, { pos_x: x, pos_y: y });
    await loadWorkflow(workflow.id);
  }

  function updateDraft<K extends keyof ProcessNode>(key: K, value: ProcessNode[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function updatePort(index: number, patch: Partial<ArtifactPort>) {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const ports = current.ports.map((port, portIndex) =>
        portIndex === index ? { ...port, ...patch } : port
      );
      return { ...current, ports };
    });
  }

  function addPort(direction: "in" | "out") {
    setDraft((current) =>
      current
        ? {
            ...current,
            ports: [...current.ports, { ...blankPort(direction), process_id: current.id }]
          }
        : current
    );
  }

  function removePort(index: number) {
    setDraft((current) =>
      current
        ? { ...current, ports: current.ports.filter((_, portIndex) => portIndex !== index) }
        : current
    );
  }

  function toggleSkill(skill: SkillCandidate, checked: boolean) {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const existing = current.skills.filter(
        (item) => `${item.skill_source}:${item.skill_ref}` !== skillKey(skill)
      );
      if (!checked) {
        return { ...current, skills: existing };
      }
      return {
        ...current,
        skills: [
          ...existing,
          {
            skill_name: skill.name,
            skill_source: skill.skill_source,
            skill_ref: skill.skill_ref
          }
        ]
      };
    });
  }

  function onGoalChange(value: string, cursor: number) {
    updateDraft("goal_md", value);
    setGoalCursor(cursor);
    setSuggestOpen(cursor > 0 && value[cursor - 1] === "/");
  }

  function insertArtifactToken(port: ArtifactPort) {
    if (!draft) {
      return;
    }
    const before = draft.goal_md.slice(0, Math.max(goalCursor - 1, 0));
    const after = draft.goal_md.slice(goalCursor);
    const token = `{{artifact:${port.id}}}`;
    const next = `${before}${token}${after}`;
    updateDraft("goal_md", next);
    setSuggestOpen(false);
    window.setTimeout(() => {
      const position = before.length + token.length;
      goalRef.current?.setSelectionRange(position, position);
      goalRef.current?.focus();
    }, 0);
  }

  async function answerQA() {
    const pending = selectedRun?.qa.find((item) => item.status === "pending");
    if (!pending || !qaAnswer.trim()) {
      return;
    }
    await api.answerQA(pending.id, qaAnswer);
    setQaAnswer("");
    setSelectedRun(await api.getRun(selectedRun!.id));
  }

  async function review(action: "approve" | "reject") {
    if (!selectedRun) {
      return;
    }
    const result = await api.reviewRun(selectedRun.id, action, feedback);
    setSelectedRun(result);
    setFeedback("");
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function resumeSelectedRun() {
    if (!selectedRun || selectedRun.status !== "failed") {
      return;
    }
    const result = await api.resumeRun(selectedRun.id, feedback);
    setSelectedRun(result);
    setFeedback("");
    if (workflow) {
      await loadWorkflow(workflow.id);
    }
  }

  async function artifactContent(run: RunDetail, artifact: ArtifactValue): Promise<string> {
    if (artifact.artifact_type === "text") {
      return artifact.text_value ?? "";
    }
    if (artifact.artifact_type === "url") {
      return artifact.url ?? "";
    }
    const response = await fetch(artifactDownloadUrl(run.id, artifact.port_id));
    if (!response.ok) {
      return `[download failed: ${response.status}]`;
    }
    return response.text();
  }

  async function loadRunDiff() {
    if (!diffBaseId || !diffTargetId || diffBaseId === diffTargetId) {
      setDiffText("");
      return;
    }
    setDiffLoading(true);
    try {
      const [base, target] = await Promise.all([api.getRun(diffBaseId), api.getRun(diffTargetId)]);
      const portNames = new Map((selectedProcess?.ports ?? []).map((port) => [port.id, port.artifact_name]));
      const portIds = Array.from(new Set([
        ...base.artifacts.map((artifact) => artifact.port_id),
        ...target.artifacts.map((artifact) => artifact.port_id)
      ]));
      const sections: string[] = [];
      for (const portId of portIds) {
        const beforeArtifact = base.artifacts.find((artifact) => artifact.port_id === portId);
        const afterArtifact = target.artifacts.find((artifact) => artifact.port_id === portId);
        const before = beforeArtifact ? await artifactContent(base, beforeArtifact) : "";
        const after = afterArtifact ? await artifactContent(target, afterArtifact) : "";
        sections.push(`## ${portNames.get(portId) ?? portId}\n${simpleLineDiff(before, after)}`);
      }
      setDiffText(sections.join("\n\n"));
    } catch (exc) {
      setError(String(exc));
    } finally {
      setDiffLoading(false);
    }
  }

  const usage = totalUsage(selectedRun);
  const pendingQA = selectedRun?.qa.find((item) => item.status === "pending");
  const currentReview = selectedRun?.reviews[selectedRun.reviews.length - 1];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DFD</span>
          <strong>Agent Process Orchestrator</strong>
        </div>
        <select
          value={workflow?.id ?? ""}
          onChange={async (event) => {
            const full = await loadWorkflow(event.target.value);
            setSelectedProcessId(full.processes[0]?.id ?? "");
          }}
        >
          {workflows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="icon-text" onClick={() => void api.createWorkflow("New Workflow").then((wf) => {
          setWorkflows((items) => [wf, ...items]);
          return loadWorkflow(wf.id);
        })}>
          <Plus size={16} />
          Workflow
        </button>
        <div className="cost-strip">
          <span>{cost?.input_tokens ?? 0} in</span>
          <span>{cost?.output_tokens ?? 0} out</span>
          <strong>${(cost?.cost_usd ?? 0).toFixed(5)}</strong>
        </div>
      </header>

      {error && (
        <div className="error-line">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="left-panel">
          <div className="panel-title">
            <strong>Processes</strong>
            <button className="icon-button" onClick={() => void addProcess()} title="Add process">
              <Plus size={16} />
            </button>
          </div>
          <div className="run-list">
            {(workflow?.processes ?? []).map((process) => (
              <button
                key={process.id}
                className={`run-row ${process.id === selectedProcessId ? "active" : ""}`}
                onClick={() => setSelectedProcessId(process.id)}
              >
                <span>{process.name}</span>
                <StatusPill status={process.runs[0]?.status} />
              </button>
            ))}
          </div>

          <div className="panel-title">
            <strong>Runs</strong>
            <button
              className="icon-button"
              title="Refresh"
              onClick={() => workflow && void loadWorkflow(workflow.id)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="run-list">
            {(selectedProcess?.runs ?? []).map((run) => (
              <button
                key={run.id}
                className={`run-row ${run.id === selectedRun?.id ? "active" : ""}`}
                onClick={() => void api.getRun(run.id).then(setSelectedRun)}
              >
                <span>{run.id.slice(0, 12)}</span>
                <StatusPill status={run.status} />
              </button>
            ))}
          </div>
        </aside>

        <section className="canvas-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onConnect={onConnect}
            onEdgeDoubleClick={(_, edge) => {
              if (workflow) {
                void api.deleteEdge(edge.id).then(() => loadWorkflow(workflow.id));
              }
            }}
            onNodeDragStop={(_, node) =>
              void updateNodePosition(node.id, node.position.x, node.position.y)
            }
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </section>

        <aside className="right-panel">
          {draft ? (
            <>
              <div className="panel-title">
                <strong>Process</strong>
                <div className="button-cluster">
                  <button className="icon-button" title="Run" onClick={() => void runProcess(draft.id)}>
                    <Play size={16} />
                  </button>
                  <button className="icon-button" title="Save" onClick={() => void saveProcess()}>
                    <Save size={16} />
                  </button>
                  <button className="icon-button danger" title="Delete" onClick={() => void deleteSelectedProcess()}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <label>
                Name
                <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
              </label>
              <div className="two-col">
                <label>
                  Type
                  <select value={draft.type} onChange={(event) => updateDraft("type", event.target.value)}>
                    <option value="design">design</option>
                    <option value="implement">implement</option>
                    <option value="evaluate">evaluate</option>
                    <option value="review">review</option>
                  </select>
                </label>
                <label>
                  Agent
                  <select value={draft.agent_kind} onChange={(event) => updateDraft("agent_kind", event.target.value)}>
                    <option value="claude">claude</option>
                  </select>
                </label>
              </div>
              <label>
                Model
                <input value={draft.agent_model} onChange={(event) => updateDraft("agent_model", event.target.value)} />
              </label>

              <div className="panel-title compact">
                <strong>Artifacts</strong>
                <div className="button-cluster">
                  <button className="icon-button" title="Add input" onClick={() => addPort("in")}>
                    <Plus size={15} />
                  </button>
                  <button className="icon-button" title="Add output" onClick={() => addPort("out")}>
                    <Download size={15} />
                  </button>
                </div>
              </div>
              <div className="ports-editor">
                {draft.ports.map((port, index) => (
                  <div className="port-row" key={`${port.id}-${index}`}>
                    <select value={port.direction} onChange={(event) => updatePort(index, { direction: event.target.value as "in" | "out" })}>
                      <option value="in">in</option>
                      <option value="out">out</option>
                    </select>
                    <input value={port.artifact_name} onChange={(event) => updatePort(index, { artifact_name: event.target.value })} />
                    <select value={port.artifact_type} onChange={(event) => updatePort(index, { artifact_type: event.target.value as ArtifactType })}>
                      <option value="text">text</option>
                      <option value="file">file</option>
                      <option value="url">url</option>
                    </select>
                    <button className="icon-button" onClick={() => removePort(index)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="field-block">
                <span>Skills</span>
                <div className="skill-list">
                  {skills.length === 0 && <div className="muted-line">No skills found</div>}
                  {skills.map((skill) => {
                    const checked = draft.skills.some(
                      (item) => `${item.skill_source}:${item.skill_ref}` === skillKey(skill)
                    );
                    return (
                      <label className="skill-row" key={skillKey(skill)}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => toggleSkill(skill, event.target.checked)}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.skill_source}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="goal-box">
                <label>
                  Goal.md
                  <textarea
                    ref={goalRef}
                    value={draft.goal_md}
                    onChange={(event) => onGoalChange(event.target.value, event.target.selectionStart)}
                    onKeyUp={(event) => onGoalChange(event.currentTarget.value, event.currentTarget.selectionStart)}
                    rows={8}
                  />
                </label>
                {suggestOpen && (
                  <div className="suggest-list">
                    {draft.ports.map((port) => (
                      <button key={port.id || port.artifact_name} onClick={() => insertArtifactToken(port)}>
                        {port.artifact_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <label>
                AGENTS.md Append
                <textarea
                  value={draft.agents_md_append}
                  onChange={(event) => updateDraft("agents_md_append", event.target.value)}
                  rows={5}
                />
              </label>
            </>
          ) : (
            <div className="empty-panel">No process selected</div>
          )}
        </aside>
      </main>

      <section className="bottom-panel">
        <div className="activity-head">
          <div>
            <strong>{selectedRun ? selectedRun.id : "No run selected"}</strong>
            {selectedRun && <StatusPill status={selectedRun.status} />}
          </div>
          {selectedRun?.status === "failed" && (
            <button className="icon-text" onClick={() => void resumeSelectedRun()}>
              <Play size={15} />
              Resume
            </button>
          )}
          <div className="cost-strip">
            <span>{usage.input_tokens} in</span>
            <span>{usage.output_tokens} out</span>
            <strong>${usage.cost_usd.toFixed(5)}</strong>
          </div>
        </div>

        {selectedRun && (
          <div className="activity-grid">
            <div className="log-view">
              {selectedRun.logs.map((log) => (
                <div key={log.id} className={`log-line ${log.level}`}>
                  <time>{new Date(log.ts).toLocaleTimeString()}</time>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>

            <div className="review-panel">
              {pendingQA && (
                <div className="qa-block">
                  <div className="panel-title compact">
                    <strong>QA</strong>
                    <MessageSquare size={15} />
                  </div>
                  <p>{pendingQA.question_text}</p>
                  <textarea value={qaAnswer} onChange={(event) => setQaAnswer(event.target.value)} rows={3} />
                  <button className="icon-text" onClick={() => void answerQA()}>
                    <Check size={15} />
                    Answer
                  </button>
                </div>
              )}

              <div className="panel-title compact">
                <strong>Review</strong>
                {currentReview && <StatusPill status={currentReview.status} />}
              </div>
              <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} />
              <div className="button-row">
                <button className="icon-text" onClick={() => void review("approve")}>
                  <Check size={15} />
                  Approve
                </button>
                <button className="icon-text danger" onClick={() => void review("reject")}>
                  <X size={15} />
                  Reject
                </button>
              </div>

              <button className="link-button" onClick={() => setShowArtifacts((value) => !value)}>
                Artifacts
              </button>
              {showArtifacts && (
                <div className="artifact-list">
                  {selectedRun.artifacts.map((artifact) => (
                    <div key={artifact.id} className="artifact-row">
                      <span>{artifact.port_id.slice(0, 12)}</span>
                      {artifact.artifact_type === "file" && (
                        <a href={`/api/runs/${selectedRun.id}/artifacts/${artifact.port_id}/download`}>
                          {artifact.file_path}
                        </a>
                      )}
                      {artifact.artifact_type === "url" && <a href={artifact.url ?? ""}>{artifact.url}</a>}
                      {artifact.artifact_type === "text" && <textarea readOnly value={artifact.text_value ?? ""} rows={3} />}
                    </div>
                  ))}
                </div>
              )}

              <div className="panel-title compact">
                <strong>Version Diff</strong>
              </div>
              <div className="diff-controls">
                <select value={diffBaseId} onChange={(event) => setDiffBaseId(event.target.value)}>
                  <option value="">Base run</option>
                  {(selectedProcess?.runs ?? []).map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.id.slice(0, 12)} ({run.status})
                    </option>
                  ))}
                </select>
                <select value={diffTargetId} onChange={(event) => setDiffTargetId(event.target.value)}>
                  <option value="">Target run</option>
                  {(selectedProcess?.runs ?? []).map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.id.slice(0, 12)} ({run.status})
                    </option>
                  ))}
                </select>
                <button className="icon-text" onClick={() => void loadRunDiff()} disabled={diffLoading}>
                  <RefreshCw size={15} />
                  Diff
                </button>
              </div>
              {diffText && <pre className="diff-view">{diffText}</pre>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
