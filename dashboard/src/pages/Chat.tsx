import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Loader2, Plus, Square, Trash2 } from "lucide-react";
import { combos, keys, providers } from "../api";
import { storedKeyFor } from "../keyStore";
import { Select, EmptyState, toast } from "../components/ui";

type Msg = { role: "user" | "assistant"; content: string };
type Conv = { id: string; title: string; ts: number; msgs: Msg[] };

const CHAT_STORAGE = "mirais.chats";

function loadConvs(): Conv[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_STORAGE) ?? "[]") as Conv[];
  } catch {
    return [];
  }
}

function saveConvs(list: Conv[]): void {
  try {
    localStorage.setItem(CHAT_STORAGE, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const PRESETS = [
  { title: "Explain this stack", prompt: "Explain how an OpenAI-compatible gateway routes requests across multiple providers." },
  { title: "Draft a commit message", prompt: "Write a Conventional Commits message for: added a chat playground page to the dashboard." },
  { title: "Review my approach", prompt: "I want to add streaming SSE parsing on the client. What edge cases should I handle?" },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning!";
  if (h < 18) return "Good afternoon!";
  return "Good evening!";
}

export default function Chat() {
  const providerList = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const keyList = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const comboList = useQuery({ queryKey: ["combos"], queryFn: combos.list });

  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [convs, setConvs] = useState<Conv[]>(loadConvs);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [msgs]);

  // Persist once streaming settles so we don't write on every token.
  useEffect(() => {
    if (streaming || !activeId || !msgs.length) return;
    setConvs((prev) => {
      const next = [
        { id: activeId, title: msgs[0].content.slice(0, 60) || "Untitled", ts: Date.now(), msgs },
        ...prev.filter((c) => c.id !== activeId),
      ];
      saveConvs(next);
      return next;
    });
  }, [streaming, msgs, activeId]);

  const firstKey = (keyList.data ?? [])[0];
  const gatewayKey = firstKey ? (firstKey.key ?? storedKeyFor(firstKey.key_prefix)) : null;

  function newChat() {
    abortRef.current?.abort();
    setActiveId(null);
    setMsgs([]);
    setInput("");
  }

  function openConv(c: Conv) {
    abortRef.current?.abort();
    setActiveId(c.id);
    setMsgs(c.msgs);
    setInput("");
  }

  function deleteConv(id: string) {
    setConvs((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConvs(next);
      return next;
    });
    if (id === activeId) newChat();
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || streaming) return;
    if (!gatewayKey) return toast("No gateway key — generate one on Overview", "error");
    if (!model) return toast("No enabled model available", "error");

    if (!activeId) setActiveId(crypto.randomUUID());
    const history: Msg[] = [...msgs, { role: "user", content: prompt }];
    setMsgs([...history, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${gatewayKey}` },
        body: JSON.stringify({ model, messages: history, stream: true, reasoning: { effort } }),
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
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: x.content + delta } : x)));
          } catch {
            /* skip non-JSON keepalives */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const message = (e as Error).message;
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 && !x.content ? { ...x, content: `⚠ ${message}` } : x)));
      toast(message, "error");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

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
        <Select value={model} onChange={(e) => setModel(e.target.value)} className="h-9 w-auto max-w-64 rounded-full">
          {models.length ? models.map((m) => <option key={m} value={m}>{m}</option>) : <option value="">No models</option>}
        </Select>
        <Select value={effort} onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])} className="h-9 w-auto rounded-full">
          {EFFORTS.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        {msgs.length > 0 && (
          <button
            type="button"
            onClick={() => (activeId ? deleteConv(activeId) : newChat())}
            title="Delete this chat"
            className="ml-auto rounded-full p-2 text-text-muted transition-colors hover:text-danger"
          >
            <Trash2 size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={() => (streaming ? abortRef.current?.abort() : void send(input))}
          disabled={!streaming && !input.trim()}
          aria-label={streaming ? "Stop" : "Send"}
          className={`${msgs.length > 0 ? "" : "ml-auto"} rounded-full bg-accent p-2.5 text-white transition-all hover:bg-accent/85 disabled:opacity-40`}
        >
          {streaming ? <Square size={16} /> : <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  );

  const history = (
    <aside className="hidden w-60 shrink-0 flex-col gap-2 border-r border-border/60 pr-3 lg:flex">
      <button
        type="button"
        onClick={newChat}
        className="flex items-center gap-2 rounded-xl border border-border/80 px-3 py-2 text-sm text-text-muted transition-colors hover:border-accent/40 hover:text-text-primary"
      >
        <Plus size={14} /> New chat
      </button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {convs.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">No saved chats yet.</p>
        ) : (
          convs.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-xl px-2 transition-colors ${
                c.id === activeId ? "bg-bg-raised/80" : "hover:bg-bg-raised/50"
              }`}
            >
              <button
                type="button"
                onClick={() => openConv(c)}
                className="min-w-0 flex-1 truncate py-2 text-left text-xs text-text-primary"
                title={c.title}
              >
                {c.title}
              </button>
              <button
                type="button"
                onClick={() => deleteConv(c.id)}
                title="Delete chat"
                aria-label={`Delete ${c.title}`}
                className="rounded-lg p-1 text-text-muted opacity-0 transition-colors group-hover:opacity-100 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );

  const pane =
    msgs.length === 0 ? (
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col justify-center gap-6 py-10">
        <h1 className="text-center text-3xl font-semibold">
          {greeting()} <span className="text-text-muted">Leave the rest to me.</span>
        </h1>
        {composer}
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
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              <div
                className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${
                  m.role === "user" ? "max-w-[80%] bg-accent/15 text-text-primary" : "w-full text-text-primary"
                }`}
              >
                {m.content || <Loader2 size={14} className="animate-spin text-text-muted" />}
              </div>
            </div>
          ))}
        </div>
        {composer}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 gap-3 md:h-[calc(100dvh-3rem)]">
      {history}
      <div className="flex min-h-0 flex-1 flex-col">{pane}</div>
    </div>
  );
}
