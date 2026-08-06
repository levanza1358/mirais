import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronRight, Plus } from "lucide-react";
import { providers, type Provider } from "../api";
import { Card, Switch, Badge, EmptyState, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { PROVIDER_PRESETS, presetForType, type ProviderPreset } from "../providerCatalog";

export default function Providers() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["providers"] });

  const toggle = useMutation({
    mutationFn: (p: Provider) => providers.update(p.id, { enabled: !p.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const createAndOpen = useMutation({
    mutationFn: (preset: ProviderPreset) =>
      providers.create({ name: preset.name, type: preset.type, baseUrl: preset.baseUrl }),
    onSuccess: (p) => {
      invalidate();
      navigate(`/providers/${p.id}`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const existing = list.data ?? [];
  const byType = new Map<string, Provider[]>();
  for (const p of existing) {
    const arr = byType.get(p.type) ?? [];
    arr.push(p);
    byType.set(p.type, arr);
  }
  // Providers whose type isn't in the preset catalog (legacy/unknown types).
  const knownTypes = new Set(PROVIDER_PRESETS.map((p) => p.type));
  const others = existing.filter((p) => !knownTypes.has(p.type));
  const enabledPresets = PROVIDER_PRESETS.filter((preset) => (byType.get(preset.type)?.[0]?.enabled ?? false));
  const disabledPresets = PROVIDER_PRESETS.filter((preset) => !(byType.get(preset.type)?.[0]?.enabled ?? false));
  const enabledOthers = others.filter((p) => !!p.enabled);
  const disabledOthers = others.filter((p) => !p.enabled);

  const openPreset = (preset: ProviderPreset) => {
    const found = byType.get(preset.type)?.[0];
    if (found) navigate(`/providers/${found.id}`);
    else createAndOpen.mutate(preset);
  };

  return (
    <div>
      <PageHeader title="Providers" />

      {list.isLoading ? null : (
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Enabled providers</h2>
              <span className="text-xs text-text-muted">{enabledPresets.length + enabledOthers.length} shown</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {enabledPresets.map((preset) => {
                const instances = byType.get(preset.type) ?? [];
                const primary = instances[0];
                return (
                  <ProviderCard
                    key={preset.type}
                    preset={preset}
                    provider={primary}
                    extraCount={Math.max(0, instances.length - 1)}
                    onOpen={() => openPreset(preset)}
                    onToggle={primary ? () => toggle.mutate(primary) : undefined}
                    toggling={toggle.isPending && toggle.variables?.id === primary?.id}
                  />
                );
              })}
              {enabledOthers.map((p) => (
                <ProviderCard
                  key={p.id}
                  preset={presetForType(p.type)}
                  provider={p}
                  extraCount={0}
                  onOpen={() => navigate(`/providers/${p.id}`)}
                  onToggle={() => toggle.mutate(p)}
                  toggling={toggle.isPending && toggle.variables?.id === p.id}
                />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-muted">Disabled / not configured</h2>
              <span className="text-xs text-text-muted">{disabledPresets.length + disabledOthers.length} shown</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {disabledPresets.map((preset) => {
                const instances = byType.get(preset.type) ?? [];
                const primary = instances[0];
                return (
                  <ProviderCard
                    key={preset.type}
                    preset={preset}
                    provider={primary}
                    extraCount={Math.max(0, instances.length - 1)}
                    onOpen={() => openPreset(preset)}
                    onToggle={primary ? () => toggle.mutate(primary) : undefined}
                    toggling={toggle.isPending && toggle.variables?.id === primary?.id}
                    dimmed
                  />
                );
              })}
              {disabledOthers.map((p) => (
                <ProviderCard
                  key={p.id}
                  preset={presetForType(p.type)}
                  provider={p}
                  extraCount={0}
                  onOpen={() => navigate(`/providers/${p.id}`)}
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
            hint="Pick a provider card above to open its page and add your first API key."
          />
        </Card>
      )}
    </div>
  );
}

function ProviderCard({
  preset,
  provider,
  extraCount,
  onOpen,
  onToggle,
  toggling,
  dimmed,
}: {
  preset: ProviderPreset;
  provider: Provider | undefined;
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
            <p className="mt-0.5 truncate text-xs text-text-muted">{preset.description}</p>
          </div>
          <ChevronRight size={16} className="mt-1 shrink-0 text-text-muted/40 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-block size-2 rounded-full ${connected ? "bg-success" : "bg-text-muted/30"}`} />
            {provider ? (
              <span className="text-text-muted">
                {activeAccounts}/{accounts} account{accounts === 1 ? "" : "s"} · {models} model{models === 1 ? "" : "s"}
                {extraCount > 0 && ` · +${extraCount} more`}
              </span>
            ) : (
              <span className="text-text-muted/60">Not configured</span>
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
