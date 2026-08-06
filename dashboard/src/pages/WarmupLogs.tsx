import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Flame, RefreshCw, ShieldAlert, TimerReset, Zap } from "lucide-react";
import { logs, providers, type RequestLog } from "../api";
import { Badge, Card, EmptyState, Select, Skeleton, fmtMs, fmtNum, fmtTime } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { labelForProvider } from "../utils/modelLabels";

const PAGE_SIZE = 50;

export default function WarmupLogs() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");

  const provs = useQuery({
    queryKey: ["providers"],
    queryFn: providers.list,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ["warmup-logs", page, status, provider],
    queryFn: () => logs.list({ page, limit: PAGE_SIZE, status: status || undefined, provider: provider || undefined, kind: "warmup" }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const enabledProviders = (provs.data ?? []).filter((p) => !!p.enabled);
  const providerNames = [...new Set(enabledProviders.map((p) => p.name))];

  const successCount = items.filter((l) => l.status === "success").length;
  const failedCount = items.filter((l) => l.status !== "success").length;
  const avgLatency = items.length ? Math.round(items.reduce((sum, l) => sum + (l.latency_ms ?? 0), 0) / items.length) : 0;

  return (
    <div>
      <PageHeader title="Warmup logs" />

      <div className="mb-6 grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
        <Card className="overflow-hidden border-warning/20 bg-[linear-gradient(135deg,rgba(251,191,36,0.10),rgba(18,22,31,0.92)_40%,rgba(18,22,31,0.96))]">
          <div className="flex h-full flex-col justify-between gap-6">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-warning">
                <Flame size={12} /> Warmup monitor
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">View warmup health without mixing in user requests.</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
                This page is dedicated to warmups — check active accounts, frequently failing models, and latest warmup latency.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <WarmMetric icon={<Zap size={16} />} label="Warmups" value={fmtNum(total)} />
              <WarmMetric icon={<ShieldAlert size={16} />} label="Failures" value={fmtNum(failedCount)} />
              <WarmMetric icon={<TimerReset size={16} />} label="Avg latency" value={fmtMs(avgLatency)} />
            </div>
          </div>
        </Card>

        <div className="grid gap-4">
          <Card>
            <p className="text-xs uppercase tracking-[0.22em] text-text-muted">Current page</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MiniStat label="Success" value={fmtNum(successCount)} tone="success" />
              <MiniStat label="Error" value={fmtNum(failedCount)} tone="danger" />
            </div>
            <p className="mt-4 text-xs text-text-muted">Filter warmup failures by provider or status to find problematic accounts faster.</p>
          </Card>
        </div>
      </div>

      <Card className="mb-4">
        <div className="grid gap-2 md:grid-cols-3">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="client_error">Client error</option>
            <option value="rate_limited">Rate limited</option>
          </Select>
          <Select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }}>
            <option value="">All providers</option>
            {providerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <div className="flex items-center justify-end rounded-xl border border-border/70 bg-bg-base/60 px-3 text-xs text-text-muted">
            <RefreshCw size={14} className="mr-2" /> Warmup only · page {page}/{pages}
          </div>
        </div>
      </Card>

      {list.isLoading ? (
        <Card><Skeleton className="h-64 w-full" /></Card>
      ) : list.isError ? (
        <Card>
          <EmptyState icon={<Flame size={32} />} title="Failed to load warmup logs" hint={(list.error as Error)?.message ?? "Something went wrong. Try again."} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={<Flame size={32} />} title="No warmup logs" hint="Warmup activity will appear here." />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="divide-y divide-border">
            {items.map((item) => (
              <WarmupRow key={item.id} log={item} />
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
            <span>{fmtNum(total)} warmup events</span>
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

function WarmupRow({ log }: { log: RequestLog }) {
  const success = log.status === "success";
  return (
    <div className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_0.9fr_0.8fr_0.8fr] lg:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={success ? "success" : "danger"}>{log.status}</Badge>
          <span className="text-xs text-text-muted">{fmtTime(log.ts)}</span>
        </div>
        <p className="mt-2 font-mono text-sm text-text-primary" title={log.requested_model}>{labelForProvider(log.provider ?? "", log.requested_model)}</p>
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

function WarmMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
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