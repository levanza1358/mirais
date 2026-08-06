import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock3, ScrollText, Sparkles, TriangleAlert } from "lucide-react";
import { logs, providers, type RequestLog } from "../api";
import { Card, Select, Badge, EmptyState, Skeleton, fmtNum, fmtMs, fmtTime } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { labelForProvider } from "../utils/modelLabels";

const PAGE_SIZE = 50;

export default function Logs() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const provs = useQuery({
    queryKey: ["providers"],
    queryFn: providers.list,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ["logs", page, status, provider, model],
    queryFn: () => logs.list({
      page,
      limit: PAGE_SIZE,
      status: status || undefined,
      provider: provider || undefined,
      model: model || undefined,
      kind: "request",
    }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

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

  return (
    <div>
      <PageHeader title="Request logs" />

      <div className="mb-6 grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
        <Card className="overflow-hidden border-accent/20 bg-[linear-gradient(135deg,rgba(124,92,255,0.12),rgba(18,22,31,0.92)_42%,rgba(18,22,31,0.96))]">
          <div className="flex h-full flex-col justify-between gap-6">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-accent">
                <Sparkles size={12} /> Traffic feed
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">All user requests, failover, tokens, and status in one view.</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
                This page focuses on real client requests — useful for checking routing issues, token saver, upstream errors, and model performance.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric icon={<ScrollText size={16} />} label="Requests" value={fmtNum(total)} />
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
            <p className="mt-4 text-xs text-text-muted">Use filters to isolate a specific provider, model, or status when tracing problems.</p>
          </Card>
        </div>
      </div>

      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
            <Select value={model} onChange={(e) => { setModel(e.target.value); setPage(1); }}>
              <option value="">All models</option>
              {uniqueModels.map((m) => <option key={m.model_id} value={m.model_id}>{labelForProvider(modelMap.get(m.model_id) ?? "", m.model_id)}</option>)}
            </Select>
          </div>
        </div>
      </Card>

      {list.isLoading ? (
        <Card><Skeleton className="h-64 w-full" /></Card>
      ) : list.isError ? (
        <Card>
          <EmptyState icon={<ScrollText size={32} />} title="Failed to load logs" hint={(list.error as Error)?.message ?? "Something went wrong. Try again."} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={<ScrollText size={32} />} title="No logs" hint="Requests through the gateway will appear here." />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="divide-y divide-border">
            {items.map((l) => (
              <LogRow key={l.id} log={l} expanded={expanded === l.id} onToggle={() => setExpanded(expanded === l.id ? null : l.id)} />
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
            <span>{fmtNum(total)} requests</span>
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
        </Card>
      )}
    </div>
  );
}

function statusTone(s: RequestLog["status"]): "success" | "danger" | "warning" {
  if (s === "success") return "success";
  if (s === "rate_limited") return "warning";
  return "danger";
}

function LogRow({ log: l, expanded, onToggle }: { log: RequestLog; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <div className="cursor-pointer px-5 py-4 hover:bg-bg-raised/30" onClick={onToggle}>
        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr_1fr_auto] lg:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(l.status)}>{l.status}</Badge>
              <span className="text-xs text-text-muted">{fmtTime(l.ts)}</span>
            </div>
            <p className="mt-2 font-mono text-sm text-text-primary" title={l.requested_model}>{labelForProvider(l.provider ?? "", l.requested_model)}</p>
            <p className="mt-1 text-xs text-text-muted">{l.provider ?? "—"} · upstream {l.model ?? "—"}</p>
          </div>

          <div className="grid gap-1 text-xs text-text-muted">
            <span>Tokens: <span className="text-text-primary">{fmtNum(l.input_tokens)} → {fmtNum(l.output_tokens)}</span></span>
            <span>Saved: <span className={(l.tokens_saved ?? 0) > 0 ? "text-success" : "text-text-primary"}>{(l.tokens_saved ?? 0) > 0 ? `-${fmtNum(l.tokens_saved ?? 0)}` : "—"}</span></span>
          </div>

          <div className="grid gap-1 text-xs text-text-muted">
            <span>Latency: <span className="text-text-primary">{fmtMs(l.latency_ms)}</span></span>
          </div>

          <div className="text-xs text-text-muted">{expanded ? "Hide detail" : "Open detail"}</div>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border bg-bg-base/50 px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
            <Detail k="ID" v={l.id} mono />
            <Detail k="Endpoint" v={l.endpoint} mono />
            <Detail k="Requested model" v={l.requested_model} mono />
            <Detail k="Upstream model" v={l.model ?? "—"} mono />
            <Detail k="Provider" v={l.provider ?? "—"} />
            <Detail k="Attempts" v={String(l.attempts)} />
            <Detail k="HTTP status" v={l.http_status != null ? String(l.http_status) : "—"} />
            <Detail k="Input tokens" v={fmtNum(l.input_tokens)} />
            <Detail k="Output tokens" v={fmtNum(l.output_tokens)} />
            <Detail k="Tokens saved" v={fmtNum(l.tokens_saved)} />
            <Detail k="Latency" v={fmtMs(l.latency_ms)} />
            {l.error && <Detail k="Error" v={l.error} />}
          </div>
          {(l as { attempts_detail?: Array<{ provider?: string; model?: string; accountLabel?: string; outcome?: string; httpStatus?: number; error?: string; latencyMs?: number; reason?: string }> }).attempts_detail && (
            <div className="mt-3 rounded-lg bg-bg-base p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">Failover / attempts</p>
              <div className="space-y-2">
                {((l as { attempts_detail?: Array<{ provider?: string; model?: string; accountLabel?: string; outcome?: string; httpStatus?: number; error?: string; latencyMs?: number; reason?: string }> }).attempts_detail ?? []).map((a, i) => (
                  <div key={i} className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-[11px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={a.outcome === "success" ? "success" : "danger"}>{a.outcome ?? "unknown"}</Badge>
                      <span className="font-mono">{a.provider ?? "—"}</span>
                      <span className="text-text-muted">{a.model ?? "—"}</span>
                      {a.accountLabel && <span className="text-text-muted">acct: {a.accountLabel}</span>}
                      {a.httpStatus != null && <span className="text-text-muted">HTTP {a.httpStatus}</span>}
                      {a.latencyMs != null && <span className="text-text-muted">{a.latencyMs}ms</span>}
                    </div>
                    {(a.reason || a.error) && (
                      <div className="mt-1 text-text-muted">
                        {a.reason && <div>Reason: {a.reason}</div>}
                        {a.error && <div>Error: {a.error}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(l.request_body || l.response_body) && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {l.request_body && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">Prompt</p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-base p-3 font-mono text-[11px] leading-relaxed text-text-base">{l.request_body}</pre>
                </div>
              )}
              {l.response_body && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">{l.response_body.startsWith("ERROR:") ? "Error" : "Response"}</p>
                  <pre className={`max-h-56 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-[11px] leading-relaxed ${l.response_body.startsWith("ERROR:") ? "bg-danger/10 text-danger" : "bg-bg-base text-text-base"}`}>{l.response_body}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-bg-base/60 px-4 py-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: "success" | "danger" }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-bg-base/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${tone === "success" ? "text-success" : "text-danger"}`}>{value}</p>
    </div>
  );
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-text-muted">{k}:</span>
      <span className={`truncate ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}
