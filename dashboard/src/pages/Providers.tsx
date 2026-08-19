import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronRight, Plus, AlertTriangle, RefreshCw } from "lucide-react";
import { providers, healthInfo, type Provider } from "../api";
import { Button, Card, Input, Modal, Switch, Badge, EmptyState, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { PROVIDER_PRESETS, presetFor, isCatalogPreset, type ProviderPreset } from "../providerCatalog";

/** Fixed catalog tiles, always rendered. User-created custom providers get their own card each. */
const CATALOG = PROVIDER_PRESETS.filter(isCatalogPreset);

export default function Providers() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery<Provider[], Error>({
    queryKey: ["providers"],
    queryFn: providers.list,
    retry: 1,
  });
  const detailedHealth = useQuery({
    queryKey: ["health-detailed"],
    queryFn: healthInfo.detailed,
    retry: 1,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["providers"] });

  const toggle = useMutation({
    mutationFn: (p: Provider) => providers.update(p.id, { enabled: !p.enabled }),
    onSuccess: (p) => { invalidate(); toast(p.enabled ? "Provider disabled" : "Provider enabled"); },
    onError: (e) => toast(e.message, "error"),
  });

  const createAndOpen = useMutation({
    mutationFn: (preset: ProviderPreset) =>
      providers.create({ name: preset.name, type: preset.type, baseUrl: preset.baseUrl }),
    onSuccess: (p) => {
      invalidate();
      toast("Provider created");
      navigate(`/dashboard/providers/${p.id}`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "" });
  const createCustom = useMutation({
    mutationFn: () =>
      providers.create({ name: form.name.trim(), type: "custom", baseUrl: form.baseUrl.trim() || undefined }),
    onSuccess: (p) => {
      invalidate();
      setAddOpen(false);
      setForm({ name: "", baseUrl: "" });
      toast("Custom provider created");
      navigate(`/dashboard/providers/${p.id}`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const existing = list.data ?? [];

  // Fetch quota summaries for all existing providers
  const quotaQueries = useQueries({
    queries: existing.map((p) => ({
      queryKey: ["provider-quota", p.id],
      queryFn: () => providers.quotaSummary(p.id),
      staleTime: 60_000,
      retry: 1,
    })),
  });
  const quotaById = new Map(existing.map((p, i) => [p.id, quotaQueries[i]]));

  // A catalog tile owns providers matching its name, or (for the type-specific presets) its type.
  const claimed = new Set<string>();
  const tiles = CATALOG.map((preset) => {
    const instances = existing.filter((p) =>
      preset.type === "custom" ? p.name === preset.name : p.type === preset.type,
    );
    for (const p of instances) claimed.add(p.id);
    return { preset, primary: instances[0], extraCount: Math.max(0, instances.length - 1) };
  });
  // Everything else (user-created custom providers, legacy/unknown types) gets its own card.
  const others = existing.filter((p) => !claimed.has(p.id));

  const enabledTiles = tiles.filter((t) => t.primary?.enabled);
  const disabledTiles = tiles.filter((t) => !t.primary?.enabled);
  const enabledOthers = others.filter((p) => !!p.enabled);
  const disabledOthers = others.filter((p) => !p.enabled);

  const openPreset = (preset: ProviderPreset, primary: Provider | undefined) => {
    if (primary) navigate(`/dashboard/providers/${primary.id}`);
    else createAndOpen.mutate(preset);
  };

  return (
    <div>
      <PageHeader title="Providers">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} /> Add custom provider
        </Button>
      </PageHeader>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add custom provider">
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); createCustom.mutate(); }}
        >
          <label className="block text-xs text-text-muted">
            Name
            <Input
              className="mt-1"
              autoFocus
              required
              pattern="[a-z0-9][a-z0-9\-_]*"
              maxLength={64}
              placeholder="my-endpoint"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <span className="mt-1 block text-[11px] text-text-muted/70">Lowercase letters, digits, dash, underscore. Must be unique.</span>
          </label>
          <label className="block text-xs text-text-muted">
            Base URL
            <Input
              className="mt-1"
              type="url"
              required
              placeholder="https://api.example.com/v1"
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
            <span className="mt-1 block text-[11px] text-text-muted/70">Any OpenAI-compatible endpoint.</span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={createCustom.isPending}>
              {createCustom.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : list.isError ? (
        <Card className="mt-2 border-danger/30 bg-danger/5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-danger">Couldn't read the provider database.</p>
              <p className="mt-1 text-xs text-text-muted">
                {list.error instanceof Error ? list.error.message : "The /api/providers request failed."}
              </p>
              <p className="mt-2 text-xs text-text-muted">
                Database path: <span className="font-mono">{detailedHealth.data?.storage.db_path ?? "loading…"}</span>
                {detailedHealth.data ? (
                  <>
                    {" · "}
                    {detailedHealth.data.storage.db_exists ? `${(detailedHealth.data.storage.size_bytes / 1024).toFixed(0)} KB` : "missing on disk"}
                  </>
                ) : null}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => { invalidate(); detailedHealth.refetch(); }}>
              <RefreshCw size={13} /> Retry
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Enabled providers</h2>
              <span className="text-xs text-text-muted">{enabledTiles.length + enabledOthers.length} shown</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {enabledTiles.map(({ preset, primary, extraCount }) => (
                <ProviderCard
                  key={preset.name}
                  preset={preset}
                  provider={primary}
                  quota={primary ? quotaById.get(primary.id) : undefined}
                  extraCount={extraCount}
                  onOpen={() => openPreset(preset, primary)}
                  onToggle={primary ? () => toggle.mutate(primary) : undefined}
                  toggling={toggle.isPending && toggle.variables?.id === primary?.id}
                />
              ))}
              {enabledOthers.map((p) => (
                <ProviderCard
                  key={p.id}
                  preset={presetFor(p)}
                  provider={p}
                  quota={quotaById.get(p.id)}
                  extraCount={0}
                  onOpen={() => navigate(`/dashboard/providers/${p.id}`)}
                  onToggle={() => toggle.mutate(p)}
                  toggling={toggle.isPending && toggle.variables?.id === p.id}
                />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-muted">Disabled / not configured</h2>
              <span className="text-xs text-text-muted">{disabledTiles.length + disabledOthers.length} shown</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {disabledTiles.map(({ preset, primary, extraCount }) => (
                <ProviderCard
                  key={preset.name}
                  preset={preset}
                  provider={primary}
                  quota={primary ? quotaById.get(primary.id) : undefined}
                  extraCount={extraCount}
                  onOpen={() => openPreset(preset, primary)}
                  onToggle={primary ? () => toggle.mutate(primary) : undefined}
                  toggling={toggle.isPending && toggle.variables?.id === primary?.id}
                  dimmed
                />
              ))}
              {disabledOthers.map((p) => (
                <ProviderCard
                  key={p.id}
                  preset={presetFor(p)}
                  provider={p}
                  quota={quotaById.get(p.id)}
                  extraCount={0}
                  onOpen={() => navigate(`/dashboard/providers/${p.id}`)}
                  onToggle={() => toggle.mutate(p)}
                  toggling={toggle.isPending && toggle.variables?.id === p.id}
                  dimmed
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {!list.isLoading && existing.length === 0 && (
        <Card className="mt-4">
          <EmptyState
            icon={<Boxes size={32} />}
            title="No accounts connected yet"
            hint={
              detailedHealth.data?.storage
                ? `Pick a provider card above to open its page and add your first API key. The server's database is at ${detailedHealth.data.storage.db_path}${detailedHealth.data.storage.db_exists ? "" : " (no file yet — it will be created on first write)"}.`
                : "Pick a provider card above to open its page and add your first API key."
            }
          />
        </Card>
      )}
    </div>
  );
}

function ProviderCard({
  preset,
  provider,
  quota,
  extraCount,
  onOpen,
  onToggle,
  toggling,
  dimmed,
}: {
  preset: ProviderPreset;
  provider: Provider | undefined;
  quota?: { data?: { total_credits: number | null; unlimited: boolean | null; accounts_with_quota: number; accounts_total: number; accounts_free: number; free_remaining_pct: number | null }; isLoading: boolean };
  extraCount: number;
  onOpen: () => void;
  onToggle?: () => void;
  toggling?: boolean;
  dimmed?: boolean;
}) {
  const accounts = provider?.accounts?.length ?? 0;
  const activeAccounts = provider?.accounts?.filter((a) => a.enabled).length ?? 0;
  const models = provider?.models?.length ?? 0;
  const connected = !!provider && accounts > 0;

  // Account status breakdown
  const statusBreakdown = provider?.accounts
    ? {
        healthy: provider.accounts.filter((a) => a.last_warmup_status === "healthy").length,
        rateLimited: provider.accounts.filter((a) => a.last_warmup_status === "rate_limited").length,
        failing: provider.accounts.filter((a) => a.last_warmup_status === "failing").length,
        unknown: provider.accounts.filter((a) => !a.last_warmup_status).length,
      }
    : null;

  const quotaData = quota?.data;
  const quotaTotal = quotaData?.total_credits;
  const quotaUnlimited = quotaData?.unlimited;

  return (
    <div
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      role="button"
      tabIndex={0}
      className="group cursor-pointer rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Card className={`h-full p-4 transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-accent/40 group-hover:shadow-lg ${dimmed ? "border-border/50 bg-bg-surface/45 opacity-80" : ""}`}>
        <div className="flex items-start gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
            style={{ backgroundColor: preset.iconSrc ? `${preset.color}22` : `${preset.color}1f`, color: preset.color }}
          >
            {preset.iconSrc ? (
              <img src={preset.iconSrc} alt={`${preset.displayName} logo`} className="size-6 object-contain" />
            ) : (
              preset.textIcon
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{provider?.name ?? preset.displayName}</h3>
              {provider && !provider.enabled && <Badge tone="warning">disabled</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {(!isCatalogPreset(preset) && provider?.base_url) || preset.description}
            </p>
          </div>
          <ChevronRight size={16} className="mt-1 shrink-0 text-text-muted/40 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-block size-2 shrink-0 rounded-full ${connected ? "bg-success" : "bg-text-muted/30"}`} />
              {provider ? (
                <span className="truncate text-text-muted">
                  {quota?.isLoading ? (
                    "Loading…"
                  ) : quotaData && (quotaData.accounts_with_quota > 0 || quotaData.accounts_free > 0) ? (
                    quotaUnlimited
                      ? "Unlimited credits"
                      : quotaTotal != null
                        ? quotaTotal.toLocaleString() + " credits"
                        : quotaData.free_remaining_pct != null
                          ? quotaData.free_remaining_pct + "% available"
                          : quotaData.accounts_free + " free account" + (quotaData.accounts_free === 1 ? "" : "s")
                  ) : (
                    models + " model" + (models === 1 ? "" : "s")
                  )}
                  {quotaData && quotaData.accounts_with_quota > 0 && quotaData.accounts_free > 0 && (
                    " · " + quotaData.accounts_free + " free"
                  )}
                  {extraCount > 0 && " · +" + extraCount + " more"}
                </span>
              ) : (
                <span className="text-text-muted/60">Not configured</span>
              )}
            </div>
            {statusBreakdown && accounts > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                {statusBreakdown.healthy > 0 && (
                  <span className="inline-flex items-center gap-1 text-success"><span className="inline-block size-1.5 rounded-full bg-success" />{statusBreakdown.healthy}</span>
                )}
                {statusBreakdown.rateLimited > 0 && (
                  <span className="inline-flex items-center gap-1 text-warning"><span className="inline-block size-1.5 rounded-full bg-warning" />{statusBreakdown.rateLimited}</span>
                )}
                {statusBreakdown.failing > 0 && (
                  <span className="inline-flex items-center gap-1 text-danger"><span className="inline-block size-1.5 rounded-full bg-danger" />{statusBreakdown.failing}</span>
                )}
                {statusBreakdown.unknown > 0 && (
                  <span className="inline-flex items-center gap-1 text-text-muted"><span className="inline-block size-1.5 rounded-full bg-text-muted" />{statusBreakdown.unknown}</span>
                )}
              </div>
            )}
          </div>
          {provider && onToggle ? (
            <span
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              onKeyDown={(e) => e.stopPropagation()}
              role="presentation"
            >
              <Switch checked={!!provider.enabled} onChange={onToggle} disabled={toggling} aria-label={`Enable ${provider.name}`} />
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">
              <Plus size={12} /> Set up
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
