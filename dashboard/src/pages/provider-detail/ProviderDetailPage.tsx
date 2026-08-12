import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, RefreshCw, Trash2, Zap } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { type Provider, providers } from "../../api";
import { Badge, Button, Card, ConfirmModal, Skeleton, Switch, toast } from "../../components/ui";
import { presetForType } from "../../providerCatalog";
import { AccountsCard } from "./AccountsCard";
import { BackLink } from "./BackLink";
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
  const [warmupProgress, setWarmupProgress] = useState<{ current: number; total: number } | null>(null);

  const list = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const provider = list.data?.find((entry) => entry.id === id);
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
    mutationFn: async (providerId: string) => {
      let complete: { total: number; success: number; failed: number } | null = null;
      await providers.warmupAllAccountsStream(providerId, (event, data) => {
        if (event === "start") {
          setWarmupProgress({ current: 0, total: Number(data.total) });
          return;
        }
        if (event === "account_result") {
          const accountId = String(data.account_id);
          const ok = Boolean(data.ok);
          queryClient.setQueryData<Provider[]>(["providers"], (entries) => entries?.map((entry) => entry.id !== providerId ? entry : {
            ...entry,
            accounts: entry.accounts?.map((account) => account.id !== accountId ? account : {
              ...account,
              last_warmup_at: new Date().toISOString(),
              last_warmup_status: ok ? "healthy" : (Number(data.status) === 429 ? "rate_limited" : "failing"),
              last_warmup_latency_ms: Number(data.latency_ms),
              last_warmup_detail: typeof data.detail === "string" ? data.detail : null,
            }),
          }));
          setWarmupProgress({ current: Number(data.current), total: Number(data.total) });
          return;
        }
        if (event === "complete") complete = { total: Number(data.total), success: Number(data.success), failed: Number(data.failed) };
      });
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

  const preset = presetForType(provider.type);

  return (
    <div className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl text-sm font-bold" style={{ backgroundColor: `${preset.color}1f`, color: preset.color }}>
          {preset.iconSrc ? <img src={preset.iconSrc} alt={`${preset.displayName} logo`} className="size-7 object-contain" /> : preset.textIcon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{provider.name}</h1>
            <Badge tone={provider.type === "anthropic" ? "accent" : "muted"}>{preset.displayName}</Badge>
            {!provider.enabled && <Badge tone="warning">disabled</Badge>}
            {preset.credentialUrl && <a href={preset.credentialUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"><ExternalLink size={12} /> Get API key</a>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-text-muted">{provider.base_url_effective ?? provider.base_url ?? "—"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" loading={warmupAll.isPending} onClick={() => warmupAll.mutate(provider.id)}><Zap size={14} /> Warm up all</Button>
          {warmupProgress && <span className="text-xs text-text-muted">{warmupProgress.current}/{warmupProgress.total} accounts</span>}
          <Button variant="outline" size="sm" loading={testProvider.isPending} onClick={() => testProvider.mutate(provider.id)}><Zap size={14} /> Test</Button>
          <Button variant="outline" size="sm" loading={syncModels.isPending} onClick={() => syncModels.mutate(provider.id)}><RefreshCw size={14} /> Sync models</Button>
          <Switch checked={!!provider.enabled} onChange={() => toggle.mutate(provider)} aria-label="Toggle provider" />
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label="Edit provider"><Pencil size={14} /></Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(true)} aria-label="Delete provider"><Trash2 size={14} className="text-danger" /></Button>
        </div>
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
      ) : <AccountsCard provider={provider} />}
      <ModelsCard provider={provider} />
      {editing && <ProviderModal provider={provider} onClose={() => setEditing(false)} />}
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} onConfirm={() => removeProvider.mutate(provider.id)} title="Delete provider" message={`Delete ${provider.name}? Its accounts and model entries will also be removed. This cannot be undone.`} danger loading={removeProvider.isPending} />
    </div>
  );
}
