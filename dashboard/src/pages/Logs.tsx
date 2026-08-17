import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Flame,
  ScrollText,
  TestTube2,
  TriangleAlert,
} from "lucide-react";
import { logs, providers, type RequestLog } from "../api";
import { Badge, Button, Card, EmptyState, Select, Skeleton, fmtMs, fmtNum, fmtTime, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
// Labels show the full model id (no alias shortening).
import { downloadCsv, toCsv } from "../utils/csv";

type LogTab = "request" | "warmup" | "test";

const PAGE_SIZE = 50;

const TAB_META: Record<LogTab, { label: string; icon: typeof ScrollText; subtitle: string; emptyHint: string; exportName: string }> = {
  request: {
    label: "Requests",
    icon: ScrollText,
    subtitle: "All user requests, failover, tokens, and status in one view.",
    emptyHint: "Requests through the gateway will appear here.",
    exportName: "mirais-logs",
  },
  warmup: {
    label: "Warmups",
    icon: Flame,
    subtitle: "View warmup health without mixing in user requests.",
    emptyHint: "Warmup activity will appear here.",
    exportName: "mirais-warmups",
  },
  test: {
    label: "Model tests",
    icon: TestTube2,
    subtitle: "Every \"Test\" click from a provider model is logged here.",
    emptyHint: "Open a provider, click the ⚡ button on any model — the probe result appears here.",
    exportName: "mirais-tests",
  },
};

const TABS: LogTab[] = ["request", "warmup", "test"];

function isLogTab(value: string | null): value is LogTab {
  return value === "request" || value === "warmup" || value === "test";
}

export default function Logs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: LogTab = isLogTab(tabParam) ? tabParam : "request";

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Reset pagination + filters when switching tabs so each tab opens fresh.
  useEffect(() => {
    setPage(1);
    setStatus("");
    setProvider("");
    setModel("");
    setFromDate("");
    setToDate("");
    setExpanded(null);
  }, [tab]);

  const setTab = (next: LogTab) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  const provs = useQuery({
    queryKey: ["providers"],
    queryFn: providers.list,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ["logs", tab, page, status, provider, model, fromDate, toDate],
    queryFn: () => logs.list({
      page,
      limit: PAGE_SIZE,
      status: status || undefined,
      provider: provider || undefined,
      model: model || undefined,
      kind: tab,
      from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
      to: toDate ? new Date(`${toDate}T23:59:59`).toISOString() : undefined,
    }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const resetDates = () => { setFromDate(""); setToDate(""); setPage(1); };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const enabledProviders = (provs.data ?? []).filter((p) => !!p.enabled);
  const providerNames = [...new Set(enabledProviders.map((p) => p.name))];
  const models = enabledProviders.flatMap((p) =>
    (p.models ?? []).filter((m) => m.enabled).map((m) => ({ model_id: m.model_id, provider_name: p.name })),
  );
  const uniqueModels = Array.from(new Map(models.map((m) => [m.model_id, m])).values());
  const modelMap = new Map(uniqueModels.map((m) => [m.model_id, m.provider_name]));

  const successCount = items.filter((l) => l.status === "success").length;
  const errorCount = items.filter((l) => l.status !== "success").length;
  const avgLatency = items.length ? Math.round(items.reduce((sum, l) => sum + (l.latency_ms ?? 0), 0) / items.length) : 0;

  const meta = TAB_META[tab];
  const Icon = meta.icon;

  const exportCsv = () => {
    if (!items.length) {
      toast("No logs to export", "error");
      return;
    }
    const rows = items.map((l) => ({
      time: l.created_at,
      status: l.status,
      provider: l.provider ?? "",
      model: l.model ?? "",
      latency_ms: l.latency_ms ?? 0,
      input_tokens: l.input_tokens ?? 0,
      output_tokens: l.output_tokens ?? 0,
      kind: l.kind ?? "",
      key_label: l.key_label ?? "",
      error: l.error ?? "",
    }));
    const csv = toCsv(rows);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsv(`${meta.exportName}-${stamp}.csv`, csv);
    toast(`Exported ${rows.length} rows`);
  };

  return (
    <div>
      <PageHeader title="Logs">
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={items.length === 0} title="Export current view to CSV">
          <Download size={14} /> Export CSV
        </Button>
      </PageHeader>

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-xl border border-border/70 bg-bg-surface/60 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur w-fit">
        {TABS.map((t) => {
          const m = TAB_META[t];
          const TIcon = m.icon;
          const active = t === tab;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={active}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors ${
                active
                  ? "bg-accent text-white shadow-[0_10px_20px_rgba(124,92,255,0.28)]"
                  : "text-text-muted hover:bg-bg-raised/60 hover:text-text-primary"
              }`}
            >
              <TIcon size={13} />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Hero summary per tab */}
      <div className="mb-6 grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
        <Card className={`overflow-hidden ${
          tab === "request" ? "border-accent/20 bg-[linear-gradient(135deg,rgba(124,92,255,0.12),rgba(18,22,31,0.92)_42%,rgba(18,22,31,0.96))]" :
          tab === "warmup" ? "border-warning/20 bg-[linear-gradient(135deg,rgba(251,191,36,0.10),rgba(18,22,31,0.92)_40%,rgba(18,22,31,0.96))]" :
          "border-accent/20 bg-[linear-gradient(135deg,rgba(124,92,255,0.10),rgba(18,22,31,0.92)_40%,rgba(18,22,31,0.96))]"
        }`}>
          <div className="flex h-full flex-col justify-between gap-6">
            <div>
              <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.24em] ${
                tab === "warmup" ? "border border-warning/30 bg-warning/10 text-warning" : "border border-accent/30 bg-accent/10 text-accent"
              }`}>
                <Icon size={12} /> {meta.label}
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">{meta.subtitle}</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
                {tab === "request" && "This view focuses on real client requests — useful for checking routing issues, token saver, upstream errors, and model performance."}
                {tab === "warmup" && "This view is dedicated to warmups — check active accounts, frequently failing models, and latest warmup latency."}
                {tab === "test" && "Use this view to compare model latency, surface broken upstreams, and see the preview text the probe produced."}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric icon={tab === "warmup" ? <Flame size={16} /> : tab === "test" ? <TestTube2 size={16} /> : <ScrollText size={16} />} label={tab === "warmup" ? "Warmups" : tab === "test" ? "Tests" : "Requests"} value={fmtNum(total)} />
              <Metric icon={<TriangleAlert size={16} />} label="Errors" value={fmtNum(errorCount)} />
              <Metric icon={<Clock3 size={16} />} label="Avg latency" value={fmtMs(avgLatency)} />
            </div>
          </div>
        </Card>

        <div className="grid gap-4">
          <Card>
            <p className="text-xs uppercase tracking-[0.22em] text-text-muted">Current page</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MiniStat label="Success" value={fmtNum(successCount)} tone="success" />
              <MiniStat label="Error" value={fmtNum(errorCount)} tone="danger" />
            </div>
            <p className="mt-4 text-xs text-text-muted">
              {tab === "request" && "Use filters to isolate a specific provider, model, or status when tracing problems."}
              {tab === "warmup" && "Filter warmup failures by provider or status to find problematic accounts faster."}
              {tab === "test" && "Filter model probes by provider or status to compare which models are healthy."}
            </p>
          </Card>
        </div>
      </div>

      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <div className="min-w-0">
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
              <option value="client_error">Client error</option>
              <option value="rate_limited">Rate limited</option>
            </Select>
          </div>
          <div className="min-w-0">
            <Select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }}>
              <option value="">All providers</option>
              {providerNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </div>
          <div className="min-w-0">
            <Select value={model} onChange={(e) => { setModel(e.target.value); setPage(1); }} disabled={tab !== "request"} className={tab !== "request" ? "opacity-60" : ""}>
              <option value="">All models</option>
              {uniqueModels.map((m) => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}
            </Select>
          </div>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
            <span>From</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
              className="h-9 rounded-lg border border-border bg-bg-surface px-3 text-xs text-text-primary focus:border-accent focus:outline-none"
            />
          </label>
          <div className="flex items-end gap-1">
            <label className="flex flex-1 flex-col gap-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
              <span>To</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => { setToDate(e.target.value); setPage(1); }}
                className="h-9 rounded-lg border border-border bg-bg-surface px-3 text-xs text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={resetDates}
                className="h-9 shrink-0 rounded-lg border border-border bg-bg-surface px-2 text-xs text-text-muted hover:text-text-primary"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </Card>

      {list.isLoading ? (
        <Card><Skeleton className="h-64 w-full" /></Card>
      ) : list.isError ? (
        <Card>
          <EmptyState
            icon={<Icon size={32} />}
            title="Failed to load logs"
            hint={(list.error as Error)?.message ?? "Something went wrong. Try again."}
          />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={<Icon size={32} />} title={`No ${meta.label.toLowerCase()}`} hint={meta.emptyHint} />
        </Card>
      ) : tab === "warmup" ? (
        <WarmupList items={items} />
      ) : tab === "test" ? (
        <TestList items={items} />
      ) : (
        <RequestList
          items={items}
          modelMap={modelMap}
          expanded={expanded}
          onToggle={(id) => setExpanded(expanded === id ? null : id)}
        />
      )}

      {items.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>{fmtNum(total)} {tab === "request" ? "requests" : tab === "warmup" ? "warmup events" : "probes"}</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded p-1 hover:bg-bg-raised disabled:opacity-30" aria-label="Previous page">
              <ChevronLeft size={16} />
            </button>
            <span>{page} / {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded p-1 hover:bg-bg-raised disabled:opacity-30" aria-label="Next page">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-base/30 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-text-muted">{icon}{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: "success" | "danger" }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "success" ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger"}`}>
      <p className="text-[10px] uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

function statusTone(s: RequestLog["status"]): "success" | "danger" | "warning" {
  if (s === "success") return "success";
  if (s === "rate_limited") return "warning";
  return "danger";
}

function RequestList({
  items,
  modelMap,
  expanded,
  onToggle,
}: {
  items: RequestLog[];
  modelMap: Map<string, string>;
  expanded: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="divide-y divide-border">
        {items.map((l) => (
          <LogRow key={l.id} log={l} expanded={expanded === l.id} onToggle={() => onToggle(l.id)} modelMap={modelMap} />
        ))}
      </div>
    </Card>
  );
}

function LogRow({ log: l, expanded, onToggle, modelMap }: { log: RequestLog; expanded: boolean; onToggle: () => void; modelMap: Map<string, string> }) {
  return (
    <>
      <div className="cursor-pointer px-5 py-4 hover:bg-bg-raised/30" onClick={onToggle}>
        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr_1fr_auto] lg:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(l.status)}>{l.status}</Badge>
              <span className="text-xs text-text-muted">{fmtTime(l.ts)}</span>
            </div>
            <p className="mt-2 font-mono text-sm text-text-primary" title={l.requested_model}>{l.requested_model}</p>
            <p className="mt-1 text-xs text-text-muted">{l.provider ?? "—"} · upstream {l.model ?? "—"}{l.account_label ? ` · account ${l.account_label}` : ""}</p>
            {l.reasoning_effort && <Badge tone={l.reasoning_effort === "off" ? "muted" : "accent"}>Thinking requested: {l.reasoning_effort}</Badge>}
          </div>
          <div className="grid gap-1 text-xs text-text-muted">
            <span>Tokens: <span className="text-text-primary">{fmtNum(l.input_tokens)} → {fmtNum(l.output_tokens)}</span></span>
            {l.credit_usage != null && <span>Credit: <span className="text-text-primary">{fmtNum(l.credit_usage)}</span></span>}
            <span>Saved: <span className={(l.tokens_saved ?? 0) > 0 ? "text-success" : "text-text-primary"}>{(l.tokens_saved ?? 0) > 0 ? `-${fmtNum(l.tokens_saved ?? 0)}` : "—"}</span></span>
          </div>
          <div className="grid gap-1 text-xs text-text-muted">
            <span>Latency: <span className="text-text-primary">{fmtMs(l.latency_ms)}</span></span>
          </div>
          <div className="text-xs text-text-muted">{expanded ? "Hide detail" : "Open detail"}</div>
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-border bg-bg-base/50 px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
            <Detail k="ID" v={l.id} mono />
            <Detail k="Endpoint" v={l.endpoint} mono />
            <Detail k="Requested model" v={l.requested_model} mono />
            <Detail k="Upstream model" v={l.model ?? "—"} mono />
            <Detail k="Provider" v={l.provider ?? "—"} />
            <Detail k="Account / API key" v={l.account_label ?? "—"} />
            <Detail k="Attempts" v={String(l.attempts)} />
            <Detail k="HTTP status" v={l.http_status != null ? String(l.http_status) : "—"} />
            <Detail k="Input tokens" v={fmtNum(l.input_tokens)} />
            <Detail k="Output tokens" v={fmtNum(l.output_tokens)} />
            {l.credit_usage != null && <Detail k="Credit used" v={fmtNum(l.credit_usage)} />}
            <Detail k="Tokens saved" v={fmtNum(l.tokens_saved)} />
            <Detail k="Thinking requested" v={l.reasoning_effort ?? "Not requested"} />
            <Detail k="Latency" v={fmtMs(l.latency_ms)} />
            {l.error && <Detail k="Error" v={l.error} />}
          </div>
          <Payload title="Request body" value={l.request_body} />
          <Payload title="Response body" value={l.response_body} />
          {!l.request_body && !l.response_body && <p className="mt-4 text-xs text-text-muted">No payload was captured for this request. Set <code>TRACK_PAYLOADS=full</code>, restart Mirais, then send a new request.</p>}
        </div>
      ) : null}
    </>
  );
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{k}</p>
      <p className={`break-all ${mono ? "font-mono" : ""}`}>{v}</p>
    </div>
  );
}

function Payload({ title, value }: { title: string; value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast("Payload copied");
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-border bg-bg-base/60">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">{title}</span>
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 text-xs text-text-muted transition hover:text-text-primary" title={`Copy ${title}`}>
          <Copy size={13} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text-primary">{value}</pre>
    </section>
  );
}

function WarmupList({ items }: { items: RequestLog[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <WarmupRow key={item.id} log={item} />
        ))}
      </div>
    </Card>
  );
}

function WarmupRow({ log }: { log: RequestLog }) {
  const success = log.status === "success";
  return (
    <div className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_0.9fr_0.8fr_0.8fr] lg:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={success ? "success" : "danger"}>{log.status}</Badge>
          <span className="text-xs text-text-muted">{fmtTime(log.ts)}</span>
        </div>
        <p className="mt-2 font-mono text-sm text-text-primary" title={log.requested_model}>{log.requested_model}</p>
        <p className="mt-1 text-xs text-text-muted">{log.provider ?? "—"} · {log.model ?? "no upstream model"}</p>
      </div>
      <div className="grid gap-1 text-xs text-text-muted">
        <span>Latency: <span className="text-text-primary">{fmtMs(log.latency_ms)}</span></span>
        <span>HTTP: <span className="text-text-primary">{log.http_status ?? "—"}</span></span>
        <span>Attempts: <span className="text-text-primary">{fmtNum(log.attempts)}</span></span>
      </div>
      <div className="text-xs text-text-muted">
        <div>Input: <span className="text-text-primary">{fmtNum(log.input_tokens)}</span></div>
        <div>Output: <span className="text-text-primary">{fmtNum(log.output_tokens)}</span></div>
      </div>
      <div className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2 text-xs text-text-muted">
        {log.error ? log.error : success ? "Warmup completed successfully." : "Warmup finished with an unknown failure."}
      </div>
    </div>
  );
}

