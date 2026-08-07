import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Play,
  Square,
  Trash2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Thermometer,
  Hash,
  Brain,
} from "lucide-react";
import { integrations, keys, type IntegrationModel } from "../api";
import { storedKeyFor } from "../keyStore";
import { Button, Card, Skeleton, Badge, Select, Input, toast } from "../components/ui";

type Role = "system" | "user" | "assistant";

interface ChatTurn {
  id: string;
  role: Role;
  content: string;
  /** Optional reasoning trace from the model — rendered in a collapsed block. */
  reasoning?: string;
}

const DEFAULT_TURNS: ChatTurn[] = [
  { id: "system-1", role: "system", content: "You are a helpful assistant. Reply concisely." },
  { id: "user-1", role: "user", content: "Give me three short tips for writing reliable prompts." },
];

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Catalog model → single compact label (e.g. "cbc/minimax-m3"). */
function shortModelLabel(m: IntegrationModel): string {
  return m.id;
}

export default function Playground() {
  const catalog = useQuery({ queryKey: ["integrations-catalog"], queryFn: integrations.catalog });
  const keyList = useQuery({ queryKey: ["keys"], queryFn: keys.list });

  const [modelId, setModelId] = useState("");
  const [system, setSystem] = useState("You are a helpful assistant. Reply concisely.");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>(DEFAULT_TURNS);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [reasoningEffort, setReasoningEffort] = useState<"minimal" | "low" | "medium" | "high">("medium");
  const [streaming, setStreaming] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [pending, setPending] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawTrace, setRawTrace] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const models = catalog.data?.models ?? [];

  // Auto-pick the first model once the catalog loads.
  useEffect(() => {
    if (!modelId && models.length) setModelId(models[0]!.id);
  }, [models, modelId]);

  // Auto-scroll the transcript while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const activeKey = useMemo(() => {
    const first = keyList.data?.[0];
    if (!first) return null;
    return storedKeyFor(first.key_prefix);
  }, [keyList.data]);

  const selectedModel: IntegrationModel | undefined = useMemo(
    () => models.find((m) => m.id === modelId),
    [models, modelId],
  );

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
  };

  const clear = () => {
    setTurns([{ id: uid("system"), role: "system", content: system }]);
    setInput("");
    setUsage(null);
    setError(null);
    setRawTrace("");
    setLatencyMs(null);
  };

  const send = async () => {
    if (!activeKey) {
      toast("No gateway key available. Create one in Keys first.", "error");
      return;
    }
    if (!modelId) {
      toast("Select a model first.", "error");
      return;
    }
    const promptText = input.trim() || "Hello";
    const userTurn: ChatTurn = { id: uid("user"), role: "user", content: promptText };
    const assistantTurn: ChatTurn = { id: uid("assistant"), role: "assistant", content: "" };
    const nextTurns = [...turns, userTurn, assistantTurn];
    setTurns(nextTurns);
    setInput("");
    setPending(true);
    setError(null);
    setUsage(null);
    setRawTrace("");
    setLatencyMs(Date.now());

    const messages = [
      ...nextTurns
        .filter((t) => t.id !== assistantTurn.id)
        .map(({ role, content }) => ({ role, content })),
    ];

    const body: Record<string, unknown> = {
      model: modelId,
      stream: streaming,
      temperature,
      max_tokens: maxTokens,
      messages,
    };
    if (reasoningEnabled) body.reasoning = { enabled: true, effort: reasoningEffort };

    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${activeKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(errText) as { error?: { message?: string } | string };
          if (typeof parsed.error === "string") message = parsed.error;
          else if (parsed.error?.message) message = parsed.error.message;
        } catch {
          message = errText || message;
        }
        throw new Error(message);
      }

      if (!streaming) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content ?? "";
        const reasoning = json.choices?.[0]?.message?.reasoning_content;
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, content: text, reasoning: reasoning || undefined }
              : t,
          ),
        );
        setUsage(json.usage ?? null);
        setRawTrace(JSON.stringify(json, null, 2));
      } else {
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream body");
        const decoder = new TextDecoder();
        let buffer = "";
        let capturedUsage: typeof usage = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const data = dataLine.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data) as {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    reasoning_content?: string | null;
                  };
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              };
              if (chunk.usage) capturedUsage = chunk.usage;
              const choice = chunk.choices?.[0];
              const deltaContent = choice?.delta?.content ?? "";
              const deltaReasoning = choice?.delta?.reasoning_content ?? "";
              if (deltaContent || deltaReasoning) {
                setTurns((prev) =>
                  prev.map((t) =>
                    t.id === assistantTurn.id
                      ? {
                          ...t,
                          content: t.content + (deltaContent ?? ""),
                          reasoning: (t.reasoning ?? "") + (deltaReasoning ?? ""),
                        }
                      : t,
                  ),
                );
                setRawTrace((prev) => prev + data + "\n");
              }
            } catch {
              /* ignore malformed chunk */
            }
          }
        }
        setUsage(capturedUsage);
      }
      setLatencyMs(Date.now() - started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast(msg, "error");
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  };

  if (catalog.isLoading || keyList.isLoading) {
    return <Skeleton className="h-72 w-full" />;
  }
  if (catalog.isError || !catalog.data) {
    return <p className="text-danger">Unable to load the model catalog.</p>;
  }
  if (!activeKey) {
    return (
      <p className="text-danger">No gateway key available. Open the API Keys page once and rotate the key so its plaintext is stored in this browser.</p>
    );
  }

  // The page fills the viewport: the controls stay pinned, only the transcript
    // (and the details panel) scrolls internally — the page itself never grows.
    return (
    <div className="-mx-6 -mt-6 flex h-[calc(100vh-24px)] flex-col gap-2 px-6 pt-14 md:pt-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">Mirais dashboard</p>
          <h1 className="text-xl font-semibold tracking-tight">Playground</h1>
        </div>
        <Badge tone="accent">{models.length} models</Badge>
      </div>

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[1fr_280px]">
        {/* ── LEFT: chat card ────────────────────────────────────────── */}
        <Card className="flex min-h-0 flex-col gap-2 p-3">
          {/* Compact controls strip */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1">
              <label className="mb-0.5 block text-[10px] uppercase tracking-[0.18em] text-text-muted">Model</label>
              <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {models.map((m) => (
                  <option key={`${m.providerType}:${m.id}`} value={m.id}>{shortModelLabel(m)}</option>
                ))}
              </Select>
            </div>

            <div className="w-[88px]">
              <label className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                <Thermometer size={11} /> Temp
              </label>
              <Input
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
              />
            </div>

            <div className="w-[96px]">
              <label className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                <Hash size={11} /> Max tok
              </label>
              <Input
                type="number"
                min={1}
                max={32_000}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </div>

            <div className="min-w-[150px] flex-1">
              <label className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                <Brain size={11} /> Reasoning
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setReasoningEnabled((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200 ${reasoningEnabled ? "border-accent bg-accent/90" : "border-border bg-bg-raised"}`}
                  aria-label="Toggle reasoning"
                  aria-pressed={reasoningEnabled}
                >
                  <span className={`absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${reasoningEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
                <Select
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}
                  disabled={!reasoningEnabled}
                  className="flex-1"
                >
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setStreaming((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200 ${streaming ? "border-accent bg-accent/90" : "border-border bg-bg-raised"}`}
                aria-label="Toggle streaming"
                aria-pressed={streaming}
              >
                <span className={`absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${streaming ? "translate-x-5" : "translate-x-0"}`} />
              </button>
              <span className="text-[11px] text-text-muted">SSE</span>
            </div>
          </div>

          {/* Only scrollable region on the page. */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-2xl border border-border bg-bg-base/60 p-3">
            {turns.map((turn) => (
              <TurnBubble key={turn.id} turn={turn} />
            ))}
            {pending && turns[turns.length - 1]?.content === "" && (
              <p className="mt-1 text-xs text-text-muted">Thinking…</p>
            )}
          </div>

          {/* Composer pinned to the bottom */}
          <div className="flex shrink-0 items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!pending) void send();
                }
              }}
              rows={2}
              placeholder="Type a prompt… (Ctrl/⌘+Enter to send)"
              className="flex-1 rounded-xl border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <div className="flex flex-col gap-1.5">
              {pending ? (
                <Button variant="danger" size="sm" onClick={stop}><Square size={13} /> Stop</Button>
              ) : (
                <Button size="sm" onClick={() => void send()} disabled={!modelId || !input.trim()}><Play size={13} /> Send</Button>
              )}
              <Button variant="ghost" size="sm" onClick={clear}><Trash2 size={13} /> Clear</Button>
            </div>
          </div>

          {error && <p className="shrink-0 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>}
        </Card>

        {/* ── RIGHT: details panel ──────────────────────────────────── */}
        <Card className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
          <div className="flex items-center gap-2"><Sparkles size={13} className="text-accent" /><h2 className="text-sm font-semibold">Run details</h2></div>
          <dl className="grid grid-cols-2 gap-1.5 text-xs">
            <Stat label="Model" value={selectedModel ? shortModelLabel(selectedModel) : "—"} />
            <Stat label="Latency" value={latencyMs !== null ? `${latencyMs} ms` : "—"} />
            <Stat label="Prompt tok" value={usage?.prompt_tokens ?? "—"} />
            <Stat label="Completion tok" value={usage?.completion_tokens ?? "—"} />
            <Stat label="Total tok" value={usage?.total_tokens ?? "—"} />
            <Stat label="Reasoning" value={reasoningEnabled ? `on (${reasoningEffort})` : "off"} />
          </dl>

          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="mt-1 flex w-full items-center justify-between rounded-xl border border-border bg-bg-base/60 px-2 py-1.5 text-[11px] text-text-muted hover:text-text-primary"
            aria-expanded={showRaw}
          >
            <span>Raw response / SSE</span>
            {showRaw ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          {showRaw && (
            <pre className="max-h-40 overflow-y-auto rounded-xl border border-border bg-bg-base/80 p-2 font-mono text-[10px] leading-5 text-text-muted">
              {rawTrace || "Waiting for the first response…"}
            </pre>
          )}

          <details className="mt-1 rounded-xl border border-border bg-bg-base/40 px-2 py-1.5 text-[11px] text-text-muted">
            <summary className="cursor-pointer select-none">System prompt</summary>
            <textarea
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-lg border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
            />
          </details>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-base/60 px-2 py-1.5">
      <dt className="text-[9px] uppercase tracking-[0.18em] text-text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-[11px]">{value}</dd>
    </div>
  );
}

function TurnBubble({ turn }: { turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  const isUser = turn.role === "user";
  const isSystem = turn.role === "system";
  return (
    <div className={`mb-1.5 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-sm leading-6 shadow-sm ${
          isUser
            ? "bg-accent/15 text-text-primary"
            : isSystem
              ? "bg-bg-raised text-text-muted italic"
              : "bg-bg-surface text-text-primary border border-border/80"
        }`}
      >
        <div className="mb-0.5 text-[9px] uppercase tracking-[0.18em] text-text-muted">{turn.role}</div>
        <div>{turn.content || (turn.role === "assistant" ? "" : "(empty)")}</div>
        {turn.reasoning && (
          <div className="mt-1.5 rounded-lg border border-border bg-bg-base/40 p-1.5 text-[11px] text-text-muted">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center justify-between text-left"
              aria-expanded={open}
            >
              <span className="flex items-center gap-1"><Brain size={10} /> reasoning</span>
              {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
            {open && <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-5">{turn.reasoning}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}