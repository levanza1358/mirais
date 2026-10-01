import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { chats as chatApi, combos, keys, providers, type ChatParams, type ChatSessionSummary } from "../api";
import { storedKeyFor } from "../keyStore";
import { Button, Card, EmptyState, Skeleton, Slider, toast } from "../components/ui";

type Role = "user" | "assistant" | "system";

interface UiMessage {
  id: number | string;
  role: Role;
  content: string;
  inTokens?: number | null;
  outTokens?: number | null;
  cost?: number | null;
}

interface UiSession {
  id: string | null;
  title: string;
  model: string;
  system: string;
  params: ChatParams;
  messages: UiMessage[];
  updatedAt: number;
}

const DEFAULT_PARAMS: Required<Pick<ChatParams, "temperature" | "max_tokens" | "top_p" | "reasoning" | "reasoning_effort">> = {
  temperature: 1,
  max_tokens: 1024,
  top_p: 1,
  reasoning: true,
  reasoning_effort: "medium",
};

const PRESETS = [
  { title: "Explain this stack", prompt: "Explain how an OpenAI-compatible gateway routes requests across multiple providers." },
  { title: "Draft a commit message", prompt: "Write a Conventional Commits message for: added a chat playground page to the dashboard." },
  { title: "Review my approach", prompt: "I want to add streaming SSE parsing on the client. What edge cases should I handle?" },
];

const MAX_TITLE = 60;
const MAX_MESSAGES = 50;

function newLocalId(): string { return `local-${Math.random().toString(36).slice(2, 10)}`; }

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning!";
  if (h < 18) return "Good afternoon!";
  return "Good evening!";
}

