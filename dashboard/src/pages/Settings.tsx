import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Download, Upload, History, RotateCcw, Palette } from "lucide-react";
import { settings, backups, type BackupEntry, type TokenSaverSettings } from "../api";
import { Button, Card, ConfirmModal, Input, Switch, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

const ACCENT_OPTIONS: Array<{ id: string; label: string; value: string }> = [
  { id: "violet", label: "Violet", value: "#7c5cff" },
  { id: "indigo", label: "Indigo", value: "#6366f1" },
  { id: "sky", label: "Sky", value: "#38bdf8" },
  { id: "teal", label: "Teal", value: "#2dd4bf" },
  { id: "emerald", label: "Emerald", value: "#34d399" },
  { id: "amber", label: "Amber", value: "#fbbf24" },
  { id: "rose", label: "Rose", value: "#fb7185" },
  { id: "pink", label: "Pink", value: "#ec4899" },
];

const ACCENT_STORAGE_KEY = "mirais.ui.accent";

function applyAccentColor(value: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--color-accent", value);
  document.documentElement.style.setProperty("--color-accent-rgb", hexToRgb(value));
}

function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "124, 92, 255";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function readStoredAccent(): string {
  if (typeof window === "undefined") return "#7c5cff";
  try {
    const v = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  } catch {
    /* ignore */
  }
  return "#7c5cff";
}

export default function Settings() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GatewaySection />
        <NetworkSection />
        <AppearanceSection />
        <ModelSyncSection />
        <TokenSaverSection />
        <BackupSection />
        <div className="lg:col-span-2">
          <AboutSection />
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const backendAccent = settingsQ.data?.ui?.accent;
  const [accent, setAccent] = useState<string>(() => backendAccent ?? readStoredAccent());
  const [custom, setCustom] = useState<string>("");

  // Re-hydrate from backend once it loads.
  useEffect(() => {
    if (backendAccent && /^#[0-9a-fA-F]{6}$/.test(backendAccent)) {
      setAccent(backendAccent);
    }
  }, [backendAccent]);

  useEffect(() => {
    applyAccentColor(accent);
  }, [accent]);

  useEffect(() => {
    if (!custom) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(custom)) return;
    setAccent(custom);
  }, [custom]);

  const saveBackend = useMutation({
    mutationFn: (value: string) => settings.update({ ui: { theme: "dark", accent: value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
    onError: (e) => toast(e.message, "error"),
  });

  const choose = (value: string) => {
    setAccent(value);
    setCustom("");
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
    saveBackend.mutate(value);
  };

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <Palette size={14} className="text-accent" />
        <h3 className="text-sm font-medium">Appearance</h3>
      </div>
      <p className="mb-4 text-xs text-text-muted">Pick the dashboard accent color. Saved to server settings so it follows your account, with a local copy as fallback.</p>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {ACCENT_OPTIONS.map((opt) => {
          const isActive = opt.value.toLowerCase() === accent.toLowerCase();
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => choose(opt.value)}
              className={`group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors ${isActive ? "border-text-primary bg-bg-raised" : "border-border/70 bg-bg-base/60 hover:border-accent/40"}`}
              title={opt.label}
            >
              <span className="block h-6 w-6 rounded-full" style={{ background: opt.value }} />
              <span className="text-[10px] text-text-muted group-hover:text-text-primary">{opt.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-muted">Custom</span>
        <input
          type="color"
          value={accent}
          onChange={(e) => choose(e.currentTarget.value)}
          aria-label="Custom accent color"
          className="h-8 w-10 cursor-pointer rounded-lg border border-border/70 bg-bg-base/60"
        />
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.currentTarget.value)}
          placeholder="#7c5cff"
          className="h-8 w-32 rounded-lg border border-border/70 bg-bg-base/60 px-2 font-mono text-xs"
        />
        <Button size="sm" variant="outline" onClick={() => choose("#7c5cff")}>Reset to default</Button>
        <span className="ml-auto text-[10px] text-text-muted">synced to server{saveBackend.isPending ? " · saving" : ""}</span>
      </div>
    </Card>
  );
}

function NetworkSection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const exposed = s.data?.network_binding?.exposed ?? (s.data?.env.host === "0.0.0.0");

  const save = useMutation({
    mutationFn: (next: boolean) => settings.update({ network_binding: { exposed: next, host: next ? "0.0.0.0" : "127.0.0.1" } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Network binding saved — restart Mirais to apply"); },
    onError: (e) => toast(e.message, "error"),
  });

  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Network exposure</h3>
      <p className="mb-4 text-xs text-text-muted">Default is exposed. When enabled, Mirais binds to <code className="font-mono">0.0.0.0</code> so it can be reached from LAN, Tailscale, or the internet depending on your firewall and routing.</p>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-text-primary">Expose to network</p>
          <p className="mt-0.5 text-xs text-text-muted">Current configured host: <code className="font-mono">{s.data?.network_binding?.host ?? s.data?.env.host ?? "0.0.0.0"}</code></p>
        </div>
        <Switch checked={exposed} onChange={(v) => save.mutate(v)} disabled={save.isPending || !s.data} />
      </div>
      <p className="mt-3 text-xs text-amber-300">Changing this only updates the saved binding preference. Restart Mirais to actually switch between <code className="font-mono">0.0.0.0</code> and <code className="font-mono">127.0.0.1</code>.</p>
    </Card>
  );
}

// ── gateway (retention) ──

function GatewaySection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [retention, setRetention] = useState("30");

  useEffect(() => {
    if (s.data) setRetention(String(s.data.log_retention_days));
  }, [s.data]);

  const save = useMutation({
    mutationFn: () => settings.update({ log_retention_days: Number(retention) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Settings saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  return (
    <Card>
      <h3 className="mb-4 text-sm font-medium">Gateway</h3>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Log retention (days)</label>
          <Input type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} disabled={!s.data} />
        </div>
        {s.data && (
          <div className="rounded-lg bg-bg-base/50 p-3 text-xs text-text-muted">
            <p className="mb-1 font-medium text-text-primary">Environment (read-only, set via .env)</p>
            <p>Port: <code className="font-mono">{s.data.env.port}</code> · Host: <code className="font-mono">{s.data.env.host}</code></p>
            <p>Payload tracking: <code className="font-mono">{s.data.env.track_payloads}</code> · Upstream timeout: <code className="font-mono">{s.data.env.upstream_timeout_ms}ms</code></p>
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Card>
  );
}

// ── model sync ──

function ModelSyncSection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });

  const save = useMutation({
    mutationFn: (mode: "curated" | "all") => settings.update({ model_sync_mode: mode }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Model sync mode saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const mode = s.data?.model_sync_mode ?? "curated";

  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Model sync</h3>
      <p className="mb-4 text-xs text-text-muted">
        Which models are kept when syncing a provider. Non-chat models (embeddings, image, audio) are always dropped.
      </p>
      <div className="space-y-2">
        {([
          { v: "curated" as const, label: "Curated", desc: "Only flagship chat models (GPT, Claude, Gemini, DeepSeek, Llama, Qwen, Kimi, …). Recommended." },
          { v: "all" as const, label: "All chat models", desc: "Keep every chat-completion model the provider lists." },
        ]).map((opt) => (
          <label key={opt.v} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${mode === opt.v ? "border-accent bg-accent/5" : "border-border hover:border-text-muted"}`}>
            <input
              type="radio"
              name="model_sync_mode"
              className="mt-0.5"
              checked={mode === opt.v}
              onChange={() => save.mutate(opt.v)}
              disabled={save.isPending}
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">{opt.label}</span>
              <span className="block text-xs text-text-muted">{opt.desc}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-text-muted">Re-sync a provider to apply. Models that no longer pass the filter are removed automatically.</p>
    </Card>
  );
}

// ── token saver ──

function TokenSaverSection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [ts, setTs] = useState<TokenSaverSettings>({
    enabled: false,
    rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200 },
  });

  useEffect(() => {
    if (s.data?.token_saver) setTs(s.data.token_saver);
  }, [s.data]);

  const save = useMutation({
    mutationFn: (next: TokenSaverSettings) => settings.update({ token_saver: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Token saver saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const setRule = (k: keyof TokenSaverSettings["rules"], v: boolean | number) =>
    setTs({ ...ts, rules: { ...ts.rules, [k]: v } });

  // Master toggle persists immediately so the OFF state can always be saved
  // (the rules form below is disabled while the saver is off).
  const toggleEnabled = (v: boolean) => {
    const next = { ...ts, enabled: v };
    setTs(next);
    save.mutate(next);
  };

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Token saver</h3>
          <p className="mt-0.5 text-xs text-text-muted">Compress tool outputs in requests to reduce upstream token usage.</p>
        </div>
        <Switch checked={ts.enabled} onChange={toggleEnabled} disabled={save.isPending} aria-label="Enable token saver" />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(ts); }} className={`space-y-3 ${ts.enabled ? "" : "pointer-events-none opacity-50"}`}>
        {([
          ["gitDiff", "Compress git diff output"],
          ["grep", "Compress grep/search output"],
          ["ls", "Compress directory listings"],
        ] as const).map(([k, label]) => (
          <label key={k} className="flex items-center justify-between text-xs">
            <span>{label}</span>
            <Switch checked={ts.rules[k]} onChange={(v) => setRule(k, v)} />
          </label>
        ))}
        <div>
          <label className="mb-1 block text-xs text-text-muted">Max lines for long outputs</label>
          <Input
            type="number"
            min={10}
            max={5000}
            value={ts.rules.longOutputMaxLines}
            onChange={(e) => setRule("longOutputMaxLines", Number(e.target.value))}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Card>
  );
}

// ── backup & restore ──

function BackupSection() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["backups"], queryFn: backups.list });

  const create = useMutation({
    mutationFn: backups.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backups"] }); toast("Backup created"); },
    onError: (e) => toast(e.message, "error"),
  });
  const upload = useMutation({
    mutationFn: backups.upload,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backups"] }); toast("Backup uploaded"); },
    onError: (e) => toast(e.message, "error"),
  });
  const remove = useMutation({
    mutationFn: backups.remove,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backups"] }); toast("Backup deleted"); setConfirmId(null); },
    onError: (e) => toast(e.message, "error"),
  });
  const restore = useMutation({
    mutationFn: backups.restore,
    onSuccess: () => toast("Backup restored. Mirais is restarting — reload in a few seconds."),
    onError: (e) => toast(e.message, "error"),
  });

  const formatSize = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  const formatDate = (value: string) => new Date(value).toLocaleString();

  return (
    <Card className="lg:col-span-2">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Backup & restore</h3>
          <p className="mt-1 text-xs text-text-muted">Create a consistent SQLite snapshot, download it, or restore a previous backup. A pre-restore fallback is created automatically.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}><Download size={14} /> Backup now</Button>
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} loading={upload.isPending}><Upload size={14} /> Upload</Button>
          <input ref={fileRef} type="file" accept=".db,application/octet-stream" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload.mutate(file); e.currentTarget.value = ""; }} />
        </div>
      </div>
      {list.isLoading && <p className="text-xs text-text-muted">Loading backups…</p>}
      {!list.isLoading && !list.data?.backups.length && <p className="rounded-lg bg-bg-base/50 p-4 text-xs text-text-muted">No backups yet.</p>}
      {!!list.data?.backups.length && <div className="divide-y divide-border rounded-lg border border-border">
        {list.data.backups.map((backup: BackupEntry) => <div key={backup.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0"><p className="truncate font-mono text-xs text-text-primary">{backup.filename}</p><p className="mt-1 text-xs text-text-muted">{formatSize(backup.size_bytes)} · {formatDate(backup.created_at)}</p></div>
          <div className="flex gap-1">
            <a className="inline-flex h-9 items-center gap-1 rounded-xl px-3 text-xs text-text-muted hover:bg-bg-raised hover:text-text-primary" href={backups.downloadUrl(backup.id)}><Download size={14} /> Download</a>
            <Button size="sm" variant="outline" onClick={() => restore.mutate(backup.id)} loading={restore.isPending}><RotateCcw size={14} /> Restore</Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmId(backup.id)}><Trash2 size={14} /></Button>
          </div>
        </div>)}
      </div>}
      <ConfirmModal open={!!confirmId} onClose={() => setConfirmId(null)} onConfirm={() => confirmId && remove.mutate(confirmId)} title="Delete backup" message="This backup will be permanently deleted." danger loading={remove.isPending} />
    </Card>
  );
}

// ── about ──

function AboutSection() {
  return (
    <Card>
      <h3 className="mb-2 text-sm font-medium">About</h3>
      <div className="space-y-1 text-xs text-text-muted">
        <p><span className="text-text-primary">Mirais</span> — self-hosted AI gateway & router</p>
        <p>Gateway endpoint: <code className="font-mono text-accent">http://localhost:1463/v1</code></p>
        <p>All data stays on this machine. No telemetry, ever.</p>
      </div>
    </Card>
  );
}
