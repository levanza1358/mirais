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

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      const total = (provider?.accounts ?? []).filter((account) => !!account.enabled).length;
      setWarmupProgress(total > 0 ? { current: 0, total } : null);
      if (total === 0) return providers.warmupAllAccounts(providerId);
      const interval = window.setInterval(() => {
        setWarmupProgress((prev) => {
          if (!prev) return prev;
          if (prev.current >= Math.max(prev.total - 1, 0)) return prev;
          return { ...prev, current: prev.current + 1 };
        });
      }, 250);
      try {
        const result = await providers.warmupAllAccounts(providerId);
        setWarmupProgress({ current: total, total });
        return result;
      } finally {
        window.clearInterval(interval);
      }
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
      <AccountsCard provider={provider} />
      <ModelsCard provider={provider} />
      {editing && <ProviderModal provider={provider} onClose={() => setEditing(false)} />}
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} onConfirm={() => removeProvider.mutate(provider.id)} title="Delete provider" message={`Delete ${provider.name}? Its accounts and model entries will also be removed. This cannot be undone.`} danger loading={removeProvider.isPending} />
    </div>
  );
}
