import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, GitBranch, ChevronUp, ChevronDown, GripVertical, X, Play, CheckCircle2, CircleX, Activity, CircleAlert, Clock, History, Sparkles } from "lucide-react";
import { combos, logs, providers, type Combo, type ComboDiagnostic, type Provider } from "../api";
import { Button, Card, Modal, Input, Select, Badge, EmptyState, ConfirmModal, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

type TargetStatus = { ready: number; accounts: number; enabled: boolean; nextReadyAt: number | null };

function getTargetStatus(target: string, list: Provider[]): TargetStatus {
  const slash = target.indexOf("/");
  const provider = list.find((p) => p.name === target.slice(0, slash));
  const model = provider?.models?.find((m) => m.model_id === target.slice(slash + 1));
  const accounts = provider?.accounts?.filter((a) => a.enabled) ?? [];
  const now = Date.now();
  return {
    ready: accounts.filter((a) => !a.rate_limited_until || a.rate_limited_until <= now).length,
    accounts: accounts.length,
    enabled: !!provider?.enabled && !!model?.enabled,
    nextReadyAt: accounts
      .map((a) => a.rate_limited_until ?? 0)
      .filter((until) => until > now)
      .sort((a, b) => a - b)[0] ?? null,
  };
}

function formatCooldown(ms: number) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function Combos() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Combo | "new" | null>(null);
  const [deleting, setDeleting] = useState<Combo | null>(null);
  const [diagnostic, setDiagnostic] = useState<ComboDiagnostic | null>(null);
  const [diagnosticDetail, setDiagnosticDetail] = useState<ComboDiagnostic | null>(null);
  const [now, setNow] = useState(Date.now());

  const list = useQuery({ queryKey: ["combos"], queryFn: combos.list });
  const provs = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const activity = useQuery({
    queryKey: ["logs", "combos"],
    queryFn: () => logs.list({ limit: 50, kind: "request" }),
    refetchInterval: 10_000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["combos"] });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const del = useMutation({
    mutationFn: (id: string) => combos.remove(id),
    onSuccess: () => { invalidate(); setDeleting(null); toast("Combo deleted"); },
    onError: (e) => toast(e.message, "error"),
  });
  const testCombo = useMutation({
    mutationFn: (id: string) => combos.test(id),
    onSuccess: setDiagnostic,
    onError: (e) => toast(e.message, "error"),
  });
  const quickCreate = useMutation({
    mutationFn: ({ name, chain }: { name: string; chain: string[] }) => combos.create(name, chain),
    onSuccess: () => { invalidate(); toast("Combo created"); },
    onError: (e) => toast(e.message, "error"),
  });

  const targets = (provs.data ?? [])
    .filter((p) => !!p.enabled)
    .flatMap((p) =>
      (p.models ?? []).filter((m) => m.enabled).map((m) => `${p.name}/${m.model_id}`),
  );

  return (
    <div>
      <PageHeader title="Combos">
        <Button onClick={() => setEditing("new")} disabled={targets.length === 0}>
          <Plus size={16} /> Add combo
        </Button>
      </PageHeader>

      {list.isLoading || provs.isLoading ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
      : list.isError || provs.isError ? <Card><p className="text-sm text-danger">Failed to load combos or provider models.</p></Card>
      : (list.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitBranch size={32} />}
            title="No combos"
            hint="A combo chains multiple provider models with automatic fallback — if the first fails, the next is tried."
            action={targets.length > 0
              ? <Button onClick={() => setEditing("new")}><Plus size={16} /> Add your first combo</Button>
              : undefined}
          />
          {targets.length === 0 && (
            <p className="pb-6 text-center text-xs text-text-muted">Add a provider and sync its models first.</p>
          )}
          {targets.length > 0 && (
            <div className="border-t border-border/60 pt-4">
              <p className="mb-3 text-center text-xs text-text-muted">Quick start</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" loading={quickCreate.isPending} onClick={() => quickCreate.mutate({ name: "fast", chain: targets.slice(0, 2) })}>
                  <Sparkles size={14} /> Fast fallback
                </Button>
                <Button variant="outline" size="sm" loading={quickCreate.isPending} onClick={() => quickCreate.mutate({ name: "never-stop", chain: targets.slice(0, 4) })}>
                  <GitBranch size={14} /> Never stop
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {list.data!.map((c) => {
            const entries = c.entries.slice().sort((a, b) => a.position - b.position);
            const statuses = entries.map((e) => getTargetStatus(e.target, provs.data ?? []));
            const ready = statuses.filter((s) => s.enabled && s.ready > 0).length;
            const recent = (activity.data?.items ?? []).filter((log) => log.requested_model === `combo:${c.name}`).slice(0, 5);
            const result = diagnostic?.combo === c.name ? diagnostic : null;
            return <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{c.name}</h3>
                    <Badge tone="accent">{c.strategy}</Badge>
                    <Badge tone={ready === entries.length ? "success" : ready > 0 ? "warning" : "danger"}>
                      {ready === entries.length ? "All ready" : `${ready}/${entries.length} ready`}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">Fallback runs from top to bottom when a target cannot answer.</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => testCombo.mutate(c.id)} loading={testCombo.isPending && testCombo.variables === c.id} aria-label="Test providers"><Play size={14} /> Test</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(c)} aria-label="Edit">Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(c)} aria-label="Delete"><Trash2 size={14} className="text-danger" /></Button>
                </div>
              </div>
              <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-2">
                  {entries.map((entry, index) => {
                    const status = statuses[index]!;
                    const available = status.enabled && status.ready > 0;
                    return <div key={entry.id} className="relative flex items-center gap-3 rounded-lg border border-border/70 bg-bg-base/40 px-3 py-2.5">
                      {index < entries.length - 1 && <span className="absolute left-6 top-full h-2 border-l border-border" />}
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-medium ${available ? "bg-success/15 text-success" : "bg-danger/15 text-danger"}`}>{index + 1}</span>
                      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.target}>{entry.target}</code>
                      <span className={`flex items-center gap-1 text-xs ${available ? "text-success" : "text-danger"}`}>
                        {available ? <Activity size={13} /> : <CircleAlert size={13} />}
                        {status.enabled ? `${status.ready}/${status.accounts} ready` : "Unavailable"}
                      </span>
                      {status.nextReadyAt && status.nextReadyAt > now && (
                        <span className="flex items-center gap-1 text-xs text-warning" title="Next account ready">
                          <Clock size={13} /> {formatCooldown(status.nextReadyAt - now)}
                        </span>
                      )}
                    </div>;
                  })}
                </div>
                <div className="rounded-lg border border-border/70 bg-bg-base/40 p-4">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Chain health</p>
                  <p className="mt-2 text-2xl font-semibold">{ready}<span className="text-sm font-normal text-text-muted">/{entries.length}</span></p>
                  <p className="text-xs text-text-muted">targets ready to route</p>
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bg-raised">
                    <div className="h-full rounded-full bg-success transition-all" style={{ width: `${entries.length ? ready / entries.length * 100 : 0}%` }} />
                  </div>
                  <p className="mt-3 text-xs text-text-muted">Use Test to run a live check on every target.</p>
                </div>
              </div>
              {result && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium">Live test result</p>
                    <Badge tone={result.ok ? "success" : "danger"}>{result.ok ? "All working" : "Issues found"}</Badge>
                  </div>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {result.candidates.map((candidate) => (
                      <button key={`${candidate.position}-${candidate.provider}-${candidate.model}`} type="button" onClick={() => setDiagnosticDetail(result)} className="flex items-center gap-2 rounded-lg bg-bg-base/50 p-2.5 text-left text-xs">
                        {candidate.ok ? <CheckCircle2 size={14} className="shrink-0 text-success" /> : <CircleX size={14} className="shrink-0 text-danger" />}
                        <code className="min-w-0 flex-1 truncate">{candidate.provider}/{candidate.model}</code>
                        <span className="text-text-muted">{candidate.status} · {candidate.latency_ms} ms</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {recent.length > 0 && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-muted"><History size={13} /> Recent requests</p>
                  <div className="space-y-1.5">
                    {recent.map((log) => (
                      <div key={log.id} className="flex items-center gap-2 text-xs">
                        <span className={`h-2 w-2 rounded-full ${log.status === "success" ? "bg-success" : "bg-danger"}`} />
                        <span className="text-text-muted">{new Date(log.ts).toLocaleTimeString()}</span>
                        <code>{log.provider ?? "—"}/{log.model ?? "—"}</code>
                        <span className="ml-auto text-text-muted">{log.latency_ms ?? "—"} ms · {log.input_tokens ?? 0}→{log.output_tokens ?? 0}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>;
          })}
        </div>
      )}

      {editing && (
        <ComboModal
          combo={editing === "new" ? null : editing}
          targets={targets}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        title="Delete combo"
        message={`Delete combo '${deleting?.name}'?`}
        danger
        loading={del.isPending}
      />
      {diagnosticDetail && <Modal open onClose={() => setDiagnosticDetail(null)} title={`Provider test: ${diagnosticDetail.combo}`}>
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-text-muted">
          <span>Requested model: <code>{diagnosticDetail.requested_model}</code></span>
          <Badge tone={diagnosticDetail.ok ? "success" : "danger"}>{diagnosticDetail.ok ? "All working" : "Issues found"}</Badge>
        </div>
        <div className="space-y-2">
          {diagnosticDetail.candidates.map((candidate) => <div key={`${candidate.position}-${candidate.provider}-${candidate.model}`} className="rounded-lg bg-bg-base/60 p-3 text-sm">
            <div className="flex items-center gap-2">
              {candidate.ok ? <CheckCircle2 size={15} className="text-success" /> : <CircleX size={15} className="text-danger" />}
              <span className="font-mono">{candidate.position + 1}. {candidate.provider}/{candidate.model}</span>
              <span className="ml-auto text-xs text-text-muted">{candidate.status} · {candidate.latency_ms} ms</span>
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {candidate.ok ? `Working with ${candidate.account ?? "an account"}` : candidate.detail}
              {` · ${candidate.healthy_accounts}/${candidate.available_accounts} healthy accounts`}
            </div>
          </div>)}
        </div>
      </Modal>}
    </div>
  );
}

function ComboModal({ combo, targets, onClose }: { combo: Combo | null; targets: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(combo?.name ?? "");
  const [chain, setChain] = useState<string[]>(
    combo ? combo.entries.slice().sort((a, b) => a.position - b.position).map((e) => e.target) : [],
  );
  const [pick, setPick] = useState(targets[0] ?? "");
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function move(from: number, to: number) {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = chain.slice();
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setChain(next);
  }

  const save = useMutation({
    mutationFn: () => (combo ? combos.update(combo.id, { name, chain }) : combos.create(name, chain)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["combos"] });
      toast(combo ? "Combo updated" : "Combo created");
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const MAX_CHAIN = 10;
  function addTarget() {
    if (chain.length >= MAX_CHAIN) return setError(`Chain is limited to ${MAX_CHAIN} targets`);
    if (pick && !chain.includes(pick)) { setChain([...chain, pick]); setError(""); }
  }

  return (
    <Modal open onClose={onClose} title={combo ? "Edit combo" : "Add combo"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (chain.length === 0) return setError("Add at least one target to the chain");
          save.mutate();
        }}
        className="space-y-3"
      >
        <div>
          <label className="mb-1 block text-xs text-text-muted">Combo name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="default" required className="font-mono" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Fallback chain (tried in order — drag or use arrows to set priority)</label>
          <div className="mb-2 flex gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)}>
              {targets.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Button type="button" variant="outline" onClick={addTarget} disabled={chain.length >= MAX_CHAIN}>Add</Button>
          </div>
          {chain.length === 0 ? (
            <p className="text-xs text-text-muted">Chain is empty.</p>
          ) : (
            <div className="space-y-1">
              {chain.map((t, i) => (
                <div
                  key={t}
                  draggable
                  onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
                  onDragOver={(e) => { if (dragIndex === null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIndex !== i) setOverIndex(i); }}
                  onDragLeave={() => { if (overIndex === i) setOverIndex(null); }}
                  onDrop={(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData("text/plain")); if (Number.isInteger(from)) move(from, i); setDragIndex(null); setOverIndex(null); }}
                  onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${dragIndex === i ? "opacity-40" : ""} ${overIndex === i && dragIndex !== null && dragIndex !== i ? "bg-accent/15 ring-1 ring-inset ring-accent/30" : "bg-bg-base/50"}`}
                >
                  <GripVertical size={12} className="shrink-0 cursor-grab text-text-muted active:cursor-grabbing" />
                  <span className="w-4 text-text-muted">{i + 1}.</span>
                  <code className="font-mono" title={t}>{t}</code>
                  <div className="ml-auto flex items-center gap-0.5">
                    <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="text-text-muted hover:text-text-primary disabled:opacity-30" aria-label={`Move ${t} up`}>
                      <ChevronUp size={13} />
                    </button>
                    <button type="button" onClick={() => move(i, i + 1)} disabled={i === chain.length - 1} className="text-text-muted hover:text-text-primary disabled:opacity-30" aria-label={`Move ${t} down`}>
                      <ChevronDown size={13} />
                    </button>
                    <button type="button" onClick={() => setChain(chain.filter((x) => x !== t))} className="text-text-muted hover:text-danger" aria-label={`Remove ${t}`}>
                      <X size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!name.trim()}>{combo ? "Save" : "Create combo"}</Button>
        </div>
      </form>
    </Modal>
  );
}
