import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, KeyRound, Pencil, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { keys, type GatewayKey } from "../api";
import { forgetKey, rememberKey, storedKeyFor } from "../keyStore";
import { Button, Card, CopyButton, EmptyState, Input, Modal, Skeleton, Switch, fmtTime, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function Stat({ label, value, tone = "muted" }: { label: string; value: string; tone?: "muted" | "success" | "warning" | "danger" }) {
  const toneClass = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-text-primary";
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 backdrop-blur">
      <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</p>
      <p className={`mt-1 text-xs font-medium ${toneClass}`}>{value}</p>
    </div>
  );
}

export default function Keys() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GatewayKey | null>(null);
  const [rotatedKey, setRotatedKey] = useState<{ label: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const list = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const primaryKey = useMemo(() => (list.data ?? [])[0] ?? null, [list.data]);
  // Key is persisted plaintext server-side — always visible and copyable.
  const remembered = primaryKey ? (primaryKey.key ?? storedKeyFor(primaryKey.key_prefix) ?? null) : null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["keys"] });

  const toggle = useMutation({
    mutationFn: (k: GatewayKey) => keys.update(k.id, { enabled: !k.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const createFirst = useMutation({
    mutationFn: () => keys.create({ label: "default" }),
    onSuccess: (k) => {
      rememberKey(k.key_prefix, k.key ?? k.plaintext);
      invalidate();
      setRotatedKey({ label: k.label, key: k.key ?? k.plaintext });
      toast("Global API key generated");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const rotate = useMutation({
    mutationFn: (k: GatewayKey) => keys.rotate(k.id),
    onSuccess: (k) => {
      const previousPrefix = rotate.variables?.key_prefix;
      if (previousPrefix) forgetKey(previousPrefix);
      rememberKey(k.key_prefix, k.key ?? k.plaintext);
      invalidate();
      setRotatedKey({ label: k.label, key: k.key ?? k.plaintext });
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
          <Skeleton className="h-40 w-full" />
        </Card>
      ) : !primaryKey ? (
        <Card>
          <EmptyState
            icon={<KeyRound size={32} />}
            title="No API key available"
            hint="Mirais uses one global key. Generate it once and rotate it any time you need to invalidate it."
            action={<Button onClick={() => createFirst.mutate()} loading={createFirst.isPending}><RefreshCw size={16} /> Generate new key</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-hidden border-accent/15 bg-[linear-gradient(135deg,rgba(124,92,255,0.14),rgba(18,22,31,0.92)_46%,rgba(18,22,31,0.96))]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1 space-y-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                    <KeyRound size={18} />
                  </span>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.24em] text-accent/80">Global gateway key</p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">{primaryKey.label}</h2>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-text-muted">Use this single credential for every OpenAI-compatible client pointing at <code className="text-text-primary">/v1/*</code>.</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Status" value={primaryKey.enabled ? "Active" : "Disabled"} tone={primaryKey.enabled ? "success" : "muted"} />
                  <Stat label="Created" value={fmtDateTime(primaryKey.created_at)} />
                  <Stat label="Last used" value={primaryKey.last_used_at ? fmtDateTime(primaryKey.last_used_at) : "Never"} />
                  <Stat label="Expires" value={primaryKey.expires_at ? fmtDateTime(primaryKey.expires_at) : "Never"} />
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur">
                  <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-text-muted">
                    <span>Secret</span>
                    <span className="text-text-muted/70">Visible to you only</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-xl border border-white/10 bg-bg-base/80 px-3 py-2 font-mono text-xs text-accent">
                      {remembered ?? `${primaryKey.key_prefix}••••••••••••••••`}
                    </code>
                    <CopyButton text={remembered ?? ""} />
                  </div>
                </div>
              </div>

              <div className="flex w-full shrink-0 flex-col gap-3 lg:w-64">
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur">
                  <div className="flex items-center gap-2">
                    {primaryKey.enabled ? <ShieldCheck size={15} className="text-success" /> : <ShieldOff size={15} className="text-text-muted" />}
                    <span className="text-sm font-medium">Key active</span>
                  </div>
                  <Switch
                    checked={!!primaryKey.enabled}
                    onChange={() => toggle.mutate(primaryKey)}
                    disabled={toggle.isPending && toggle.variables?.id === primaryKey.id}
                    aria-label={`Enable key ${primaryKey.label}`}
                  />
                </div>
                <Button variant="outline" className="justify-start" onClick={() => setEditing(primaryKey)}>
                  <Pencil size={14} /> Edit details
                </Button>
                <Button className="justify-start" onClick={() => rotate.mutate(primaryKey)} loading={rotate.isPending && rotate.variables?.id === primaryKey.id}>
                  <RefreshCw size={14} /> Generate new key
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">How to use this key</h3>
            <ul className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Base URL</span>
                <code className="font-mono text-[11px] text-accent">http://{typeof window !== "undefined" ? window.location.hostname : "127.0.0.1"}:1463/v1</code>
              </li>
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Auth header</span>
                <code className="font-mono text-[11px] text-accent">Authorization: Bearer &lt;this-key&gt;</code>
              </li>
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Compatible with</span>
                <span>OpenAI / Anthropic SDKs via Mirais translation.</span>
              </li>
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Rotate</span>
                <span>Generates a new secret and invalidates the old one.</span>
              </li>
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Use without a key</span>
                <span>
                  Set <code className="font-mono text-[11px] text-accent">MIRAIS_AUTH_REQUIRED=off</code> on the server. Requests with no <code className="font-mono text-[11px] text-accent">Authorization</code> header (or the placeholder <code className="font-mono text-[11px] text-accent">Bearer anonymous</code>) are accepted. Only safe when Mirais listens on 127.0.0.1 / a trusted network.
                </span>
              </li>
              <li className="rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2">
                <span className="block text-text-primary">Rotate = pause</span>
                <span>The AI coding agent must never rotate this key on its own. Confirm with you before any change.</span>
              </li>
            </ul>
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
