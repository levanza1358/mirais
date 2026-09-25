import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleX,
  Copy,
  GitBranch,
  GripVertical,
  Layers,
  Play,
  Plus,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { combos, providers, type Combo, type ComboDiagnostic, type Provider } from "../api";
import { Button, Card, Modal, Input, Select, Badge, EmptyState, ConfirmModal, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

/** A single step inside a combo chain, resolved against the live provider list. */
type ChainStep = {
  target: string;
  healthy: number;
  total: number;
  known: boolean;
};

/** Resolve a `provider/model` target against the provider list for health data. */
function resolveStep(target: string, providerList: Provider[]): ChainStep {
  const slash = target.indexOf("/");
  if (slash <= 0) return { target, healthy: 0, total: 0, known: false };
  const providerName = target.slice(0, slash);
  const modelId = target.slice(slash + 1);
  const provider = providerList.find((p) => p.name === providerName);
  if (!provider) return { target, healthy: 0, total: 0, known: false };
  const accounts = (provider.accounts ?? []).filter((a) => a.enabled);
  const healthy = accounts.filter((a) => a.last_warmup_status === "healthy").length;
  const known = (provider.models ?? []).some((m) => m.model_id === modelId && m.enabled);
  return { target, healthy, total: accounts.length, known };
}

export default function Combos() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Combo | "new" | null>(null);
  const [deleting, setDeleting] = useState<Combo | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, ComboDiagnostic>>({});
  const [search, setSearch] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);

  const list = useQuery({ queryKey: ["combos"], queryFn: combos.list });
  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["combos"] });
  const providerList = providersQuery.data ?? [];

  const del = useMutation({
    mutationFn: (id: string) => combos.remove(id),
    onSuccess: () => { invalidate(); setDeleting(null); toast("Combo deleted"); },
    onError: (e) => toast(e.message, "error"),
  });
  const testCombo = useMutation({
    mutationFn: (id: string) => combos.test(id),
    onSuccess: (result, id) => setDiagnostics((current) => ({ ...current, [id]: result })),
    onError: (e) => toast(e.message, "error"),
  });

  const all = list.data ?? [];

  const enriched = useMemo(() => all.map((combo) => {
    const steps = combo.entries
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((entry) => resolveStep(entry.target, providerList));
    // A chain needs attention when any step is missing a healthy account.
    const problems = steps.filter((step) => !step.known || step.healthy === 0).length;
    return { combo, steps, problems };
  }), [all, providerList]);

  const filtered = enriched.filter(({ combo, problems }) => {
    if (onlyProblems && problems === 0) return false;
    if (!search.trim()) return true;
    return combo.name.toLowerCase().includes(search.trim().toLowerCase());
  });

  const totalTargets = enriched.reduce((sum, item) => sum + item.steps.length, 0);
  const healthyCombos = enriched.filter((item) => item.problems === 0).length;

  const testAll = useMutation({
    mutationFn: async () => {
      const results: Record<string, ComboDiagnostic> = {};
      for (const combo of all) results[combo.id] = await combos.test(combo.id);
      return results;
    },
    onSuccess: (results) => {
      setDiagnostics((current) => ({ ...current, ...results }));
      const failed = Object.values(results).filter((result) => !result.ok).length;
      toast(failed ? `${failed} combo${failed === 1 ? "" : "s"} have failing targets` : "All combos passed", failed ? "error" : "success");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const createTemplate = useMutation({
    mutationFn: () => {
      // `never-stop` chains up to three distinct enabled models so a single
      // provider outage never stops the client.
      const candidates = providerList
        .filter((p) => p.enabled)
        .flatMap((p) => (p.models ?? []).filter((m) => m.enabled).map((m) => `${p.name}/${m.model_id}`))
        .slice(0, 3);
      return combos.create("never-stop", candidates.length ? candidates : ["openai/gpt-4.1"]);
    },
    onSuccess: () => { invalidate(); toast("Template 'never-stop' created"); },
    onError: (e) => toast(e.message, "error"),
  });

  return (
    <div>
      <PageHeader title="Combos" subtitle="Fallback chains that keep requests alive when a provider fails.">
        <Button variant="outline" size="sm" onClick={() => testAll.mutate()} loading={testAll.isPending} disabled={!all.length}>
          <Zap size={14} /> Test all
        </Button>
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} /> Add combo
        </Button>
      </PageHeader>

      {list.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : list.isError ? (
        <Card><p className="text-sm text-danger">Failed to load combos.</p></Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitBranch size={32} />}
            title="No combos yet"
            hint="A combo chains multiple provider models with automatic fallback, so one failing provider never stops your client."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={() => setEditing("new")}><Plus size={16} /> Add your first combo</Button>
                <Button variant="outline" onClick={() => createTemplate.mutate()} loading={createTemplate.isPending} disabled={!providerList.length}>
                  Use never-stop template
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <SummaryBar combos={enriched.length} targets={totalTargets} healthy={healthyCombos} />

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search combos…" className="pl-9" aria-label="Search combos" />
            </div>
            <Button variant={onlyProblems ? "primary" : "outline"} size="sm" onClick={() => setOnlyProblems((v) => !v)}>
              <AlertTriangle size={14} /> Problems only
            </Button>
          </div>

          {filtered.length === 0 ? (
            <Card><EmptyState title="No combos match" hint="Try a different search term or turn off the problems filter." /></Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {filtered.map(({ combo, steps, problems }) => (
                <ComboCard
                  key={combo.id}
                  combo={combo}
                  steps={steps}
                  problems={problems}
                  diagnostic={diagnostics[combo.id]}
                  testing={testCombo.isPending && testCombo.variables === combo.id}
                  onTest={() => testCombo.mutate(combo.id)}
                  onEdit={() => setEditing(combo)}
                  onDelete={() => setDeleting(combo)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <ComboModal
          combo={editing === "new" ? null : editing}
          providers={providerList}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        title="Delete combo"
        message={`Delete combo '${deleting?.name}'? Clients using model "combo:${deleting?.name}" will get a not-found error.`}
        danger
        loading={del.isPending}
      />
    </div>
  );
}

function SummaryBar({ combos, targets, healthy }: { combos: number; targets: number; healthy: number }) {
  const failing = combos - healthy;
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile icon={<Layers size={16} />} label="Combos" value={String(combos)} />
      <StatTile icon={<GitBranch size={16} />} label="Targets" value={String(targets)} />
      <StatTile
        icon={failing ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
        label={failing ? "Need attention" : "All healthy"}
        value={failing ? `${failing} of ${combos}` : String(combos)}
        tone={failing ? "warning" : "success"}
      />
    </div>
  );
}

function StatTile({ icon, label, value, tone = "muted" }: { icon: ReactNode; label: string; value: string; tone?: "muted" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text-muted";
  return (
    <Card className="gap-1! p-3!">
      <div className={`flex items-center gap-2 text-[11px] uppercase tracking-wider ${toneClass}`}>{icon}{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </Card>
  );
}

function ComboCard({
  combo,
  steps,
  problems,
  diagnostic,
  testing,
  onTest,
  onEdit,
  onDelete,
}: {
  combo: Combo;
  steps: ChainStep[];
  problems: number;
  diagnostic?: ComboDiagnostic;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const result = diagnostic?.combo === combo.name ? diagnostic : null;
  const resultById = new Map((result?.candidates ?? []).map((candidate) => [`${candidate.provider}/${candidate.model}`, candidate]));

  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{combo.name}</h3>
            <Badge tone={combo.strategy === "round_robin" ? "accent" : "muted"}>
              {combo.strategy === "round_robin" ? "round robin" : "sequential"}
            </Badge>
            {problems > 0 ? (
              <span title={`${problems} target${problems === 1 ? "" : "s"} without a healthy account`}>
                <Badge tone="warning"><AlertTriangle size={11} /> {problems}</Badge>
              </span>
            ) : (
              <Badge tone="success"><CheckCircle2 size={11} /> healthy</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">{steps.length} target{steps.length === 1 ? "" : "s"} · tried in order</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Copy model id" title="Copy model id" onClick={() => { navigator.clipboard.writeText(`combo:${combo.name}`); toast(`Copied combo:${combo.name}`); }}>
            <Copy size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={onTest} loading={testing}><Play size={14} /> Test</Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="sm" aria-label={`Delete ${combo.name}`} onClick={onDelete}><Trash2 size={14} className="text-danger" /></Button>
        </div>
      </div>

      <div className="mt-4">
        {steps.map((step, i) => {
          const candidate = resultById.get(step.target);
          const state: "healthy" | "unhealthy" | "unknown" = candidate
            ? (candidate.ok ? "healthy" : "unhealthy")
            : step.known && step.healthy > 0 ? "healthy" : "unknown";
          return (
            <div key={`${combo.id}-${step.target}-${i}`}>
              <div className="flex items-center gap-3">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${state === "healthy" ? "bg-success/15 text-success" : state === "unhealthy" ? "bg-danger/15 text-danger" : "bg-bg-raised text-text-muted"}`}>
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="truncate font-mono text-xs text-text-primary">{step.target}</code>
                  {!step.known && <Badge tone="warning">model off</Badge>}
                  <span className="text-[11px] text-text-muted">
                    {step.total ? `${step.healthy}/${step.total} accounts healthy` : "no accounts"}
                  </span>
                  {candidate && (
                    <span className={`text-[11px] ${candidate.ok ? "text-success" : "text-danger"}`}>
                      {candidate.ok ? `✓ ${candidate.latency_ms}ms` : `✗ ${candidate.detail ?? candidate.status}`}
                    </span>
                  )}
                </div>
                {state === "unhealthy"
                  ? <CircleX size={14} className="shrink-0 text-danger" />
                  : <span className={`h-2 w-2 shrink-0 rounded-full ${state === "healthy" ? "bg-success" : "bg-text-muted/40"}`} />}
              </div>
              {i < steps.length - 1 && (
                <div className="ml-3 flex items-center gap-2 border-l border-dashed border-border py-1 pl-3 text-[10px] uppercase tracking-wider text-text-muted">
                  <ChevronDown size={11} /> fallback
                </div>
              )}
            </div>
          );
        })}
      </div>

      {result && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-text-muted">
          <Badge tone={result.ok ? "success" : "danger"}>{result.ok ? "Test passed" : "Test failed"}</Badge>
          <span>{result.candidates.length} candidate{result.candidates.length === 1 ? "" : "s"} probed</span>
        </div>
      )}
    </Card>
  );
}

function ComboModal({ combo, providers: providerList, onClose }: { combo: Combo | null; providers: Provider[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(combo?.name ?? "");
  const [strategy, setStrategy] = useState<"sequential" | "round_robin">((combo?.strategy as "sequential" | "round_robin") ?? "sequential");
  const [chain, setChain] = useState<string[]>(
    combo ? combo.entries.slice().sort((a, b) => a.position - b.position).map((e) => e.target) : [],
  );
  const [error, setError] = useState("");
  const [draggedTarget, setDraggedTarget] = useState<string | null>(null);

  const available = useMemo(
    () => providerList
      .filter((p) => p.enabled)
      .flatMap((p) => (p.models ?? []).filter((m) => m.enabled).map((m) => `${p.name}/${m.model_id}`)),
    [providerList],
  );
  const remaining = available.filter((target) => !chain.includes(target));

  const save = useMutation({
    mutationFn: () => (combo ? combos.update(combo.id, { name, chain, strategy }) : combos.create(name, chain, strategy)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["combos"] });
      toast(combo ? "Combo updated" : "Combo created");
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  function move(from: number, to: number) {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = chain.slice();
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setChain(next);
  }

  const addTarget = (value: string) => {
    if (!value || chain.includes(value)) return;
    if (chain.length >= 10) return setError("A combo can chain at most 10 targets");
    setError("");
    setChain([...chain, value]);
  };

  return (
    <Modal open onClose={onClose} title={combo ? "Edit combo" : "Add combo"} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (chain.length === 0) return setError("Add at least one target");
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="never-stop" required className="font-mono" />
            <p className="mt-1 text-[11px] text-text-muted">Use it as <code className="font-mono">model: "combo:{name || "never-stop"}"</code></p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Strategy</label>
            <Select value={strategy} onChange={(e) => setStrategy(e.target.value as "sequential" | "round_robin")}>
              <option value="sequential">Sequential — always start at target 1</option>
              <option value="round_robin">Round robin — rotate the leading target</option>
            </Select>
            <p className="mt-1 text-[11px] text-text-muted">
              {strategy === "round_robin" ? "Spreads load across targets; the rest stay as ordered fallbacks." : "Always tries the first healthy target first."}
            </p>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Chain <span className="text-text-muted/50">(tried in order, max 10)</span></label>
          {chain.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">Chain is empty — add a target below.</p>
          ) : (
            <div className="space-y-1">
              {chain.map((target, i) => (
                <div key={target}>
                  <div
                    draggable
                    onDragStart={() => setDraggedTarget(target)}
                    onDragEnd={() => setDraggedTarget(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (!draggedTarget) return;
                      move(chain.indexOf(draggedTarget), i);
                    }}
                    className={`flex cursor-grab items-center gap-2 rounded-lg border border-border/60 bg-bg-base/50 px-3 py-2 text-xs active:cursor-grabbing ${draggedTarget === target ? "opacity-50" : ""}`}
                  >
                    <GripVertical size={14} className="shrink-0 text-text-muted" />
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[10px] font-medium text-accent">{i + 1}</span>
                    <code className="flex-1 truncate font-mono">{target}</code>
                    <button type="button" aria-label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0} className="text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronUp size={13} /></button>
                    <button type="button" aria-label="Move down" onClick={() => move(i, i + 1)} disabled={i === chain.length - 1} className="text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronDown size={13} /></button>
                    <button type="button" aria-label={`Remove ${target}`} onClick={() => setChain(chain.filter((x) => x !== target))} className="text-text-muted hover:text-danger"><X size={13} /></button>
                  </div>
                  {i < chain.length - 1 && <div className="ml-3 h-3 border-l border-dashed border-border" />}
                </div>
              ))}
            </div>
          )}
          <div className="mt-2">
            <Select value="" onChange={(e) => addTarget(e.target.value)} disabled={!remaining.length}>
              <option value="">{remaining.length ? "Add target…" : "No more enabled models available"}</option>
              {remaining.map((target) => <option key={target} value={target}>{target}</option>)}
            </Select>
          </div>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!name.trim()}>{combo ? "Save" : "Create"}</Button>
        </div>
      </form>
    </Modal>
  );
}
