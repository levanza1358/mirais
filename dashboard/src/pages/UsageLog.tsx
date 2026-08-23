import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Download, ShieldAlert, TimerReset, Trash2 } from "lucide-react";
import { logs } from "../api";
import { Button, Card, Select, Badge, EmptyState, Skeleton, fmtNum, fmtMs, fmtTime, ConfirmModal, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
// Labels show the full model id (no alias shortening).
import { downloadCsv, toCsv } from "../utils/csv";

export default function UsageLog() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [confirmClear, setConfirmClear] = useState(false);
  const usage = useQuery({
    queryKey: ["usage-log", days],
    queryFn: () => logs.usage(days),
    staleTime: 30_000,
  });
  const clearUsage = useMutation({
    mutationFn: () => logs.clearUsage(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["usage-log"] });
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      setConfirmClear(false);
      toast(`Usage cleared${res.cleared ? ` · ${res.cleared} log entries removed` : ""}`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const rows = usage.data ?? [];
  const totalReq = rows.reduce((n, r) => n + r.requests, 0);
  const totalIn = rows.reduce((n, r) => n + r.input_tokens, 0);
  const totalOut = rows.reduce((n, r) => n + r.output_tokens, 0);
  const totalCached = rows.reduce((n, r) => n + (r.cached_tokens ?? 0), 0);
  const totalErrors = rows.reduce((n, r) => n + r.errors, 0);
  const avgLatency = rows.length ? Math.round(rows.reduce((n, r) => n + r.avg_latency_ms, 0) / rows.length) : 0;
  const chartData = useMemo(
    () => rows.slice(0, 8).map((r) => ({
      name: r.model && r.provider ? `${r.provider}/${r.model}` : (r.model ?? r.provider ?? "—"),
      requests: r.requests,
      input: r.input_tokens,
      output: r.output_tokens,
      errors: r.errors,
    })),
    [rows],
  );

  const exportCsv = () => {
    if (!rows.length) {
      toast("No usage to export", "error");
      return;
    }
    const csv = toCsv(
      rows.map((r) => ({
        provider: r.provider ?? "",
        model: r.model ?? "",
        requests: r.requests,
        errors: r.errors,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cached_tokens: r.cached_tokens ?? 0,
        cache_write_tokens: r.cache_write_tokens ?? 0,
        avg_latency_ms: Math.round(r.avg_latency_ms),
        last_used: r.last_ts,
      })),
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsv(`mirais-usage-${days}d-${stamp}.csv`, csv);
    toast(`Exported ${rows.length} rows`);
  };

  return (
    <div>
      <PageHeader title="Usage log">
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
          <Download size={14} /> Export CSV
        </Button>
        <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={clearUsage.isPending}>
          <Trash2 size={16} /> Clear usage
        </Button>
      </PageHeader>

      <div className="mb-6 grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
        <Card className="overflow-hidden border-accent/20">
          <div className="flex h-full flex-col justify-between gap-6">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-accent">
                <Activity size={12} /> Usage monitor
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">Cleaner usage overview, focused on traffic and quality.</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
                This page focuses on requests, tokens, errors, and latency. All cost or currency displays have been removed from this dashboard.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-5">
              <Stat label="Requests" value={fmtNum(totalReq)} />
              <Stat label="Input tokens" value={fmtNum(totalIn)} />
              <Stat label="Cached tokens" value={totalCached ? fmtNum(totalCached) : "—"} />
              <Stat label="Output tokens" value={fmtNum(totalOut)} />
              <Stat label="Errors" value={fmtNum(totalErrors)} />
            </div>
          </div>
        </Card>

        <div className="grid gap-4">
          <Card>
            <p className="text-xs uppercase tracking-[0.22em] text-text-muted">Health snapshot</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MiniStat icon={<TimerReset size={14} />} label="Avg latency" value={fmtMs(avgLatency)} />
              <MiniStat icon={<ShieldAlert size={14} />} label="Tracked models" value={fmtNum(rows.length)} />
            </div>
            <p className="mt-4 text-xs text-text-muted">Real traffic only, warmup excluded, grouped by provider + model.</p>
          </Card>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="w-32">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            <option value="1">Last 24h</option>
            <option value="7">Last 7d</option>
            <option value="30">Last 30d</option>
          </Select>
        </div>
        <span className="text-xs text-text-muted">Real traffic only (warmup excluded), grouped by provider + model.</span>
      </div>

      {usage.isLoading ? (
        <Card><Skeleton className="h-64 w-full" /></Card>
      ) : usage.isError ? (
        <Card>
          <EmptyState icon={<BarChart3 size={32} />} title="Failed to load usage" hint={(usage.error as Error)?.message ?? "Something went wrong. Try again."} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<BarChart3 size={32} />} title="No usage yet" hint="Real requests through the gateway will be aggregated here." />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <h3 className="mb-4 text-sm font-medium text-text-muted">Requests by model</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData}>
                  <XAxis dataKey="name" hide />
                  <YAxis tick={{ fontSize: 11, fill: "#85858f" }} stroke="#232328" width={40} />
                  <Tooltip contentStyle={{ background: "#17171b", border: "1px solid #232328", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill="#7C5CFF" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card>
              <h3 className="mb-4 text-sm font-medium text-text-muted">Token flow</h3>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="usageInput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7C5CFF" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#7C5CFF" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="usageOutput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34D399" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#34D399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" hide />
                  <YAxis tick={{ fontSize: 11, fill: "#85858f" }} stroke="#232328" width={40} />
                  <Tooltip contentStyle={{ background: "#17171b", border: "1px solid #232328", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="input" stroke="#7C5CFF" fill="url(#usageInput)" strokeWidth={2} />
                  <Area type="monotone" dataKey="output" stroke="#34D399" fill="url(#usageOutput)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 text-right font-medium">Requests</th>
                  <th className="px-4 py-3 text-right font-medium">Errors</th>
                  <th className="px-4 py-3 text-right font-medium">Input</th>
                  <th className="px-4 py-3 text-right font-medium" title="Prompt tokens served from the provider's cache">Cached</th>
                  <th className="px-4 py-3 text-right font-medium">Output</th>
                  <th className="px-4 py-3 text-right font-medium">Avg latency</th>
                  <th className="px-4 py-3 text-right font-medium">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={`${r.provider}/${r.model}`} className="hover:bg-bg-raised/50">
                    <td className="px-4 py-2.5 font-mono text-xs" title={r.model ?? undefined}>{r.model && r.provider ? `${r.provider}/${r.model}` : (r.model ?? "—")}</td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">{r.provider ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right text-xs font-medium">{fmtNum(r.requests)}</td>
                    <td className="px-4 py-2.5 text-right text-xs">
                      {r.errors > 0 ? <Badge tone="danger">{r.errors}</Badge> : <span className="text-text-muted">0</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs">{fmtNum(r.input_tokens)}</td>
                    <td
                      className="px-4 py-2.5 text-right text-xs"
                      title={r.cache_write_tokens ? `${fmtNum(r.cache_write_tokens)} cache write tokens` : undefined}
                    >
                      {r.cached_tokens
                        ? <span className="text-success">{fmtNum(r.cached_tokens)}</span>
                        : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs">{fmtNum(r.output_tokens)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-text-muted">{fmtMs(Math.round(r.avg_latency_ms))}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-text-muted">{fmtTime(r.last_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </Card>
        </div>
      )}

      <ConfirmModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => clearUsage.mutate()}
        title="Clear all usage data"
        message="This will delete all request logs, warmup logs, and usage history permanently."
        danger
        loading={clearUsage.isPending}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-bg-base/60 px-4 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-bg-base/60 px-4 py-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}
