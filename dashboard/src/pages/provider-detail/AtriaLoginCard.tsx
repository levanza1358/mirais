import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Play, Square, Trash2 } from "lucide-react";
import { providers } from "../../api";
import { Button, Card, Switch, toast } from "../../components/ui";

interface Props {
  providerId: string;
}

/**
 * Batch Google sign-in for Atria accounts. Paste `email|password` per line; the
 * Camoufox driver signs in and creates a Mirais API key in the console. The API
 * key is the deliverable; quota scraping (which needs a session cookie) is a
 * separate feature on the accounts card.
 * See docs/10-atria-auto-login.md.
 */
export function AtriaLoginCard({ providerId }: Props) {
  const [accounts, setAccounts] = useState("");
  const [showBrowser, setShowBrowser] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const latest = useQuery({
    queryKey: ["atria-login-latest", providerId],
    queryFn: () => providers.atriaLoginLatest(providerId),
  });
  useEffect(() => {
    if (!jobId && latest.data?.job) setJobId(latest.data.job.id);
  }, [latest.data, jobId]);

  const status = useQuery({
    queryKey: ["atria-login", jobId],
    queryFn: () => providers.atriaLoginStatus(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data?.done ? false : 2000),
  });

  const logs = useQuery({
    queryKey: ["atria-login-logs", jobId],
    queryFn: () => providers.atriaLoginLogs(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data ? 1500 : false),
  });

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.data?.logs.length]);

  const lines = accounts.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

  const start = () => {
    if (lines.length === 0) return;
    providers.atriaLogin(providerId, lines, showBrowser).then((result) => {
      setJobId(result.jobId);
      latest.refetch();
      toast(`Atria login started for ${result.total} account(s)`);
    }).catch((error: Error) => toast(error.message, "error"));
  };

  const dismiss = () => {
    providers.atriaLoginDismiss(providerId).then(() => {
      setJobId(null);
      setAccounts("");
      queryClient.setQueryData(["atria-login-latest", providerId], { job: null });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    }).catch((error: Error) => toast(error.message, "error"));
  };

  const job = status.data;
  const logLines = logs.data?.logs ?? [];
  const succeeded = job?.results.filter((row) => row.success).length ?? 0;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Atria Auto-Login</h3>
          <p className="text-[11px] text-text-muted">Signs in through Google in Camoufox and creates an API key. Each account is saved with its key; the console session cookie (for token quota) is not captured by this flow.</p>
        </div>
        {job && !job.done && <Button variant="ghost" size="sm" onClick={() => setJobId(null)}><Square size={14} /> Stop</Button>}
        {job?.done && <Button variant="ghost" size="sm" onClick={dismiss}><Trash2 size={14} /> Clear</Button>}
      </div>

      {!jobId ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Google accounts — <code>email|password</code> per line</label>
            <textarea
              value={accounts}
              onChange={(event) => setAccounts(event.target.value)}
              placeholder={"user1@gmail.com|password1\nuser2@gmail.com|password2"}
              rows={6}
              className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={start} disabled={lines.length === 0}><Play size={14} /> Login via browser</Button>
            <span className="text-xs text-text-muted">{lines.length} account(s) detected</span>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-bg-base p-2">
            <div className="flex items-start gap-2">
              <Eye size={14} className="mt-0.5 shrink-0 text-text-muted" />
              <div>
                <p className="text-xs text-text-primary">Show browser window</p>
                <p className="mt-0.5 text-[11px] text-text-muted">
                  Opens the Camoufox window so you can watch each step. Useful
                  when Google shows an unexpected screen; leave off for
                  unattended batches.
                </p>
              </div>
            </div>
            <Switch checked={showBrowser} onChange={setShowBrowser} />
          </div>
          <p className="text-[11px] text-text-muted">
            Each account runs in its own persistent browser profile under <code>.atria-profiles/</code>.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            {!job?.done && <Loader2 size={14} className="animate-spin text-accent" />}
            <span className="text-xs font-medium">
              {job?.done ? `Done: ${succeeded}/${job.results.length} successful` : `Running… ${job?.results.length ?? 0} processed`}
            </span>
          </div>

          {job?.done && job.results.length > 0 && (
            <div className="rounded-lg border border-border bg-bg-base p-2">
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {job.results.map((row) => (
                  <div key={row.email} className="flex items-center gap-2 text-xs">
                    <span className={row.success ? "text-success" : "text-danger"}>{row.success ? "OK" : "FAIL"}</span>
                    <span className="truncate">{row.email}</span>
                    {row.error && <span className="truncate text-text-muted">{row.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {job?.error && <p className="text-xs text-danger">{job.error}</p>}

          <div className="rounded-lg border border-border bg-bg-base p-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Live Logs</div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
              {logLines.length === 0 ? <span className="text-text-muted">Waiting for logs…</span> : logLines.map((line, index) => (
                <div key={index} className="whitespace-pre-wrap break-all">{line}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
