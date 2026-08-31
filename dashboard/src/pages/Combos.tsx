import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, GitBranch, ChevronUp, ChevronDown, GripVertical, X, Play, CheckCircle2, CircleX } from "lucide-react";
import { combos, providers, type Combo, type ComboDiagnostic } from "../api";
import { Button, Card, Modal, Input, Select, Badge, EmptyState, ConfirmModal, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Combos() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Combo | "new" | null>(null);
  const [deleting, setDeleting] = useState<Combo | null>(null);
  const [diagnostic, setDiagnostic] = useState<ComboDiagnostic | null>(null);

  const list = useQuery({ queryKey: ["combos"], queryFn: combos.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["combos"] });

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

  return (
    <div>
      <PageHeader title="Combos">
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} /> Add combo
        </Button>
      </PageHeader>

      {list.isLoading ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
      : list.isError ? <Card><p className="text-sm text-danger">Failed to load combos.</p></Card>
      : (list.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitBranch size={32} />}
            title="No combos"
            hint="A combo chains multiple provider models with automatic fallback."
            action={<Button onClick={() => setEditing("new")}><Plus size={16} /> Add your first combo</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.data!.map((c) => {
            const entries = c.entries.slice().sort((a, b) => a.position - b.position);
            const result = diagnostic?.combo === c.name ? diagnostic : null;
            return <Card key={c.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{c.name}</h3>
                  <Badge tone="accent">{c.strategy}</Badge>
                  <span className="text-xs text-text-muted">{entries.length} target{entries.length > 1 ? "s" : ""}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => testCombo.mutate(c.id)} loading={testCombo.isPending && testCombo.variables === c.id}><Play size={14} /> Test</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(c)}><Trash2 size={14} className="text-danger" /></Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {entries.map((entry, i) => (
                  <span key={entry.id} className="inline-flex items-center gap-1.5 rounded-md bg-bg-raised px-2 py-1 text-xs">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[10px] font-medium text-accent">{i + 1}</span>
                    <code className="font-mono">{entry.target}</code>
                  </span>
                ))}
              </div>
              {result && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
                  {result.candidates.map((candidate) => (
                    <span key={`${candidate.position}-${candidate.provider}-${candidate.model}`} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${candidate.ok ? "bg-success/10" : "bg-danger/10"}`}>
                      {candidate.ok ? <CheckCircle2 size={11} className="text-success" /> : <CircleX size={11} className="text-danger" />}
                      <code className="font-mono">{candidate.provider}/{candidate.model}</code>
                      <span className="text-text-muted">{candidate.latency_ms}ms</span>
                    </span>
                  ))}
                </div>
              )}
            </Card>;
          })}
        </div>
      )}

      {editing && (
        <ComboModal
          combo={editing === "new" ? null : editing}
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
    </div>
  );
}

function ComboModal({ combo, onClose }: { combo: Combo | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(combo?.name ?? "");
  const [chain, setChain] = useState<string[]>(
    combo ? combo.entries.slice().sort((a, b) => a.position - b.position).map((e) => e.target) : [],
  );
  const [error, setError] = useState("");
  const [draggedTarget, setDraggedTarget] = useState<string | null>(null);
  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: providers.list });

  const save = useMutation({
    mutationFn: () => (combo ? combos.update(combo.id, { name, chain }) : combos.create(name, chain)),
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

  return (
    <Modal open onClose={onClose} title={combo ? "Edit combo" : "Add combo"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (chain.length === 0) return setError("Add at least one target");
          save.mutate();
        }}
        className="space-y-3"
      >
        <div>
          <label className="mb-1 block text-xs text-text-muted">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="default" required className="font-mono" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Chain (tried in order)</label>
          {chain.length === 0 ? (
            <p className="text-xs text-text-muted">Chain is empty.</p>
          ) : (
            <div className="space-y-1">
              {chain.map((t, i) => (
                <div
                  key={t}
                  draggable
                  onDragStart={() => setDraggedTarget(t)}
                  onDragEnd={() => setDraggedTarget(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (!draggedTarget) return;
                    move(chain.indexOf(draggedTarget), i);
                  }}
                  className={`flex cursor-grab items-center gap-2 rounded-lg bg-bg-base/50 px-3 py-1.5 text-xs active:cursor-grabbing ${draggedTarget === t ? "opacity-50" : ""}`}
                >
                  <GripVertical size={14} className="shrink-0 text-text-muted" />
                  <span className="w-4 text-text-muted">{i + 1}.</span>
                  <code className="flex-1 font-mono">{t}</code>
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronUp size={13} /></button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === chain.length - 1} className="text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronDown size={13} /></button>
                  <button type="button" onClick={() => setChain(chain.filter((x) => x !== t))} className="text-text-muted hover:text-danger"><X size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Select value="" onChange={(e) => { if (e.target.value) { setChain([...chain, e.target.value]); } }}>
              <option value="">Add target…</option>
              {(providersQuery.data ?? []).filter((x) => x.enabled).flatMap((p) => (p.models ?? []).filter((m) => m.enabled).map((m) => `${p.name}/${m.model_id}`)).filter((t) => !chain.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!name.trim()}>{combo ? "Save" : "Create"}</Button>
        </div>
      </form>
    </Modal>
  );
}
