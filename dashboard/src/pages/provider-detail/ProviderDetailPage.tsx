import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, RefreshCw, Trash2, Zap } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { providerHealth, type Provider, providers } from "../../api";
import { Badge, Button, Card, ConfirmModal, Modal, Skeleton, Switch, toast } from "../../components/ui";
import { presetFor } from "../../providerCatalog";
import { AccountsCard } from "./AccountsCard";
import { BackLink } from "./BackLink";
import { BulkLoginCard } from "./BulkLoginCard";
import { ModelsCard } from "./ModelsCard";
import { ProviderModal } from "./ProviderModal";
import { XaiAccountTestCard } from "./XaiAccountTestCard";
import { XaiFarmCard } from "./XaiFarmCard";
import { XaiFarmLogsCard } from "./XaiFarmLogsCard";

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [xaiTab, setXaiTab] = useState<"accounts" | "farm-logs" | "account-test">("accounts");
  const [copilotTab, setCopilotTab] = useState<"accounts" | "bulk-login">("accounts");
  const [warmupProgress, setWarmupProgress] = useState<{ current: number; total: number } | null>(null);
  const [warmupChoice, setWarmupChoice] = useState<"all" | "healthy" | "rate_limited" | "failing" | "unknown" | null>(null);

  const list = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const provider = list.data?.find((entry) => entry.id === id);
  const health = useQuery({ queryKey: ["provider-health", "detail", provider?.name], queryFn: () => providerHealth.list(7), enabled: !!provider, refetchInterval: 30_000 });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["providers"] });

  const toggle = useMutation({
    mutationFn: (entry: Provider) => providers.update(entry.id, { enabled: !entry.enabled }),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, "error"),
  });

  const removeProvider = useMutation({
    mutationFn: (providerId: string) => providers.remove(providerId),
    onSuccess: () => {
      invalidate();
      toast("Provider deleted");
      navigate("/dashboard/providers");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const testProvider = useMutation({
    mutationFn: (providerId: string) => providers.test(providerId),
    onSuccess: (result) => {
      toast(result.ok ? `Connected (${result.latency_ms}ms)` : `Failed: ${result.detail ?? `HTTP ${result.status}`}`, result.ok ? "success" : "error");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const warmupAll = useMutation({
    mutationFn: async ({ providerId, status }: { providerId: string; status: "all" | "healthy" | "rate_limited" | "failing" | "unknown" }): Promise<{ total: number; success: number; failed: number }> => {
      let complete: { total: number; success: number; failed: number } | null = null;
      await providers.warmupAllAccountsStream(providerId, (event, data) => {
        if (event === "start") {
          setWarmupProgress({ current: 0, total: Number(data.total) });
          return;
        }
        if (event === "account_result") {
          const accountId = String(data.account_id);
          queryClient.setQueryData<Provider[]>(["providers"], (entries) => entries?.map((entry) => entry.id !== providerId ? entry : {
            ...entry,
            accounts: entry.accounts?.map((account) => account.id !== accountId ? account : {
              ...account,
              last_warmup_at: new Date().toISOString(),
              last_warmup_status: String(data.warmup_status) as "healthy" | "rate_limited" | "failing",
              last_warmup_latency_ms: Number(data.latency_ms),
              last_warmup_detail: typeof data.detail === "string" ? data.detail : null,
            }),
          }));
          setWarmupProgress({ current: Number(data.current), total: Number(data.total) });
          return;
        }
        if (event === "complete") complete = { total: Number(data.total), success: Number(data.success), failed: Number(data.failed) };
      }, status);
      if (!complete) throw new Error("Warmup stream ended before completion");
      return complete;
    },
    onSuccess: (result) => {
      invalidate();
      setWarmupProgress({ current: result.total, total: result.total });
      window.setTimeout(() => setWarmupProgress(null), 1200);
      toast(`Warmup done: ${result.success}/${result.total} active${result.failed ? ` · ${result.failed} failed` : ""}`, result.failed ? "error" : "success");
    },
    onError: (error: Error) => {
      setWarmupProgress(null);
      toast(error.message, "error");
    },
  });

  const syncModels = useMutation({
    mutationFn: (providerId: string) => providers.sync(providerId),
    onSuccess: (result) => {
      invalidate();
      toast(`Synced ${result.synced} models`);
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  if (list.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;
  }

  if (!provider) {
    return <div className="space-y-4"><BackLink /><Card><p className="py-8 text-center text-sm text-text-muted">Provider not found.</p></Card></div>;
  }

  const preset = presetFor(provider);
  const healthRow = health.data?.find((item) => item.provider === provider.name);
  const accounts = provider.accounts ?? [];
  const activeAccounts = accounts.filter((account) => account.enabled).length;
  const healthyAccounts = accounts.filter((account) => account.last_warmup_status === "healthy").length;
  const activeModels = (provider.models ?? []).filter((model) => model.enabled).length;

  return (
    <div className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl text-sm font-bold" style={{ backgroundColor: `${preset.color}1f`, color: preset.color }}>
          {preset.iconSrc ? <img src={preset.iconSrc} alt={`${preset.displayName} logo`} className="size-7 object-contain" /> : preset.textIcon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{provider.display_name || provider.name}</h1>
            <Badge tone={provider.type === "anthropic" ? "accent" : "muted"}>{preset.displayName}</Badge>
            {!provider.enabled && <Badge tone="warning">disabled</Badge>}
            {preset.credentialUrl && <a href={preset.credentialUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"><ExternalLink size={12} /> Get API key</a>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-text-muted">{provider.base_url_effective ?? provider.base_url ?? "—"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" loading={warmupAll.isPending} onClick={() => setWarmupChoice("all")}><Zap size={14} /> Warm up</Button>
          {warmupProgress && <span className="text-xs text-text-muted">{warmupProgress.current}/{warmupProgress.total} accounts</span>}
          <Button variant="outline" size="sm" loading={testProvider.isPending} onClick={() => testProvider.mutate(provider.id)}><Zap size={14} /> Test</Button>
          <Button variant="outline" size="sm" loading={syncModels.isPending} onClick={() => syncModels.mutate(provider.id)}><RefreshCw size={14} /> Sync models</Button>
          <Switch checked={!!provider.enabled} onChange={() => toggle.mutate(provider)} aria-label="Toggle provider" />
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label="Edit provider"><Pencil size={14} /></Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(true)} aria-label="Delete provider"><Trash2 size={14} className="text-danger" /></Button>
        </div>
      </div>
      <Modal open={warmupChoice !== null} onClose={() => setWarmupChoice(null)} title="Warm up accounts">
        <p className="mb-4 text-sm text-text-muted">Choose which enabled accounts should be tested.</p>
        <div className="grid gap-2">
          {([ ["all", "All"], ["healthy", "Healthy"], ["rate_limited", "Rate limited"], ["failing", "Failing"], ["unknown", "Unknown"] ] as const).map(([status, label]) => {
            const color = status === "healthy"
              ? "border-success/50 bg-success/15 text-success hover:bg-success/25"
              : status === "rate_limited"
                ? "border-warning/50 bg-warning/15 text-warning hover:bg-warning/25"
                : status === "failing"
                  ? "border-danger/50 bg-danger/15 text-danger hover:bg-danger/25"
                  : "border-border bg-bg-surface text-text-primary hover:bg-bg-raised";
            return <Button key={status} variant="outline" className={`justify-center ${color}`} onClick={() => { setWarmupChoice(null); warmupAll.mutate({ providerId: provider.id, status }); }}>{label}</Button>;
          })}
        </div>
      </Modal>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Summary label="Accounts" value={`${activeAccounts}/${accounts.length}`} hint="enabled" />
        <Summary label="Warmup health" value={`${healthyAccounts}/${accounts.length}`} hint="healthy" tone={accounts.length > 0 && healthyAccounts === 0 ? "warning" : "success"} />
        <Summary label="Models" value={String(activeModels)} hint={`${(provider.models ?? []).length} registered`} />
        <Summary label="Requests (7d)" value={healthRow ? healthRow.requests.toLocaleString() : "—"} hint={healthRow ? `${(healthRow.error_rate * 100).toFixed(1)}% errors` : "no data"} tone={healthRow && healthRow.error_rate >= 0.2 ? "danger" : healthRow && healthRow.error_rate >= 0.05 ? "warning" : "success"} />
        <Summary label="Latency" value={healthRow ? `${healthRow.avg_latency_ms}ms` : "—"} hint="average" />
      </div>
      {provider.type === "xai" ? (
        <>
          <div className="flex w-fit rounded-lg border border-border bg-card p-1" role="tablist" aria-label="xAI provider sections">
            {([
              ["accounts", "Accounts"],
              ["farm-logs", "Farm Logs"],
              ["account-test", "Account Test"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={xaiTab === tab}
                onClick={() => setXaiTab(tab)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${xaiTab === tab ? "bg-primary text-primary-foreground" : "text-text-muted hover:bg-muted hover:text-text"}`}
              >{label}</button>
            ))}
          </div>
          {xaiTab === "accounts" && <><AccountsCard provider={provider} /><XaiFarmCard provider={provider} onDone={invalidate} /></>}
          {xaiTab === "farm-logs" && <XaiFarmLogsCard />}
          {xaiTab === "account-test" && <XaiAccountTestCard provider={provider} />}
        </>
      ) : provider.type === "github-copilot" ? (
        <>
          <div className="flex w-fit rounded-lg border border-border bg-card p-1" role="tablist" aria-label="Copilot provider sections">
            {([
              ["accounts", "Accounts"],
              ["bulk-login", "Bulk Login"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={copilotTab === tab}
                onClick={() => setCopilotTab(tab)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${copilotTab === tab ? "bg-primary text-primary-foreground" : "text-text-muted hover:bg-muted hover:text-text"}`}
              >{label}</button>
            ))}
          </div>
          {copilotTab === "accounts" && <AccountsCard provider={provider} />}
          {copilotTab === "bulk-login" && <BulkLoginCard providerId={provider.id} />}
        </>
      ) : <AccountsCard provider={provider} />}
      <ModelsCard provider={provider} />
      {editing && <ProviderModal provider={provider} onClose={() => setEditing(false)} />}
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} onConfirm={() => removeProvider.mutate(provider.id)} title="Delete provider" message={`Delete ${provider.name}? Its accounts and model entries will also be removed. This cannot be undone.`} danger loading={removeProvider.isPending} />
    </div>
  );
}

function Summary({ label, value, hint, tone = "default" }: { label: string; value: string; hint: string; tone?: "default" | "success" | "warning" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-text-primary";
  return <Card className="p-3"><p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</p><p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p><p className="text-[11px] text-text-muted">{hint}</p></Card>;
}
