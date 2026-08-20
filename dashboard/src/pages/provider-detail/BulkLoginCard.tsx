import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { providers } from "../../api";
import { Button, Card, toast } from "../../components/ui";

interface Props {
  providerId: string;
}

export function BulkLoginCard({ providerId }: Props) {
  const [accounts, setAccounts] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Reattach to an in-flight/last job when the tab remounts
  const latest = useQuery({
    queryKey: ["copilot-bulk-latest", providerId],
    queryFn: () => providers.copilotBulkLatest(providerId),
  });
  useEffect(() => {
    if (!jobId && latest.data?.job) setJobId(latest.data.job.id);
  }, [latest.data, jobId]);

  const status = useQuery({
    queryKey: ["copilot-bulk", jobId],
    queryFn: () => providers.copilotBulkStatus(jobId!),
    enabled: !!jobId,
    refetchInterval: (data) => (data?.done ? false : 2000),
  });

  const logs = useQuery({
    queryKey: ["copilot-bulk-logs", jobId],
    queryFn: () => providers.copilotBulkLogs(jobId!),
    enabled: !!jobId,
    refetchInterval: (data) => (data?.done ? false : 1500),
  });

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs.data?.logs.length]);

  const startJob = (force = false, input?: string) => {
    const source = input ?? accounts;
    const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    providers.copilotBulk(providerId, source, force).then((r) => {
      setJobId(r.jobId);
      latest.refetch();
      toast(`Bulk login started for ${r.total} account(s)${force ? " (force)" : ""}`);
    }).catch((e) => toast(e.message, "error"));
  };

  const dismiss = () => {
    providers.copilotBulkDismiss(providerId).then(() => {
      setJobId(null);
      setAccounts("");
      queryClient.setQueryData(["copilot-bulk-latest", providerId], { job: null });
    }).catch((e) => toast(e.message, "error"));
  };

  const retryFailed = () => {
    const failed = (job?.results ?? []).filter((r) => !r.success && r.error === "Account already exists").map((r) => r.email);
    if (failed.length === 0) return;
    const lines = accounts.split(/\r?\n/).filter((l) => {
      const email = l.split("|", 1)[0]?.trim().toLowerCase();
      return email && failed.some((f) => f.toLowerCase() === email);
    });
    const input = lines.length > 0 ? lines.join("\n") : failed.map((e) => `${e}|`).join("\n");
    dismiss();
    setAccounts(input);
    startJob(true, input);
  };

  const stopPolling = () => setJobId(null);

  const job = status.data;
  const logLines = logs.data?.logs ?? [];

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Bulk Google Login</h3>
        {job && !job.done && <Button variant="ghost" size="sm" onClick={stopPolling}><Square size={14} /> Stop</Button>}
        {job?.done && (
          <div className="flex gap-1">
            {job.results.some((r) => !r.success && r.error === "Account already exists") && (
              <Button variant="ghost" size="sm" onClick={retryFailed}><RotateCcw size={14} /> Retry (force)</Button>
            )}
            <Button variant="ghost" size="sm" onClick={dismiss}><Trash2 size={14} /> Clear</Button>
          </div>
        )}
      </div>

      {!jobId ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">
              Google Workspace accounts — <code>email|password</code> per line
            </label>
            <textarea
              value={accounts}
              onChange={(e) => setAccounts(e.target.value)}
              placeholder={"user1@domain.com|password1\nuser2@domain.com|password2"}
              rows={6}
              className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => startJob()} disabled={!accounts.trim()}>
              <Play size={14} /> Start bulk login
            </Button>
            <span className="text-xs text-text-muted">
              {accounts.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).length} account(s) detected
            </span>
          </div>
          <p className="text-[11px] text-text-muted">
            Camoufox browser akan login otomatis ke setiap akun Google Workspace, enable Copilot Free, dan authorize CLI.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Progress */}
          <div className="flex items-center gap-2">
            {!job?.done && <Loader2 size={14} className="animate-spin text-accent" />}
            <span className="text-xs font-medium">
              {job?.done
                ? `Done: ${job.results.filter((r) => r.success).length}/${job.results.length} successful`
                : `Running... ${job?.results.length ?? 0} processed`}
            </span>
          </div>

          {/* Results summary */}
          {job?.done && job.results.length > 0 && (
            <div className="rounded-lg border border-border bg-bg-base p-2">
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {job.results.map((r) => (
                  <div key={r.email} className="flex items-center gap-2 text-xs">
                    <span className={r.success ? "text-success" : "text-danger"}>{r.success ? "OK" : "FAIL"}</span>
                    <span className="truncate">{r.email}</span>
                    {r.error && <span className="truncate text-text-muted">{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Live logs */}
          <div className="rounded-lg border border-border bg-bg-base p-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Live Logs</div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
              {logLines.length === 0 ? (
                <span className="text-text-muted">Waiting for logs...</span>
              ) : (
                logLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
