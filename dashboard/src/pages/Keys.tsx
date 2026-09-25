import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { keys, logs, type GatewayKey } from "../api";
import { forgetKey, rememberKey, storedKeyFor } from "../keyStore";
import { Button, Card, ConfirmModal, CopyButton, EmptyState, Input, Modal, Skeleton, Switch, fmtNum, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

function parseAllowedModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}
function usagePercent(used: number, limit: number | null): number { return limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0; }
function TokenProgress({ used, limit }: { used: number; limit: number | null }) {
  const percent = usagePercent(used, limit);
  return <div className="mt-3"><div className="flex justify-between text-[11px] text-text-muted"><span>Lifetime token usage</span><span className={percent >= 100 ? "text-danger" : percent >= 80 ? "text-warning" : "text-text-primary"}>{limit ? `${fmtNum(used)} / ${fmtNum(limit)} (${percent}%)` : `${fmtNum(used)} · unlimited`}</span></div>{limit && <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-border"><div className={`h-full rounded-full ${percent >= 100 ? "bg-danger" : percent >= 80 ? "bg-warning" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>}</div>;
}

export default function Keys() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GatewayKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<GatewayKey | null>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState<{ label: string; key: string } | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled" | "exhausted">("all");
  const list = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const allKeys = list.data ?? [];
  const usageQueries = useQueries({ queries: allKeys.map((key) => ({ queryKey: ["key-usage", key.id], queryFn: () => logs.usageByKey(key.id), refetchInterval: 30_000 })) });
  const usageById = useMemo(() => new Map(allKeys.map((key, index) => [key.id, usageQueries[index]?.data])), [allKeys, usageQueries]);
  const filteredKeys = allKeys.filter((key) => {
    const usage = usageById.get(key.id);
    const exhausted = !!key.token_budget && (usage?.tokens_total ?? 0) >= key.token_budget;
    const matchesSearch = !search.trim() || `${key.label} ${key.key_prefix}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = statusFilter === "all" || statusFilter === "active" && !!key.enabled && !exhausted || statusFilter === "disabled" && !key.enabled || statusFilter === "exhausted" && exhausted;
    return matchesSearch && matchesStatus;
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["keys"] });
  const remove = useMutation({ mutationFn: (key: GatewayKey) => keys.remove(key.id), onSuccess: () => { invalidate(); setRemoving(null); toast("API key deleted"); }, onError: (error) => toast(error.message, "error") });
  const toggle = useMutation({ mutationFn: (key: GatewayKey) => keys.update(key.id, { enabled: !key.enabled }), onSuccess: invalidate, onError: (error) => toast(error.message, "error") });
  const rotate = useMutation({ mutationFn: (key: GatewayKey) => keys.rotate(key.id), onSuccess: (key) => { forgetKey(key.key_prefix); rememberKey(key.key_prefix, key.key ?? key.plaintext); setNewKey({ label: key.label, key: key.key ?? key.plaintext }); invalidate(); }, onError: (error) => toast(error.message, "error") });

  return <div>
    <PageHeader title="API keys"><Button onClick={() => setCreating(true)}><Plus size={16} /> Create API key</Button></PageHeader>
    <p className="mb-5 text-sm text-text-muted">Create separate credentials for each app, agent, or user. Every key has its own limits and lifetime token budget.</p>
    {list.isLoading ? <Card><Skeleton className="h-48 w-full" /></Card> : !allKeys.length ? <Card><EmptyState icon={<KeyRound size={32} />} title="No API keys" hint="Create a key to authenticate requests to /v1/*." action={<Button onClick={() => setCreating(true)}><Plus size={15} /> Create API key</Button>} /></Card> : <><Card className="mb-4"><div className="flex flex-col gap-2 sm:flex-row"><label className="relative flex-1"><Search size={15} className="absolute left-3 top-2.5 text-text-muted" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search label or key prefix" /></label><select className="h-9 rounded-md border border-border bg-bg-base px-3 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All keys</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="exhausted">Exhausted</option></select></div><p className="mt-2 text-xs text-text-muted">Showing {filteredKeys.length} of {allKeys.length} keys</p></Card>{!filteredKeys.length ? <Card><EmptyState icon={<Search size={28} />} title="No matching keys" hint="Try another search or clear the status filter." /></Card> : <div className="grid gap-4 xl:grid-cols-2">{filteredKeys.map((key) => {
      const usage = usageById.get(key.id); const isVisible = visible.has(key.id); const secret = key.key ?? storedKeyFor(key.key_prefix) ?? ""; const exhausted = !!key.token_budget && (usage?.tokens_total ?? 0) >= key.token_budget;
      return <Card key={key.id} className="border-border/80"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><KeyRound size={18} /></span><div className="min-w-0"><h2 className="truncate text-base font-semibold">{key.label}</h2><p className="text-xs text-text-muted">{key.enabled ? "Active" : "Disabled"} · created {new Date(key.created_at).toLocaleDateString()}</p></div></div><span className={`rounded-full px-2 py-1 text-[10px] ${exhausted ? "bg-danger/15 text-danger" : key.enabled ? "bg-success/15 text-success" : "bg-border text-text-muted"}`}>{exhausted ? "EXHAUSTED" : key.enabled ? "ACTIVE" : "OFF"}</span></div>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2"><code className="min-w-0 flex-1 truncate font-mono text-xs text-accent">{isVisible && secret ? secret : `${key.key_prefix}••••••••••••`}</code>{secret && <CopyButton text={secret} />}<button type="button" className="text-text-muted hover:text-text-primary" aria-label={isVisible ? `Hide API key ${key.label}` : `Show API key ${key.label}`} onClick={() => setVisible((current) => { const next = new Set(current); if (next.has(key.id)) next.delete(key.id); else next.add(key.id); return next; })}>{isVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        <TokenProgress used={usage?.tokens_total ?? 0} limit={key.token_budget} />
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-text-muted"><span>RPM: {key.rate_limit_rpm ?? "∞"}</span><span>Concurrent: {key.concurrency ?? "∞"}</span><span>Used/min: {usage?.requests_minute ?? 0}</span></div>
        {usage?.top_models?.length ? <div className="mt-3 border-t border-border/60 pt-3"><p className="text-[10px] uppercase tracking-[0.16em] text-text-muted">Top models</p><div className="mt-2 flex flex-wrap gap-2">{usage.top_models.map((model) => <span key={model.model} className="rounded-md bg-bg-base px-2 py-1 text-[11px] text-text-muted">{model.model}: {fmtNum(model.tokens)} tokens</span>)}</div></div> : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2"><Switch checked={!!key.enabled} onChange={() => toggle.mutate(key)} aria-label={`Enable API key ${key.label}`} /><Button size="sm" variant="outline" onClick={() => setEditing(key)}><Pencil size={13} /> Edit</Button><Button size="sm" variant="outline" onClick={() => rotate.mutate(key)} loading={rotate.isPending && rotate.variables?.id === key.id}><RefreshCw size={13} /> Rotate</Button><Button size="sm" variant="danger" onClick={() => setRemoving(key)} aria-label={`Delete API key ${key.label}`}><Trash2 size={13} /></Button></div>
      </Card>;
    })}</div>}</>}
    <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} title="Delete API key" message={`Delete "${removing?.label ?? ""}"? Any client using it will immediately lose access. This cannot be undone.`} danger loading={remove.isPending} />
    {creating && <CreateKeyModal onClose={() => setCreating(false)} onCreated={(key) => { setCreating(false); setNewKey(key); invalidate(); }} />}
    <Modal open={!!newKey} onClose={() => setNewKey(null)} title="API key generated"><div className="space-y-4"><p className="text-xs text-warning">Copy this key now. You can reveal it later from this page, but treat it as a secret.</p><code className="block break-all rounded-lg border border-border bg-bg-base p-3 text-xs text-accent">{newKey?.key}</code><div className="flex justify-end"><Button onClick={() => setNewKey(null)}>Done</Button></div></div></Modal>
    {editing && <KeyModal key0={editing} onClose={() => setEditing(null)} />}
  </div>;
}

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: { label: string; key: string }) => void }) {
  const [label, setLabel] = useState(""); const [budget, setBudget] = useState("");
  const create = useMutation({ mutationFn: () => keys.create({ label: label.trim(), tokenBudget: budget ? Number(budget) : undefined }), onSuccess: (key) => onCreated({ label: key.label, key: key.key ?? key.plaintext }), onError: (error) => toast(error.message, "error") });
  return <Modal open onClose={onClose} title="Create API key"><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="block text-xs text-text-muted">Label<Input className="mt-1" autoFocus required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="my-app" /></label><label className="block text-xs text-text-muted">Maximum lifetime tokens<Input className="mt-1" type="number" min={1} value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="Unlimited" /></label><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={create.isPending}>Generate</Button></div></form></Modal>;
}

function KeyModal({ key0, onClose }: { key0: GatewayKey; onClose: () => void }) {
  const qc = useQueryClient(); const [error, setError] = useState("");
  const [form, setForm] = useState({ label: key0.label, rateLimitRpm: key0.rate_limit_rpm?.toString() ?? "", concurrency: key0.concurrency?.toString() ?? "", tokenBudget: key0.token_budget?.toString() ?? "", allowedModels: parseAllowedModels(key0.allowed_models).join("\n"), expiresAt: key0.expires_at?.slice(0, 10) ?? "" });
  const save = useMutation({ mutationFn: () => keys.update(key0.id, { label: form.label.trim(), rateLimitRpm: form.rateLimitRpm ? Number(form.rateLimitRpm) : null, concurrency: form.concurrency ? Number(form.concurrency) : null, tokenBudget: form.tokenBudget ? Number(form.tokenBudget) : null, allowedModels: form.allowedModels.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["keys"] }); toast("API key updated"); onClose(); }, onError: (err) => setError(err.message) });
  return <Modal open onClose={onClose} title={`Edit ${key0.label}`}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); setError(""); save.mutate(); }}><label className="block text-xs text-text-muted">Label<Input className="mt-1" required value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label><div className="grid grid-cols-2 gap-3"><label className="text-xs text-text-muted">Rate limit<Input className="mt-1" type="number" min={1} value={form.rateLimitRpm} onChange={(event) => setForm({ ...form, rateLimitRpm: event.target.value })} placeholder="Unlimited" /></label><label className="text-xs text-text-muted">Concurrency<Input className="mt-1" type="number" min={1} value={form.concurrency} onChange={(event) => setForm({ ...form, concurrency: event.target.value })} placeholder="Unlimited" /></label></div><label className="block text-xs text-text-muted">Maximum lifetime tokens<Input className="mt-1" type="number" min={1} value={form.tokenBudget} onChange={(event) => setForm({ ...form, tokenBudget: event.target.value })} placeholder="Unlimited" /></label><label className="block text-xs text-text-muted">Allowed models<textarea value={form.allowedModels} onChange={(event) => setForm({ ...form, allowedModels: event.target.value })} rows={3} className="mt-1 w-full rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs" placeholder="empty = all models" /></label><label className="block text-xs text-text-muted">Expires at<Input className="mt-1" type="date" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} /></label>{error && <p className="text-xs text-danger">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></div></form></Modal>;
}
