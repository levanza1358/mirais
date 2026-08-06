import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, GitBranch, ChevronRight, X } from "lucide-react";
import { combos, providers, type Combo } from "../api";
import { Button, Card, Modal, Input, Select, Badge, EmptyState, ConfirmModal, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { simplifyQualifiedTarget } from "../utils/modelLabels";

export default function Combos() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Combo | "new" | null>(null);
  const [deleting, setDeleting] = useState<Combo | null>(null);

  const list = useQuery({ queryKey: ["combos"], queryFn: combos.list });
  const provs = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["combos"] });

  const del = useMutation({
    mutationFn: (id: string) => combos.remove(id),
    onSuccess: () => { invalidate(); setDeleting(null); toast("Combo deleted"); },
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

      {list.isLoading ? null : (list.data ?? []).length === 0 ? (
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
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.data!.map((c) => (
            <Card key={c.id}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium">{c.name}</h3>
                <div className="flex items-center gap-1">
                  <Badge tone="accent">{c.strategy}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(c)} aria-label="Edit">Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(c)} aria-label="Delete">
                    <Trash2 size={14} className="text-danger" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {c.entries
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((e, i) => (
                    <span key={e.id} className="flex items-center gap-1.5">
                      {i > 0 && <ChevronRight size={12} className="text-text-muted/50" />}
                      <code className="rounded bg-bg-base px-2 py-0.5 font-mono text-xs" title={e.target}>{simplifyQualifiedTarget(e.target)}</code>
                    </span>
                  ))}
              </div>
            </Card>
          ))}
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
          <label className="mb-1 block text-xs text-text-muted">Fallback chain (tried in order)</label>
          <div className="mb-2 flex gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)}>
              {targets.map((t) => <option key={t} value={t}>{simplifyQualifiedTarget(t)}</option>)}
            </Select>
            <Button type="button" variant="outline" onClick={addTarget} disabled={chain.length >= MAX_CHAIN}>Add</Button>
          </div>
          {chain.length === 0 ? (
            <p className="text-xs text-text-muted">Chain is empty.</p>
          ) : (
            <div className="space-y-1">
              {chain.map((t, i) => (
                <div key={t} className="flex items-center gap-2 rounded-lg bg-bg-base/50 px-3 py-1.5 text-xs">
                  <span className="w-4 text-text-muted">{i + 1}.</span>
                  <code className="font-mono" title={t}>{simplifyQualifiedTarget(t)}</code>
                  <button type="button" onClick={() => setChain(chain.filter((x) => x !== t))} className="ml-auto text-text-muted hover:text-danger" aria-label={`Remove ${t}`}>
                    <X size={13} />
                  </button>
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
