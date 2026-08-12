import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import { type Provider, providers } from "../../api";
import { toast } from "../../components/ui";

type TestResult = Awaited<ReturnType<typeof providers.warmupAllAccounts>>["results"][number];

export function XaiAccountTestCard({ provider }: { provider: Provider }) {
  const [results, setResults] = useState<TestResult[]>([]);

  const testAccounts = useMutation({
    mutationFn: () => providers.warmupAllAccounts(provider.id),
    onSuccess: (data) => {
      setResults(data.results);
      toast(`Account test complete: ${data.success} passed, ${data.failed} failed`, data.failed ? "error" : "success");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Activity className="size-4 text-accent" /> Account Test</h2>
          <p className="mt-1 text-xs text-text-muted">Check each saved xAI account for a valid upstream response and latency.</p>
        </div>
        <button
          onClick={() => testAccounts.mutate()}
          disabled={testAccounts.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {testAccounts.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
          {testAccounts.isPending ? "Testing accounts…" : "Test all accounts"}
        </button>
      </div>

      {results.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-text-muted">Run a test to check all saved xAI accounts.</div>
      ) : (
        <div className="divide-y divide-border">
          {results.map((result, index) => (
            <div key={`${result.account}-${index}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
              {result.ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-destructive" />}
              <code className="min-w-0 flex-1 truncate text-xs">{result.account}</code>
              <span className="text-xs text-text-muted">HTTP {result.status}</span>
              <span className="inline-flex items-center gap-1 text-xs text-text-muted"><Clock3 className="size-3" /> {result.latency_ms} ms</span>
              {result.detail && <span className="w-full pl-8 text-xs text-destructive">{result.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
