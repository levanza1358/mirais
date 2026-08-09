import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Trash2 } from "lucide-react";
import { memory, type MemorySession } from "../api";
import { PageHeader } from "../components/Layout";
import { Button, Card, ConfirmModal, EmptyState, Skeleton, toast } from "../components/ui";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function Memory() {
  const qc = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<MemorySession | null>(null);
  const [clearAll, setClearAll] = useState(false);
  const list = useQuery({ queryKey: ["memory-sessions"], queryFn: memory.list });
  const stats = useQuery({ queryKey: ["memory-stats"], queryFn: memory.stats });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["memory-sessions"] });
    void qc.invalidateQueries({ queryKey: ["memory-stats"] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => memory.remove(id),
    onSuccess: () => { setRemoveTarget(null); refresh(); toast("Memory session cleared"); },
    onError: (error) => toast(error.message, "error"),
  });
  const clear = useMutation({
    mutationFn: memory.clear,
    onSuccess: (result) => { setClearAll(false); refresh(); toast(`Cleared ${result.removed} memory session(s)`); },
    onError: (error) => toast(error.message, "error"),
  });

  return <div>
    <PageHeader title="Conversation memory">
      <Button variant="outline" onClick={() => setClearAll(true)} disabled={!list.data?.length}><Trash2 size={16} /> Clear all</Button>
    </PageHeader>
    <p className="mb-5 text-sm text-text-muted">Opt-in sessions are key-scoped, bounded, and automatically expire. Session identifiers may reveal client-provided metadata.</p>
    <div className="mb-5 grid gap-3 sm:grid-cols-2">
      <Card><p className="text-xs text-text-muted">Active sessions</p><p className="mt-1 text-2xl font-semibold">{stats.data?.sessions ?? 0}</p></Card>
      <Card><p className="text-xs text-text-muted">Stored messages</p><p className="mt-1 text-2xl font-semibold">{stats.data?.messages ?? 0}</p></Card>
    </div>
    {list.isLoading ? <Card><Skeleton className="h-40 w-full" /></Card> : !list.data?.length ? <Card><EmptyState icon={<Brain size={32} />} title="No memory sessions" description="Sessions appear after memory is enabled and a client sends X-Mirais-Session-Id." /></Card> : <div className="space-y-3">
      {list.data.map((session) => <Card key={session.id}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="truncate font-mono text-xs">{session.id}</p><p className="mt-1 text-xs text-text-muted">{session.count} messages · updated {formatDate(session.updated_at)} · expires {formatDate(session.expires_at)}</p></div>
          <Button variant="outline" onClick={() => setRemoveTarget(session)}><Trash2 size={15} /> Clear</Button>
        </div>
      </Card>)}
    </div>}
    <ConfirmModal open={!!removeTarget} title="Clear memory session?" message="This permanently removes the stored conversation history for this session." confirmLabel="Clear session" danger loading={remove.isPending} onConfirm={() => removeTarget && remove.mutate(removeTarget.id)} onClose={() => setRemoveTarget(null)} />
    <ConfirmModal open={clearAll} title="Clear all memory?" message="This permanently removes every stored conversation session." confirmLabel="Clear all" danger loading={clear.isPending} onConfirm={() => clear.mutate()} onClose={() => setClearAll(false)} />
  </div>;
}