import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, XCircle, Send, Globe, KeyRound, RefreshCw } from "lucide-react";
import { stats, logs, keys, providers, healthInfo, type Provider } from "../api";
import { rememberKey, storedKeyFor, forgetKey } from "../keyStore";
import { Card, Skeleton, Badge, EmptyState, CopyButton, Button, toast, fmtNum, fmtMs, fmtTime } from "../components/ui";
import { PageHeader } from "../components/Layout";

const RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

export default function Overview() {
  const [days, setDays] = useState(() => Number(localStorage.getItem("mirais.range") ?? 7));

  const summary = useQuery({ queryKey: ["stats-summary", days], queryFn: () => stats.summary(days) });
  const recent = useQuery({ queryKey: ["logs-recent"], queryFn: () => logs.list({ page: 1, limit: 6 }), refetchInterval: 8_000 });
  const providerList = useQuery({ queryKey: ["providers"], queryFn: providers.list, refetchInterval: 30_000 });

  const s = summary.data;

  return (
    <div>
      <PageHeader title="Overview">
        <div className="flex rounded-lg border border-border bg-bg-surface p-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => { setDays(r.days); localStorage.setItem("mirais.range", String(r.days)); }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                days === r.days ? "bg-bg-raised text-text-primary" : "text-text-muted hover:text-text-primary"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="mb-5 grid gap-4 xl:grid-cols-[1fr_0.95fr]">
        <ConnectCard />
        <WarmupSummaryCard providers={providerList.data ?? []} loading={providerList.isLoading} />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Requests" value={fmtNum(s?.requests)} loading={summary.isLoading} />
        <StatCard label="Tokens" value={fmtNum((s?.input_tokens ?? 0) + (s?.output_tokens ?? 0))} loading={summary.isLoading} />
        <StatCard label="Success rate" value={s ? `${(s.success_rate * 100).toFixed(1)}%` : "—"} loading={summary.isLoading} />
      </div>

      <RuntimeCard />

      {s?.requests === 0 ? (
        <Card>
          <EmptyState
            icon={<Send size={32} />}
            title="No traffic yet"
            hint="Send your first request through the gateway to see stats here."
            action={
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs text-text-muted">
                <span>{`curl http://localhost:1463/v1/chat/completions -H "Authorization: Bearer <key>"`}</span>
                <CopyButton text={`curl http://localhost:1463/v1/chat/completions -H "Authorization: Bearer <key>" -H "content-type: application/json" -d '{"model":"...","messages":[{"role":"user","content":"hi"}]}'`} />
              </div>
            }
          />
        </Card>
      ) : null}

      <Card>
        <h3 className="mb-4 text-sm font-medium text-text-muted">Live activity</h3>
        {recent.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (recent.data?.items ?? []).length === 0 ? (
          <p className="py-5 text-center text-xs text-text-muted">No requests yet</p>
        ) : (
          <div className="space-y-1">
            {recent.data!.items.map((l) => (
              <div key={l.id} className="hover-nudge flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-bg-raised">
                {l.status === "success" ? <CheckCircle2 size={14} className="shrink-0 text-success" /> : <XCircle size={14} className="shrink-0 text-danger" />}
                <span className="w-32 shrink-0 text-text-muted">{fmtTime(l.ts)}</span>
                <span className="truncate font-mono">{l.requested_model}</span>
                {l.provider && <Badge tone="muted">{l.provider}</Badge>}
                <span className="ml-auto shrink-0 text-text-muted">{fmtNum(l.input_tokens)}→{fmtNum(l.output_tokens)}</span>
                {(l.tokens_saved ?? 0) > 0 && <Badge tone="success">-{fmtNum(l.tokens_saved ?? 0)} tok</Badge>}
                <span className="w-16 shrink-0 text-right text-text-muted">{fmtMs(l.latency_ms)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <Card className="hover-lift overflow-hidden p-0">
      <div className="p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-text-muted">{label}</p>
        {loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}
      </div>
    </Card>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Live process health. In-flight count and active cooldowns are the two numbers
 * that actually explain "why is the gateway not responding" — a stuck stream
 * shows up as in-flight that never drains, and an exhausted pool shows up as
 * cooldowns.
 */
function RuntimeCard() {
  const health = useQuery({ queryKey: ["health-runtime"], queryFn: healthInfo.detailed, refetchInterval: 10_000 });
  const runtime = health.data?.runtime;
  if (!runtime) return null;
  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center gap-2">
        <Activity size={14} className="text-accent" />
        <h3 className="text-sm font-medium text-text-muted">Runtime</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MiniMetric label="In flight" value={fmtNum(runtime.in_flight)} />
        <MiniMetric label="Cooldowns" value={fmtNum(runtime.active_cooldowns)} />
        <MiniMetric label="RSS" value={fmtBytes(runtime.memory.rss_bytes)} />
        <MiniMetric label="Heap" value={fmtBytes(runtime.memory.heap_used_bytes)} />
        <MiniMetric label="Buffers" value={fmtBytes(runtime.memory.array_buffers_bytes)} />
      </div>
    </Card>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="hover-lift rounded-2xl border border-border/80 bg-bg-base/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function ConnectCard() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const [revealed, setRevealed] = useState<string | null>(null);

  const baseUrl = `${window.location.origin}/v1`;
  const firstKey = (list.data ?? [])[0];

  const createFirst = useMutation({
    mutationFn: () => keys.create({ label: "default" }),
    onSuccess: (k) => {
      rememberKey(k.key_prefix, k.key ?? k.plaintext);
      setRevealed(k.key ?? k.plaintext);
      qc.invalidateQueries({ queryKey: ["keys"] });
      toast("Global API key generated");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const rotate = useMutation({
    mutationFn: (keyId: string) => keys.rotate(keyId),
    onSuccess: (k) => {
      if (firstKey) forgetKey(firstKey.key_prefix);
      rememberKey(k.key_prefix, k.key ?? k.plaintext);
      setRevealed(k.key ?? k.plaintext);
      qc.invalidateQueries({ queryKey: ["keys"] });
      toast("API key rotated");
    },
    onError: (e) => toast(e.message, "error"),
  });

  useEffect(() => {
    if (firstKey && !revealed) setRevealed(firstKey.key ?? storedKeyFor(firstKey.key_prefix));
  }, [firstKey, revealed]);

  // Key is persisted plaintext server-side — always visible and copyable.
  const keyDisplay = revealed ?? firstKey?.key ?? `${firstKey?.key_prefix ?? ""}••••••••••••••••`;

  return (
    <Card className="mb-0">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs uppercase tracking-[0.22em] text-text-muted">Quick connect</p>
          <h3 className="text-lg font-semibold">Connect your app</h3>
        </div>
        <div className="rounded-2xl border border-accent/20 bg-accent/10 p-2 text-accent">
          <KeyRound size={18} />
        </div>
      </div>
      <p className="mb-4 text-sm leading-6 text-text-muted">
        Point any OpenAI-compatible client at the gateway with one global key.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-2xl border border-border/80 bg-bg-base/70 px-3 py-3">
          <Globe size={14} className="shrink-0 text-text-muted" />
          <span className="w-20 shrink-0 text-xs text-text-muted">Base URL</span>
          <code className="flex-1 truncate font-mono text-xs text-accent">{baseUrl}</code>
          <CopyButton text={baseUrl} />
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-border/80 bg-bg-base/70 px-3 py-3">
          <KeyRound size={14} className="shrink-0 text-text-muted" />
          <span className="w-20 shrink-0 text-xs text-text-muted">API key</span>
          {list.isLoading ? (
            <Skeleton className="h-4 w-48" />
          ) : firstKey ? (
            <>
              <code className="flex-1 truncate font-mono text-xs text-accent">{keyDisplay}</code>
              <CopyButton text={keyDisplay} />
              <Button size="sm" variant="outline" onClick={() => rotate.mutate(firstKey.id)} loading={rotate.isPending}>
                <RefreshCw size={13} /> Generate new key
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => createFirst.mutate()} loading={createFirst.isPending}>
              <RefreshCw size={13} /> Generate new key
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function WarmupSummaryCard({ providers, loading }: { providers: Provider[]; loading: boolean }) {
  const accounts = providers.flatMap((p) => p.accounts ?? []);
  const healthy = accounts.filter((a) => a.last_warmup_status === "healthy").length;
  const rateLimited = accounts.filter((a) => a.last_warmup_status === "rate_limited").length;
  const failing = accounts.filter((a) => a.last_warmup_status === "failing").length;

  return (
    <Card>
      <div className="mb-3">
        <p className="mb-1 text-xs uppercase tracking-[0.22em] text-text-muted">Warmup summary</p>
        <h3 className="text-lg font-semibold">Account health</h3>
      </div>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <MiniMetric label="Healthy" value={fmtNum(healthy)} />
          <MiniMetric label="Rate limited" value={fmtNum(rateLimited)} />
          <MiniMetric label="Failing" value={fmtNum(failing)} />
          <MiniMetric label="Providers" value={fmtNum(providers.length)} />
          <MiniMetric label="Accounts" value={fmtNum(accounts.length)} />
        </div>
      )}
    </Card>
  );
}
