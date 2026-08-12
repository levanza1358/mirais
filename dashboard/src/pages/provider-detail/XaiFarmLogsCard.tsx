import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Info, Loader2, Square, Trash2 } from "lucide-react";
import { providers } from "../../api";
import { toast } from "../../components/ui";

const iconForLevel = {
  info: <Info className="size-4 text-accent" />,
  success: <CheckCircle2 className="size-4 text-emerald-500" />,
  error: <CircleAlert className="size-4 text-destructive" />,
};

export function XaiFarmLogsCard() {
  const queryClient = useQueryClient();
  const logs = useQuery({
    queryKey: ["xai-farm-logs"],
    queryFn: providers.xaiFarmLogs,
    refetchInterval: 2_000,
  });
  const farmStatus = useQuery({
    queryKey: ["xai-farm-status"],
    queryFn: providers.xaiFarmStatus,
    refetchInterval: 2_000,
  });

  const clearMut = useMutation({
    mutationFn: () => providers.xaiFarmLogsClear(),
    onSuccess: () => {
      queryClient.setQueryData(["xai-farm-logs"], { entries: [] });
      queryClient.invalidateQueries({ queryKey: ["xai-farm-logs"] });
      toast("Farm logs cleared", "success");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const stopMut = useMutation({
    mutationFn: () => providers.xaiFarmStop(),
    onSuccess: () => {
      toast("Stop requested. In-flight account finishes, then the run halts.", "success");
      queryClient.invalidateQueries({ queryKey: ["xai-farm-logs"] });
      queryClient.invalidateQueries({ queryKey: ["xai-farm-status"] });
    },
    onError: (e) => toast(e.message, "error"),
  });

  const isRunning = farmStatus.data?.running === true || farmStatus.data?.stopped === true;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Farm Logs</h2>
          <p className="mt-1 text-xs text-text-muted">Operation status refreshes every two seconds. Credentials and tokens are never recorded.</p>
        </div>
        <div className="flex items-center gap-2">
          {logs.isFetching && <Loader2 className="size-4 animate-spin text-text-muted" />}
          {isRunning && (
            <button
              onClick={() => stopMut.mutate()}
              disabled={stopMut.isPending}
              className="flex items-center gap-1.5 rounded-md bg-destructive/10 border border-destructive/30 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
            >
              {stopMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              Stop farm
            </button>
          )}
          <button
            onClick={() => clearMut.mutate()}
            disabled={clearMut.isPending || !logs.data?.entries.length}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-muted hover:bg-muted hover:text-destructive disabled:opacity-40"
          >
            {clearMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Clear
          </button>
        </div>
      </div>
      {logs.isLoading ? <div className="px-5 py-10 text-center text-sm text-text-muted">Loading logs…</div> :
        logs.data?.entries.length ? <div className="max-h-[28rem] divide-y divide-border overflow-auto">
          {logs.data.entries.map((entry, index) => <div key={`${entry.ts}-${index}`} className="flex gap-3 px-5 py-3 text-sm">
            <div className="mt-0.5">{iconForLevel[entry.level]}</div>
            <div className="min-w-0 flex-1">
              <p>{entry.message}</p>
              {entry.email && <p className="mt-0.5 truncate font-mono text-xs text-text-muted">{entry.email}</p>}
            </div>
            <time className="shrink-0 text-xs text-text-muted">{new Date(entry.ts).toLocaleTimeString()}</time>
          </div>)}
        </div> : <div className="px-5 py-10 text-center text-sm text-text-muted">No operation logs yet.</div>}
    </section>
  );
}
