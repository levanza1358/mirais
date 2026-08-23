import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { keys, stats } from "../api";
import { Button, CopyButton, Skeleton } from "../components/ui";
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
  const keysQ = useQuery({
    queryKey: ["keys"],
    queryFn: keys.list,
    staleTime: 60_000,
  });

  const totalRequests = summaryQ.data?.requests ?? 0;
  const totalTokens = (summaryQ.data?.input_tokens ?? 0) + (summaryQ.data?.output_tokens ?? 0);
  const successRate = summaryQ.data?.success_rate;

  const primaryKey = keysQ.data?.[0];
  const visibleKey = primaryKey?.key ?? storedKeyFor(primaryKey?.key_prefix ?? "") ?? (primaryKey ? `${primaryKey.key_prefix}${"•".repeat(18)}` : "mirais-••••••••••••••••");

  const baseUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}/v1`
    : "http://127.0.0.1:1463/v1";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
        <img src="/icon.png" alt="" className="mb-6 size-11 rounded-lg rise-in" />
        <h1 className="text-3xl font-semibold tracking-tight rise-in" style={{ "--rise-delay": "60ms" } as React.CSSProperties}>
          Mirais
        </h1>
        <p className="mt-2 text-sm text-muted-foreground rise-in" style={{ "--rise-delay": "120ms" } as React.CSSProperties}>
          Self-hosted AI gateway. One endpoint for every provider.
        </p>

        <dl className="group mt-10 grid grid-cols-3 gap-6 border-y border-border py-6 rise-in" style={{ "--rise-delay": "180ms" } as React.CSSProperties}>
          <Stat label="Requests" value={summaryQ.isLoading ? null : fmtNum(totalRequests)} />
          <Stat label="Tokens" value={summaryQ.isLoading ? null : fmtNum(totalTokens)} />
          <Stat
            label="Success"
            value={summaryQ.isLoading ? null : successRate === undefined ? "—" : `${(successRate * 100).toFixed(1)}%`}
          />
        </dl>

        <div className="mt-8 space-y-3 rise-in" style={{ "--rise-delay": "240ms" } as React.CSSProperties}>
          <Field label="Base URL" value={baseUrl} copy={baseUrl} />
          <Field label="API key" value={visibleKey} copy={primaryKey?.key ?? undefined} />
        </div>

        <Button size="lg" className="group mt-10 self-start" onClick={() => navigate("/dashboard")}>
          Open dashboard <ArrowRight className="transition-transform duration-300 group-hover:translate-x-1" />
        </Button>
      </main>
    </div>
  );
}

function Stat({ label, value, delay = 0 }: { label: string; value: string | null; delay?: number }) {
  return (
    <div className="hover-nudge" style={{ transitionDelay: `${delay}ms` }}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
        {value === null ? <Skeleton className="h-7 w-16" /> : value}
      </dd>
    </div>
  );
}

function Field({ label, value, copy }: { label: string; value: string; copy?: string }) {
  return (
    <div className="hover-lift group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <CopyButton text={copy ?? ""} disabled={!copy} />
    </div>
  );
}
