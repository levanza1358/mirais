import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, KeyRound, Radio, Terminal } from "lucide-react";
import { keys, stats } from "../api";
import { Button, Card, CopyButton, Skeleton } from "../components/ui";
import { storedKeyFor } from "../keyStore";

function fmtNum(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function Landing() {
  const navigate = useNavigate();

  const summaryQ = useQuery({
    queryKey: ["stats", "summary", 30],
    queryFn: () => stats.summary(30),
    staleTime: 60_000,
  });
  const byModelQ = useQuery({
    queryKey: ["stats", "by-model", 30],
    queryFn: () => stats.byModel(30),
    staleTime: 60_000,
  });
  const keysQ = useQuery({
    queryKey: ["keys"],
    queryFn: keys.list,
    staleTime: 60_000,
  });

  const totalRequests = summaryQ.data?.requests ?? 0;
  const totalTokens = (summaryQ.data?.input_tokens ?? 0) + (summaryQ.data?.output_tokens ?? 0);
  const successRate = summaryQ.data?.success_rate;
  const topModels = useMemo(
    () => (byModelQ.data ?? []).slice().sort((a, b) => b.requests - a.requests).slice(0, 5),
    [byModelQ.data],
  );

  const primaryKey = keysQ.data?.[0];
  const visibleKey = primaryKey?.key ?? storedKeyFor(primaryKey?.key_prefix ?? "") ?? (primaryKey ? `${primaryKey.key_prefix}${"•".repeat(18)}` : "mirais-••••••••••••••••");

  const baseUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}/v1`
    : "http://127.0.0.1:1463/v1";

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,#1a2030_0%,#0b0e14_45%,#090c12_100%)] text-text-primary">
      <main className="mx-auto max-w-5xl px-5 pb-16 pt-16 sm:pt-24">
        <section className="mb-10 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Welcome to <span className="text-accent">Mirais Proxy</span>
          </h1>
        </section>

        <section className="mb-8 grid gap-3 sm:grid-cols-3">
          <StatCard label="Total requests · 30d" value={summaryQ.isLoading ? null : fmtNum(totalRequests)} loading={summaryQ.isLoading} />
          <StatCard label="Total tokens · 30d" value={summaryQ.isLoading ? null : fmtNum(totalTokens)} loading={summaryQ.isLoading} />
          <StatCard
            label="Success rate"
            value={summaryQ.isLoading ? null : successRate === undefined ? "—" : `${(successRate * 100).toFixed(1)}%`}
            loading={summaryQ.isLoading}
          />
        </section>

        <section className="mb-8 grid gap-4 md:grid-cols-2">
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <Terminal size={14} className="text-accent" />
              <h3 className="text-sm font-semibold">Base URL</h3>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-bg-base/70 px-3 py-2.5">
              <code className="flex-1 truncate font-mono text-xs text-accent">{baseUrl}</code>
              <CopyButton text={baseUrl} />
            </div>
          </Card>
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <KeyRound size={14} className="text-accent" />
              <h3 className="text-sm font-semibold">API key</h3>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-bg-base/70 px-3 py-2.5">
              <code className="flex-1 truncate font-mono text-xs text-accent">{visibleKey}</code>
              {primaryKey?.key ? <CopyButton text={primaryKey.key} /> : <CopyButton text="no-key-yet" disabled />}
            </div>
          </Card>
        </section>

        <section className="mb-10">
          <div className="mb-3 flex items-center gap-2">
            <Radio size={14} className="text-accent" />
            <h3 className="text-sm font-semibold">Top 5 models used · 30d</h3>
          </div>
          {byModelQ.isLoading ? (
            <Card>
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            </Card>
          ) : topModels.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-xs text-text-muted">No usage yet. Send a request through the gateway to see your top models here.</p>
            </Card>
          ) : (
            <Card className="p-0">
              <ol className="divide-y divide-border">
                {topModels.map((row, idx) => {
                  const pct = totalRequests ? Math.max(2, Math.round((row.requests / totalRequests) * 100)) : 0;
                  return (
                    <li key={`${row.model}-${idx}`} className="flex items-center gap-3 px-4 py-3">
                      <span className="w-6 text-center font-mono text-[11px] text-text-muted">{idx + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-text-primary">{row.model ?? "—"}</p>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-raised">
                          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs font-semibold text-text-primary">{fmtNum(row.requests)}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          )}
        </section>

        <section className="flex flex-col items-center gap-3 pt-2">
          <Button size="lg" variant="primary" onClick={() => navigate("/dashboard")}>
            Dashboard <ArrowRight size={16} />
          </Button>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl items-center justify-center px-5 py-5 text-[11px] text-text-muted">
        <span>© {new Date().getFullYear()} Mirais · local AI gateway</span>
      </footer>
    </div>
  );
}

function StatCard({ label, value, loading }: { label: string; value: string | null; loading: boolean }) {
  return (
    <Card className="border-accent/15 bg-[linear-gradient(160deg,rgba(124,92,255,0.12),rgba(18,22,31,0.92)_42%,rgba(18,22,31,0.96))]">
      <p className="text-[10px] uppercase tracking-[0.22em] text-accent/80">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">
        {loading ? <Skeleton className="h-8 w-24" /> : value}
      </p>
    </Card>
  );
}