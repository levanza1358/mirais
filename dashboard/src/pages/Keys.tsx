import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Eye, EyeOff, KeyRound, Pencil, RefreshCw } from "lucide-react";
import { keys, type GatewayKey } from "../api";
import { forgetKey, rememberKey, storedKeyFor } from "../keyStore";
import { Button, Card, CopyButton, EmptyState, Input, Modal, Skeleton, Switch, fmtTime, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Keys() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GatewayKey | null>(null);
  const [rotatedKey, setRotatedKey] = useState<{ label: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSecret, setShowSecret] = useState(true);

  const list = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const primaryKey = useMemo(() => (list.data ?? [])[0] ?? null, [list.data]);
  const remembered = primaryKey ? storedKeyFor(primaryKey.key_prefix) : null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["keys"] });

  const toggle = useMutation({
    mutationFn: (k: GatewayKey) => keys.update(k.id, { enabled: !k.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const createFirst = useMutation({
    mutationFn: () => keys.create({ label: "default" }),
    onSuccess: (k) => {
      rememberKey(k.key_prefix, k.plaintext);
      invalidate();
      setRotatedKey({ label: k.label, key: k.plaintext });
      setShowSecret(true);
      toast("Global API key generated");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const rotate = useMutation({
    mutationFn: (k: GatewayKey) => keys.rotate(k.id),
    onSuccess: (k) => {
      const previousPrefix = rotate.variables?.key_prefix;
      if (previousPrefix) forgetKey(previousPrefix);
      rememberKey(k.key_prefix, k.plaintext);
      invalidate();
      setRotatedKey({ label: k.label, key: k.plaintext });
      setShowSecret(true);
      toast("API key rotated");
    },
    onError: (e) => toast(e.message, "error"),
  });

  function copyRotatedKey() {
    if (!rotatedKey) return;
    navigator.clipboard.writeText(rotatedKey.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div>
      <PageHeader title="API key">
        {primaryKey ? (
          <Button variant="outline" onClick={() => rotate.mutate(primaryKey)} loading={rotate.isPending && rotate.variables?.id === primaryKey.id}>
            <RefreshCw size={16} /> Generate new key
          </Button>
        ) : (
          <Button onClick={() => createFirst.mutate()} loading={createFirst.isPending}>
            <RefreshCw size={16} /> Generate new key
          </Button>
        )}
      </PageHeader>

      {list.isLoading ? (
        <Card>
          <Skeleton className="h-32 w-full" />
        </Card>
      ) : !primaryKey ? (
        <Card>
          <EmptyState
            icon={<KeyRound size={32} />}
            title="No API key available"
            hint="Mirais now uses one global key only. Generate the first key once, then regenerate it whenever needed."
            action={<Button onClick={() => createFirst.mutate()} loading={createFirst.isPending}><RefreshCw size={16} /> Generate new key</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-hidden border-accent/15 bg-[linear-gradient(135deg,rgba(124,92,255,0.14),rgba(18,22,31,0.92)_46%,rgba(18,22,31,0.96))]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-accent/80">Global gateway key</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white">{primaryKey.label}</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-text-muted">One global credential for every OpenAI-compatible client. Regenerate it any time without leaving this page.</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                  <span>Created {fmtTime(primaryKey.created_at)}</span>
                  <span>•</span>
                  <span>Last used {primaryKey.last_used_at ? fmtTime(primaryKey.last_used_at) : "Never"}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-4 backdrop-blur">
                  <span className="w-16 text-xs text-text-muted">Secret</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-accent">
                    {showSecret ? (remembered ?? `${primaryKey.key_prefix}••••••••••••••••`) : "••••••••••••••••••••"}
                  </code>
                  <button type="button" onClick={() => setShowSecret((v) => !v)} className="text-text-muted hover:text-text-primary" aria-label={showSecret ? "Hide key" : "Show key"}>
                    {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  {remembered ? <CopyButton text={remembered} /> : <span className="text-[10px] text-text-muted">generate new key to copy</span>}
                </div>
              </div>

              <div className="flex flex-col gap-2 lg:min-w-56">
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-4 backdrop-blur">
                  <div>
                    <p className="text-sm font-medium">Key active</p>
                    <p className="text-xs text-text-muted">Allow requests through `/v1/*`</p>
                  </div>
                  <Switch
                    checked={!!primaryKey.enabled}
                    onChange={() => toggle.mutate(primaryKey)}
                    disabled={toggle.isPending && toggle.variables?.id === primaryKey.id}
                    aria-label={`Enable key ${primaryKey.label}`}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setEditing(primaryKey)}>
                    <Pencil size={14} /> Edit
                  </Button>
                  <Button variant="outline" className="flex-1" onClick={() => rotate.mutate(primaryKey)} loading={rotate.isPending && rotate.variables?.id === primaryKey.id}>
                    <RefreshCw size={14} /> Generate new
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {editing && <KeyModal key0={editing} onClose={() => setEditing(null)} />}

      <Modal open={!!rotatedKey} onClose={() => setRotatedKey(null)} title="API key rotated">
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>Copy this key now. This global secret will <strong>never be shown again</strong>, and any previous key is no longer valid.</span>
        </div>
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2">
          <code className="flex-1 break-all font-mono text-xs text-accent">{rotatedKey?.key}</code>
          <button onClick={copyRotatedKey} className="shrink-0 text-text-muted hover:text-text-primary" aria-label="Copy key">
            {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
          </button>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => setRotatedKey(null)}>Done</Button>
        </div>
      </Modal>
    </div>
  );
}

function KeyModal({ key0, onClose }: { key0?: GatewayKey; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    label: key0?.label ?? "",
    rateLimitRpm: key0?.rate_limit_rpm?.toString() ?? "",
    dailyTokenBudget: key0?.daily_token_budget?.toString() ?? "",
    expiresAt: key0?.expires_at?.slice(0, 10) ?? "",
  });
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        label: form.label.trim(),
        rateLimitRpm: form.rateLimitRpm ? Number(form.rateLimitRpm) : null,
        dailyTokenBudget: form.dailyTokenBudget ? Number(form.dailyTokenBudget) : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      };
      if (!key0) throw new Error("Key not found");
      await keys.update(key0.id, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["keys"] });
      toast("Key updated");
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Edit key">
      <form onSubmit={(e) => { e.preventDefault(); setError(""); save.mutate(); }} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Label</label>
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. my-app, ci-pipeline" required autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Rate limit (req/min)</label>
            <Input type="number" min={1} value={form.rateLimitRpm} onChange={(e) => setForm({ ...form, rateLimitRpm: e.target.value })} placeholder="unlimited" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Daily token budget</label>
            <Input type="number" min={1} value={form.dailyTokenBudget} onChange={(e) => setForm({ ...form, dailyTokenBudget: e.target.value })} placeholder="unlimited" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Expires at <span className="text-text-muted/50">(optional)</span></label>
          <Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!form.label.trim()}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