function TestList({ items }: { items: RequestLog[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="divide-y divide-border">
        {items.map((l) => (
          <TestRow key={l.id} log={l} />
        ))}
      </div>
    </Card>
  );
}

function TestRow({ log }: { log: RequestLog }) {
  return (
    <div className="px-5 py-4 hover:bg-bg-raised/30">
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={log.status === "success" ? "success" : "danger"}>{log.status}</Badge>
            <span className="text-xs text-text-muted">{fmtTime(log.ts)}</span>
          </div>
          <p className="mt-2 font-mono text-sm text-text-primary">{log.requested_model}</p>
          <p className="mt-1 text-xs text-text-muted">{log.provider ?? "—"} · account {log.account_label ?? "—"}</p>
          {log.error && <p className="mt-1 truncate text-xs text-danger" title={log.error}>{log.error}</p>}
        </div>
        <div className="grid gap-1 text-xs text-text-muted">
          <span>Latency: <span className="text-text-primary">{fmtMs(log.latency_ms)}</span></span>
          {log.response_body && (
            <span className="truncate" title={log.response_body}>
              Result:{" "}
              <span className="text-text-primary">
                {log.response_body.slice(0, 80)}
                {log.response_body.length > 80 ? "…" : ""}
              </span>
            </span>
          )}
        </div>
        <div className="text-xs text-text-muted">
          {log.http_status != null ? (
            <Badge tone={log.http_status >= 200 && log.http_status < 300 ? "success" : "danger"}>HTTP {log.http_status}</Badge>
          ) : (
            "—"
          )}
        </div>
      </div>
    </div>
  );
}