function exportAsMarkdown(session: UiSession): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push("");
  for (const m of session.messages) {
    if (m.role === "system") continue;
    lines.push(`## ${m.role === "user" ? "User" : "Assistant"}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}

function totalCost(messages: UiMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.cost ?? 0), 0);
}

function totalTokens(messages: UiMessage[]): { in: number; out: number } {
  return messages.reduce(
    (acc, m) => ({ in: acc.in + (m.inTokens ?? 0), out: acc.out + (m.outTokens ?? 0) }),
    { in: 0, out: 0 },
  );
}

export default function Chat() {
  const providerList = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const keyList = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const comboList = useQuery({ queryKey: ["combos"], queryFn: combos.list });
  const qc = useQueryClient();

  const sessionList = useQuery({ queryKey: ["chats"], queryFn: () => chatApi.list() });
  const summaryList = sessionList.data?.items ?? [];

  const [model, setModel] = useState("");
  const [params, setParams] = useState<ChatParams>(DEFAULT_PARAMS);
  const [system, setSystem] = useState("");
  const [paramsOpen, setParamsOpen] = useState(false);

  const [session, setSession] = useState<UiSession>(() => ({
    id: null,
    title: "New chat",
    model: "",
    system: "",
    params: DEFAULT_PARAMS,
    messages: [],
    updatedAt: Date.now(),
  }));
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | string | null>(null);
  const [editingText, setEditingText] = useState("");

  const models = useMemo(
    () => [
      ...(comboList.data ?? []).map((c) => `combo:${c.name}`),
      ...(providerList.data ?? [])
        .filter((p) => p.enabled)
        .flatMap((p) => (p.models ?? []).filter((m) => m.enabled).map((m) => `${p.name}/${m.model_id}`))
        .sort(),
    ],
    [providerList.data, comboList.data],
  );

  useEffect(() => {
    if (!model && models.length) setModel(models[0]);
  }, [models, model]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages]);

  // Pick the first persisted session when list arrives (and nothing is loaded yet).
  useEffect(() => {
    if (session.id) return;
    if (!summaryList.length) return;
    const first = summaryList[0];
    if (!first) return;
    void openSession(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryList, session.id]);

  const firstKey = (keyList.data ?? [])[0];
  const gatewayKey = firstKey ? (firstKey.key ?? storedKeyFor(firstKey.key_prefix)) : null;

  async function openSession(summary: ChatSessionSummary): Promise<void> {
    abortRef.current?.abort();
    const full = await chatApi.get(summary.id).catch(() => null);
    if (!full) return;
    setSession({
      id: full.id,
      title: full.title,
      model: full.model,
      system: full.system ?? "",
      params: { ...DEFAULT_PARAMS, ...(full.params ?? {}) },
      messages: full.messages.map((m) => ({
        id: m.id, role: m.role, content: m.content,
        inTokens: m.in_tokens, outTokens: m.out_tokens, cost: m.cost,
      })),
      updatedAt: new Date(full.updated_at).getTime(),
    });
    setModel(full.model);
    setSystem(full.system ?? "");
    setParams({ ...DEFAULT_PARAMS, ...(full.params ?? {}) });
    setInput("");
  }

  function newChat(): void {
    abortRef.current?.abort();
    setSession({
      id: null,
      title: "New chat",
      model,
      system: "",
      params,
      messages: [],
      updatedAt: Date.now(),
    });
    setInput("");
    setEditingId(null);
  }

  function deleteSession(id: string): void {
    if (session.id === id) newChat();
    void chatApi.delete(id).then(() => qc.invalidateQueries({ queryKey: ["chats"] }));
  }

  function togglePin(id: string): void {
    const target = summaryList.find((c) => c.id === id);
    void chatApi.setPinned(id, !(target?.pinned ?? false)).then(() => qc.invalidateQueries({ queryKey: ["chats"] }));
  }

  function moveSession(id: string, direction: "up" | "down"): void {
    const list = [...summaryList];
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return;
    const swap = direction === "up" ? i - 1 : i + 1;
    if (swap < 0 || swap >= list.length) return;
    [list[i], list[swap]] = [list[swap], list[i]];
    void chatApi.reorder(list.map((c) => c.id)).then(() => qc.invalidateQueries({ queryKey: ["chats"] }));
  }

  function renameSession(id: string, title: string): void {
    const clean = cleanTitle(title);
    if (session.id === id) setSession((s) => ({ ...s, title: clean }));
    void chatApi.update(id, { title: clean }).then(() => qc.invalidateQueries({ queryKey: ["chats"] }));
  }

  function cleanTitle(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || "Untitled";
  }

  async function ensurePersisted(): Promise<string | null> {
    if (session.id) return session.id;
    const title = session.messages[0]?.content.slice(0, MAX_TITLE) ?? "New chat";
    const created = await chatApi.create({
      title,
      model: model || session.model,
      system: system || null,
      params,
    });
    setSession((s) => ({ ...s, id: created.id, model: created.model, title: created.title }));
    qc.invalidateQueries({ queryKey: ["chats"] });
    return created.id;
  }

  async function persistMessages(id: string, messages: UiMessage[]): Promise<void> {
    await chatApi.replaceMessages(id, messages.map((m) => ({
      role: m.role, content: m.content,
      in_tokens: m.inTokens ?? null,
      out_tokens: m.outTokens ?? null,
      cost: m.cost ?? null,
    })));
    qc.invalidateQueries({ queryKey: ["chats"] });
  }

  function updateMessage(id: number | string, patch: Partial<UiMessage>): void {
    setSession((s) => ({
      ...s,
      updatedAt: Date.now(),
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }

  async function send(text: string, regenerateFrom: number | null = null) {
    const prompt = text.trim();
    if (!prompt && regenerateFrom === null) return;
    if (streaming) return;
    if (!gatewayKey) return toast("No gateway key — generate one on Overview", "error");
    if (!model) return toast("No enabled model available", "error");

    const sessionId = await ensurePersisted();
    if (!sessionId) return;

    const baseMessages: UiMessage[] = regenerateFrom !== null
      ? session.messages.slice(0, regenerateFrom)
      : session.messages;
    const userMsg: UiMessage = regenerateFrom !== null
      ? { ...(baseMessages[baseMessages.length - 1] ?? { id: newLocalId(), role: "user" as const, content: prompt }), content: prompt }
      : { id: newLocalId(), role: "user", content: prompt };

    let history: UiMessage[];
    if (regenerateFrom !== null) {
      history = [...baseMessages.slice(0, -1), userMsg];
    } else {
      history = [...baseMessages, userMsg];
    }
    const capped = history.length > MAX_MESSAGES ? history.slice(-MAX_MESSAGES) : history;

    setSession((s) => ({ ...s, messages: [...capped, { id: newLocalId(), role: "assistant", content: "" }], updatedAt: Date.now() }));
    setInput("");
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${gatewayKey}` },
        body: JSON.stringify({
          model,
          messages: capped.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: params.temperature ?? DEFAULT_PARAMS.temperature,
          max_tokens: params.max_tokens ?? DEFAULT_PARAMS.max_tokens,
          top_p: params.top_p ?? DEFAULT_PARAMS.top_p,
          ...(params.stop && params.stop.length ? { stop: params.stop } : {}),
          ...(system ? { system } : {}),
          ...(params.json_mode ? { response_format: { type: "json_object" } } : {}),
          reasoning: { enabled: params.reasoning ?? DEFAULT_PARAMS.reasoning, effort: params.reasoning_effort ?? DEFAULT_PARAMS.reasoning_effort },
        }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              setSession((s) => ({
                ...s,
                messages: s.messages.map((m, i) => i === s.messages.length - 1 ? { ...m, content: m.content + delta } : m),
              }));
            }
            if (chunk.usage) {
              const inT = chunk.usage.prompt_tokens ?? null;
              const outT = chunk.usage.completion_tokens ?? null;
              setSession((s) => ({
                ...s,
                messages: s.messages.map((m, i) => i === s.messages.length - 1 ? { ...m, inTokens: inT, outTokens: outT } : m),
              }));
            }
          } catch {
            /* skip non-JSON keepalives */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // user-initiated stop — keep whatever streamed so far
      } else {
        const message = (e as Error).message;
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m, i) => i === s.messages.length - 1 && !m.content ? { ...m, content: `⚠ ${message}` } : m),
        }));
        toast(message, "error");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }

    // Persist once streaming settles so we don't write on every token.
    try {
      const finalSession = await chatApi.get(sessionId).catch(() => null);
      if (!finalSession) return;
      const normalized = finalSession.messages.map((m) => ({
        id: m.id, role: m.role, content: m.content,
        inTokens: m.in_tokens, outTokens: m.out_tokens, cost: m.cost,
      }));
      setSession((s) => ({ ...s, messages: normalized, title: finalSession.title }));
      qc.invalidateQueries({ queryKey: ["chats"] });
    } catch { /* ignore — server may have failed silently */ }
  }

  async function regenerate(assistantIndex: number) {
    if (assistantIndex < 1) return;
    const userIndex = assistantIndex - 1;
    const userMsg = session.messages[userIndex];
    if (!userMsg || userMsg.role !== "user") return;
    setSession((s) => ({ ...s, messages: s.messages.slice(0, assistantIndex), updatedAt: Date.now() }));
    if (session.id) await chatApi.replaceMessages(session.id, session.messages.slice(0, assistantIndex).map((m) => ({
      role: m.role, content: m.content,
      in_tokens: m.inTokens ?? null, out_tokens: m.outTokens ?? null, cost: m.cost ?? null,
    })));
    await send(userMsg.content, assistantIndex - 1);
  }

  async function forkFrom(index: number) {
    const sessionId = await ensurePersisted();
    if (!sessionId) return;
    const userMsg = session.messages[index - 1];
    if (!userMsg) return;
    const created = await chatApi.create({
      title: userMsg.content.slice(0, MAX_TITLE) || "Fork",
      model,
      system: system || null,
      params,
    });
    await chatApi.replaceMessages(created.id, session.messages.slice(0, index - 1).map((m) => ({
      role: m.role, content: m.content,
      in_tokens: m.inTokens ?? null, out_tokens: m.outTokens ?? null, cost: m.cost ?? null,
    })));
    qc.invalidateQueries({ queryKey: ["chats"] });
    await openSession({ ...created, message_count: 0, system: system || null, params, created_at: "", updated_at: "" });
    await send(userMsg.content, index - 1);
  }

  function startEdit(id: number | string, content: string) {
    setEditingId(id);
    setEditingText(content);
  }

  async function commitEdit(id: number | string) {
    const text = editingText.trim();
    if (!text) return;
    setEditingId(null);
    updateMessage(id, { content: text });
    if (session.id) {
      const sid = session.id;
      const newMessages = session.messages.map((m) => m.id === id ? { ...m, content: text } : m);
      await persistMessages(sid, newMessages);
    }
  }

  function copyMarkdown() {
    const md = exportAsMarkdown(session);
    navigator.clipboard.writeText(md).then(
      () => toast("Copied to clipboard"),
      () => toast("Copy failed", "error"),
    );
  }

  const totalTok = totalTokens(session.messages);
  const totalCst = totalCost(session.messages);

  const composer = (
    <div className="rounded-xl border border-border bg-bg-surface">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send(input);
          }
        }}
        rows={3}
        placeholder="Ask Mirais anything…"
        className="max-h-60 w-full resize-none bg-transparent px-5 pt-5 text-base text-text-primary placeholder:text-text-muted/60 focus:outline-none"
      />
      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={newChat}
          title="New chat"
          className="rounded-full border border-border/80 p-2 text-text-muted transition-colors hover:text-text-primary"
        >
          <Plus size={16} />
        </button>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-9 w-auto max-w-64 rounded-full border border-border bg-bg-base px-3 text-xs"
        >
          {models.length ? models.map((m) => <option key={m} value={m}>{m}</option>) : <option value="">No models</option>}
        </select>
        <button
          type="button"
          onClick={() => setParamsOpen((v) => !v)}
          aria-pressed={paramsOpen}
          aria-label="Toggle playground parameters"
          className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${paramsOpen ? "border-accent/40 bg-accent/15 text-accent" : "border-border text-text-muted"}`}
        >
          <Settings2 size={14} /> Params
        </button>
        <button
          type="button"
          onClick={() => setParams((p) => ({ ...p, reasoning: !(p.reasoning ?? DEFAULT_PARAMS.reasoning) }))}
          aria-pressed={params.reasoning ?? DEFAULT_PARAMS.reasoning}
          className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${params.reasoning ?? DEFAULT_PARAMS.reasoning ? "border-accent/40 bg-accent/15 text-accent" : "border-border text-text-muted"}`}
        >
          <Brain size={14} /> Reasoning
        </button>
        {session.messages.length > 0 && (
          <button
            type="button"
            onClick={copyMarkdown}
            title="Copy session as Markdown"
            className="rounded-full p-2 text-text-muted transition-colors hover:text-text-primary"
          >
            <FileText size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={() => (streaming ? abortRef.current?.abort() : void send(input))}
          disabled={!streaming && !input.trim()}
          aria-label={streaming ? "Stop" : "Send"}
          className="ml-auto rounded-full bg-accent p-2.5 text-white transition-all hover:bg-accent/85 disabled:opacity-40"
        >
          {streaming ? <Square size={16} /> : <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  );

  const paramsDrawer = paramsOpen ? (
    <Card className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-3">
        <Slider
          label="Temperature"
          value={params.temperature ?? DEFAULT_PARAMS.temperature}
          min={0} max={2} step={0.1}
          onChange={(v) => setParams((p) => ({ ...p, temperature: v }))}
        />
        <Slider
          label="Top P"
          value={params.top_p ?? DEFAULT_PARAMS.top_p}
          min={0} max={1} step={0.05}
          onChange={(v) => setParams((p) => ({ ...p, top_p: v }))}
        />
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          <span className="flex items-center justify-between">
            <span>Max tokens</span>
            <span className="font-mono tabular-nums text-[10px] text-text-primary">{params.max_tokens ?? DEFAULT_PARAMS.max_tokens}</span>
          </span>
          <input
            type="number"
            min={1} max={32_000}
            value={params.max_tokens ?? DEFAULT_PARAMS.max_tokens}
            onChange={(e) => setParams((p) => ({ ...p, max_tokens: Math.max(1, Math.min(32_000, Number(e.target.value) || DEFAULT_PARAMS.max_tokens)) }))}
            className="h-9 rounded-lg border border-border bg-bg-base px-3 text-sm"
          />
        </label>
      </div>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          <span>Reasoning effort</span>
          <select
            className="h-9 rounded-lg border border-border bg-bg-base px-3 text-sm"
            value={params.reasoning_effort ?? DEFAULT_PARAMS.reasoning_effort}
            onChange={(e) => setParams((p) => ({ ...p, reasoning_effort: e.target.value as ChatParams["reasoning_effort"] }))}
          >
            {(["minimal", "low", "medium", "high", "xhigh"] as const).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          <span>Stop sequences (comma separated)</span>
          <input
            type="text"
            placeholder="<|end|>, STOP"
            value={(params.stop ?? []).join(", ")}
            onChange={(e) => setParams((p) => ({
              ...p,
              stop: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8),
            }))}
            className="h-9 rounded-lg border border-border bg-bg-base px-3 text-sm"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs text-text-muted">JSON mode</span>
          <input
            type="checkbox"
            checked={params.json_mode ?? false}
            onChange={(e) => setParams((p) => ({ ...p, json_mode: e.target.checked }))}
            className="h-4 w-4 accent-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          <span>System prompt</span>
          <textarea
            rows={3}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="Override the default system message for this session."
            className="rounded-lg border border-border bg-bg-base px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Card>
  ) : null;

  const headerStrip = session.messages.length > 0 ? (
    <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
      <span>
        <span className="font-mono tabular-nums text-text-primary">{totalTok.in + totalTok.out}</span> tokens
        {totalCst > 0 ? <> · <span className="font-mono tabular-nums">${totalCst.toFixed(4)}</span></> : null}
      </span>
      <span>{session.messages.length} message{session.messages.length === 1 ? "" : "s"}</span>
    </div>
  ) : null;

  const history = (
    <aside className="hidden w-60 shrink-0 flex-col gap-2 border-r border-border/60 pr-3 lg:flex">
      <Button onClick={newChat} className="justify-start">
        <Plus size={14} /> New chat
      </Button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {summaryList.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">No saved chats yet.</p>
        ) : (
          summaryList.map((c) => (
            <SessionRow
              key={c.id}
              session={c}
              active={c.id === session.id}
              onOpen={() => void openSession(c)}
              onRename={(t) => renameSession(c.id, t)}
              onDelete={() => deleteSession(c.id)}
              onTogglePin={() => togglePin(c.id)}
              onMove={(direction) => moveSession(c.id, direction)}
            />
          ))
        )}
      </div>
    </aside>
  );

  const pane =
    session.messages.length === 0 ? (
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col justify-center gap-6 py-10">
        <h1 className="text-center text-3xl font-semibold">
          {greeting()} <span className="text-text-muted">Leave the rest to me.</span>
        </h1>
        {composer}
        {paramsDrawer}
        {!gatewayKey && !keyList.isLoading ? (
          <EmptyState title="No gateway key yet" hint="Generate one from Overview → Quick connect to start chatting." />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              key={p.title}
              type="button"
              onClick={() => void send(p.prompt)}
              className="rounded-2xl border border-border/80 bg-bg-surface/70 p-4 text-left transition-colors hover:border-accent/40 hover:bg-bg-raised/70"
            >
              <p className="mb-1 text-sm font-medium">{p.title}</p>
              <p className="line-clamp-2 text-xs text-text-muted">{p.prompt}</p>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
        <div className="flex items-center gap-2">
          <input
            value={session.title}
            onChange={(e) => setSession((s) => ({ ...s, title: e.target.value }))}
            onBlur={() => session.id && session.title !== summaryList.find((c) => c.id === session.id)?.title
              ? renameSession(session.id, session.title)
              : undefined}
            className="flex-1 rounded-lg border border-border/60 bg-bg-surface px-3 py-1.5 text-sm font-medium focus:border-accent/40 focus:outline-none"
          />
        </div>
        {headerStrip}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {session.messages.map((m, i) => (
            <MessageBubble
              key={String(m.id)}
              message={m}
              index={i}
              isLast={i === session.messages.length - 1}
              streaming={streaming}
              editing={editingId === m.id}
              editingText={editingText}
              onStartEdit={() => startEdit(m.id, m.content)}
              onChangeEdit={setEditingText}
              onCommitEdit={() => void commitEdit(m.id)}
              onCancelEdit={() => setEditingId(null)}
              onRegenerate={() => void regenerate(i)}
              onFork={() => void forkFrom(i)}
            />
          ))}
        </div>
        {composer}
        {paramsDrawer}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 gap-3 md:h-[calc(100dvh-3rem)]">
      {history}
      <div className="flex min-h-0 flex-1 flex-col">{pane}</div>
    </div>
  );
}

function SessionRow({ session, active, onOpen, onRename, onDelete, onTogglePin, onMove }: {
  session: ChatSessionSummary;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  useEffect(() => setDraft(session.title), [session.title]);

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== session.title) onRename(draft);
  }

  return (
    <div className={`group flex items-center gap-1 rounded-xl px-2 py-1 transition-colors ${active ? "bg-bg-raised/80" : "hover:bg-bg-raised/50"}`}>
      <button
        type="button"
        onClick={onTogglePin}
        title={session.pinned ? "Unpin" : "Pin to top"}
        aria-pressed={session.pinned}
        className={`shrink-0 rounded-md p-1 transition-colors ${session.pinned ? "text-accent" : "text-text-muted opacity-0 group-hover:opacity-100 hover:text-accent"}`}
      >
        <Pin size={13} className={session.pinned ? "fill-accent" : ""} />
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(session.title); setEditing(false); }
          }}
          className="min-w-0 flex-1 rounded-md border border-accent/40 bg-bg-base px-2 py-1.5 text-xs"
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
          className="min-w-0 flex-1 truncate py-1.5 text-left text-xs text-text-primary"
          title={session.title}
        >
          {session.title}
        </button>
      )}
      <button
        type="button"
        onClick={() => onMove("up")}
        title="Move up"
        aria-label="Move up"
        className="rounded-lg p-1 text-text-muted opacity-0 transition-colors group-hover:opacity-100 hover:text-text-primary"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        onClick={() => onMove("down")}
        title="Move down"
        aria-label="Move down"
        className="rounded-lg p-1 text-text-muted opacity-0 transition-colors group-hover:opacity-100 hover:text-text-primary"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="rounded-lg p-1 text-text-muted opacity-0 transition-colors group-hover:opacity-100 hover:text-text-primary"
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="Delete chat"
        aria-label={`Delete ${session.title}`}
        className="rounded-lg p-1 text-text-muted opacity-0 transition-colors group-hover:opacity-100 hover:text-danger"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function MessageBubble({ message, index, isLast, streaming, editing, editingText, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit, onRegenerate, onFork }: {
  message: UiMessage;
  index: number;
  isLast: boolean;
  streaming: boolean;
  editing: boolean;
  editingText: string;
  onStartEdit: () => void;
  onChangeEdit: (s: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onRegenerate: () => void;
  onFork: () => void;
}) {
  const footer = (message.inTokens ?? 0) + (message.outTokens ?? 0) > 0 ? (
    <span className="ml-2 text-[10px] tabular-nums text-text-muted">
      ↓{message.inTokens ?? 0} ↑{message.outTokens ?? 0}
      {message.cost ? ` · $${message.cost.toFixed(4)}` : ""}
    </span>
  ) : null;

  const actions = (
    <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/bubble:opacity-100">
      {message.role === "user" && !streaming && (
        <BubbleButton title="Edit" onClick={onStartEdit}><Pencil size={12} /></BubbleButton>
      )}
      {message.role === "user" && (
        <BubbleButton title="Fork from here" onClick={onFork}><MessageSquare size={12} /></BubbleButton>
      )}
      {message.role === "assistant" && !isLast && !streaming && (
        <BubbleButton title="Regenerate" onClick={onRegenerate}><RotateCcw size={12} /></BubbleButton>
      )}
      <BubbleButton title="Copy" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={12} /></BubbleButton>
    </div>
  );

  return (
    <div className={`group/bubble ${message.role === "user" ? "flex justify-end" : ""}`}>
      <div
        className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${
          message.role === "user" ? "max-w-[80%] bg-accent/15 text-text-primary" : "w-full text-text-primary"
        }`}
      >
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={editingText}
              onChange={(e) => onChangeEdit(e.target.value)}
              rows={Math.max(2, editingText.split("\n").length)}
              className="w-full resize-none rounded-lg border border-accent/40 bg-bg-base px-3 py-2 text-sm focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onCancelEdit}>Cancel</Button>
              <Button size="sm" onClick={onCommitEdit}><Check size={12} /> Save</Button>
            </div>
          </div>
        ) : message.content || (streaming && isLast) ? (
          <>
            {message.content ? (
              message.content
            ) : (
              <StreamingIndicator />
            )}
            {message.role === "assistant" && footer}
          </>
        ) : (
          <span className="text-text-muted italic">[empty]</span>
        )}
        {!editing && actions}
      </div>
    </div>
  );
}

function BubbleButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary"
    >
      {children}
    </button>
  );
}

/**
 * Placeholder shown inside an assistant bubble before the first token
 * arrives. Three pulsing dots + a faint "thinking" hint so the operator
 * knows the stream is alive even before any content has rendered.
 */
function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 text-text-muted">
      <div className="flex items-center gap-1" aria-label="Assistant is responding">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" style={{ animationDelay: "0ms" }} />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" style={{ animationDelay: "180ms" }} />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" style={{ animationDelay: "360ms" }} />
      </div>
      <Skeleton className="h-3 w-32" />
    </div>
  );
}