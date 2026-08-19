import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Download, Upload, History, RotateCcw, Palette, Database, Eye, EyeOff, SettingsIcon, HardDrive, Info, Save, Zap, Mail, ExternalLink, Brain, FileCode, Coffee, ChevronDown, ChevronUp, CheckCircle2, Loader2, XCircle, Globe2 } from "lucide-react";
import { settings, backups, healthInfo, providers, type BackupEntry, type TokenSaverSettings, type HeadroomSettings, type PonytailSettings, type CavemanSettings } from "../api";
import { Button, Card, ConfirmModal, Input, Modal, Switch, toast } from "../components/ui";
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

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                    */
/* ------------------------------------------------------------------ */

type SettingsTab = "general" | "appearance" | "models" | "tokensaver" | "backup" | "imap" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general",    label: "General",     icon: <SettingsIcon className="w-4 h-4" /> },
  { id: "appearance", label: "Appearance",  icon: <Palette className="w-4 h-4" /> },
  { id: "models",     label: "Models",      icon: <Zap className="w-4 h-4" /> },
  { id: "tokensaver", label: "Token Saver", icon: <Save className="w-4 h-4" /> },
  { id: "backup",     label: "Backup",      icon: <HardDrive className="w-4 h-4" /> },
  { id: "imap",       label: "IMAP",        icon: <Mail className="w-4 h-4" /> },
  { id: "about",      label: "About",       icon: <Info className="w-4 h-4" /> },
];

export default function Settings() {
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div>
      <PageHeader title="Settings" />
      {/* Tab bar */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl bg-bg-base/60 p-1 border border-border/70">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${
              tab === t.id
                ? "bg-bg-raised text-text-primary shadow-sm"
                : "text-text-muted hover:text-text-primary hover:bg-bg-raised/50"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      {/* Tab content */}
      <div className={tab === "general" ? "grid grid-cols-1 gap-6 lg:grid-cols-2" : "w-full"}>
        {tab === "general" && (
          <>
            <GatewaySection />
            <NetworkSection />
            <div className="lg:col-span-2">
              <DatabaseSection />
            </div>
          </>
        )}
        {tab === "appearance" && <AppearanceSection />}
        {tab === "models" && <ModelSyncSection />}
        {tab === "tokensaver" && <TokenSaverSection />}
        {tab === "backup" && <BackupSection />}
        {tab === "imap" && <XaiImapSection />}
        {tab === "about" && <AboutSection />}
      </div>
    </div>
  );
}

function DatabaseSection() {
  const health = useQuery({ queryKey: ["health-detailed"], queryFn: healthInfo.detailed, refetchInterval: 30_000 });
  const storage = health.data?.storage;
  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Database size={14} className="text-accent" />
        <h3 className="text-sm font-medium">Database</h3>
      </div>
      {health.isLoading ? (
        <p className="text-xs text-text-muted">Reading server info…</p>
      ) : health.isError ? (
        <p className="text-xs text-danger">Could not reach /api/health ({health.error instanceof Error ? health.error.message : "unknown error"})</p>
      ) : storage ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Data directory</dt>
            <dd className="break-all font-mono text-text-primary">{storage.data_dir}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Database file</dt>
            <dd className="break-all font-mono text-text-primary">
              {storage.db_path}
              {storage.db_exists ? ` · ${(storage.size_bytes / 1024).toFixed(0)} KB` : " · not on disk yet"}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Providers (enabled / total)</dt>
            <dd className="font-mono text-text-primary">
              {health.data?.providers.enabled ?? 0} / {health.data?.providers.total ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Active accounts</dt>
            <dd className="font-mono text-text-primary">{health.data?.providers.accounts ?? 0}</dd>
          </div>
        </dl>
      ) : null}
    </Card>
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
      <p className="mb-5 text-xs text-text-muted">Pick the dashboard accent color. Saved to server settings so it follows your account, with a local copy as fallback.</p>
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
      <div className="mb-1 flex items-center gap-2">
        <Globe2 size={14} className="text-accent" />
        <h3 className="text-sm font-medium">Network exposure</h3>
      </div>
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
      <div className="mb-4 flex items-center gap-2">
        <SettingsIcon size={14} className="text-accent" />
        <h3 className="text-sm font-medium">Gateway</h3>
      </div>
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
          <button
            key={opt.v}
            type="button"
            role="radio"
            aria-checked={mode === opt.v}
            onClick={() => save.mutate(opt.v)}
            disabled={save.isPending}
            className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-50 ${mode === opt.v ? "border-accent bg-accent/5" : "border-border hover:border-text-muted hover:bg-bg-raised/40"}`}
          >
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${mode === opt.v ? "border-accent" : "border-text-muted"}`}>
              {mode === opt.v && <span className="h-2 w-2 rounded-full bg-accent" />}
            </span>
            <span>
              <span className="block text-sm font-medium text-text-primary">{opt.label}</span>
              <span className="block text-xs text-text-muted">{opt.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-text-muted">Re-sync a provider to apply. Models that no longer pass the filter are removed automatically.</p>
    </Card>
  );
}

// ── boltToken Saver ──

function TokenSaverSection() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border/70 pb-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Token Saver</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">
              Reduce input, context, and output tokens with independent pipeline controls. Enable only the techniques you need.
            </p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RTKCard />
        <HeadroomCard />
        <CavemanCard />
        <PonytailCard />
      </div>
    </div>
  );
}

// ── RTK: Tool Output Compression ──

function RTKCard() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const providersQ = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const [ts, setTs] = useState<TokenSaverSettings>({
    enabled: false,
    rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200, maxToolOutputChars: 80000, collapseWhitespace: true, deduplicateToolOutputs: true, keepRecentToolResults: 8, gitStatus: true, findTree: true, buildLogs: true },
  });
  const [expanded, setExpanded] = useState(false);
  // `null` = apply to every provider; array = only the listed providers.
  const [saverProviders, setSaverProviders] = useState<string[] | null>(null);

  useEffect(() => {
    if (s.data?.token_saver) setTs(s.data.token_saver);
    if (s.data?.token_saver_providers !== undefined) setSaverProviders(s.data.token_saver_providers);
  }, [s.data]);

  const save = useMutation({
    mutationFn: (next: TokenSaverSettings) => settings.update({ token_saver: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("RTK saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const saveProviders = useMutation({
    mutationFn: (next: string[] | null) => settings.update({ token_saver_providers: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Provider scope saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const setRule = (k: keyof TokenSaverSettings["rules"], v: boolean | number) =>
    setTs({ ...ts, rules: { ...ts.rules, [k]: v } });

  const toggleEnabled = (v: boolean) => {
    const next = { ...ts, enabled: v };
    setTs(next);
    save.mutate(next);
  };

  const allProviders = providersQ.data ?? [];
  const applyToAll = saverProviders === null;
  const toggleApplyToAll = (v: boolean) => {
    const next = v ? null : allProviders.map((p) => p.name);
    setSaverProviders(next);
    saveProviders.mutate(next);
  };
  const toggleProvider = (name: string, on: boolean) => {
    const current = saverProviders ?? [];
    const next = on ? Array.from(new Set([...current, name])) : current.filter((n) => n !== name);
    setSaverProviders(next);
    saveProviders.mutate(next);
  };

  return (
    <Card className="overflow-hidden">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15">
          <FileCode className="h-4.5 w-4.5 text-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold">Tool Output Compression</h3>
              <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20">
                RTK <ExternalLink size={10} />
              </a>
            </div>
            <Switch checked={ts.enabled} onChange={toggleEnabled} disabled={save.isPending} aria-label="Enable RTK" />
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Compress git/grep/ls/tree/logs — <strong>60-90% fewer input tokens</strong> from tool outputs.
            Lossless for semantics, lossy for verbosity.
          </p>
        </div>
      </div>

      {/* Provider scope */}
      <div className={`mb-4 rounded-lg border border-border bg-bg-base/40 p-3 ${ts.enabled ? "" : "pointer-events-none opacity-40"}`}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-muted">Apply to all providers</span>
          <Switch checked={applyToAll} onChange={toggleApplyToAll} disabled={saveProviders.isPending} aria-label="Apply to all providers" />
        </div>
        {!applyToAll && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {allProviders.length === 0 && (
              <span className="text-[11px] text-text-muted">No providers configured yet.</span>
            )}
            {allProviders.map((p) => {
              const on = (saverProviders ?? []).includes(p.name);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleProvider(p.name, !on)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${on ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-text-muted"}`}
                >
                  <span className={`h-2 w-2 rounded-full ${on ? "bg-accent" : "bg-border"}`} />
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-tight text-text-muted">
          Untick "all providers" to pick exactly which providers run through the token saver.
          Providers left unchecked send raw (uncompressed) tool output.
        </p>
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`mb-3 flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs text-text-muted hover:bg-bg-base/50 transition-colors ${ts.enabled ? "" : "pointer-events-none opacity-40"}`}
      >
        <span>Configure compression rules</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(ts); }} className={`space-y-2.5 ${ts.enabled ? "" : "pointer-events-none opacity-50"}`}>
          {([
            ["gitDiff", "Compress git diff (drop repeated context lines)"],
            ["grep", "Compress grep/search output (collapse separators)"],
            ["ls", "Compress directory listings (strip blanks)"],
            ["gitStatus", "Compress git status/log (trim boilerplate)"],
            ["findTree", "Compress find/tree (deduplicate paths)"],
            ["buildLogs", "Deduplicate repetitive build/test logs"],
            ["collapseWhitespace", "Collapse redundant whitespace"],
            ["deduplicateToolOutputs", "Omit duplicate tool outputs (SHA256)"],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between text-[11px] leading-tight">
              <span className="text-text-muted">{label}</span>
              <Switch checked={ts.rules[k] ?? false} onChange={(v) => setRule(k, v)} />
            </label>
          ))}
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div>
              <label className="mb-0.5 block text-[11px] text-text-muted">Max lines</label>
              <Input type="number" min={10} max={2000} value={ts.rules.longOutputMaxLines} onChange={(e) => setRule("longOutputMaxLines", Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-text-muted">Recent kept</label>
              <Input type="number" min={0} max={100} value={ts.rules.keepRecentToolResults ?? 8} onChange={(e) => setRule("keepRecentToolResults", Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-text-muted">Max chars</label>
              <Input type="number" min={1000} max={1000000} value={ts.rules.maxToolOutputChars ?? 80000} onChange={(e) => setRule("maxToolOutputChars", Number(e.target.value))} />
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="submit" size="sm" loading={save.isPending}>Save</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ── Headroom: Context Compression ──

function HeadroomCard() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [cfg, setCfg] = useState<HeadroomSettings>({ enabled: false, keepRecent: 10, summarize: true, maxChars: 100_000 });

  useEffect(() => {
    if (s.data?.headroom) setCfg(s.data.headroom);
  }, [s.data]);

  const save = useMutation({
    mutationFn: (next: HeadroomSettings) => settings.update({ headroom: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Headroom saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const toggle = (v: boolean) => {
    const next = { ...cfg, enabled: v };
    setCfg(next);
    save.mutate(next);
  };

  return (
    <Card className="overflow-hidden">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/15">
          <Brain className="h-4.5 w-4.5 text-sky-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold">Context Compression</h3>
              <a href="https://github.com/chopratejas/headroom" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20">
                Headroom <ExternalLink size={10} />
              </a>
            </div>
            <Switch checked={cfg.enabled} onChange={toggle} disabled={save.isPending} aria-label="Enable Headroom" />
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Summarizes older messages in long conversations. Keeps recent messages intact,
            compresses the rest into a summary — like a <strong>rolling context window</strong>.
          </p>
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); save.mutate(cfg); }} className={`space-y-3 ${cfg.enabled ? "" : "pointer-events-none opacity-50"}`}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">Recent messages kept intact</label>
            <Input type="number" min={2} max={100} value={cfg.keepRecent}
              onChange={(e) => setCfg({ ...cfg, keepRecent: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">Max total characters</label>
            <Input type="number" min={1000} max={1000000} value={cfg.maxChars}
              onChange={(e) => setCfg({ ...cfg, maxChars: Number(e.target.value) })} />
          </div>
        </div>
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-text-muted">Summarize older messages (instead of dropping them)</span>
          <Switch checked={cfg.summarize} onChange={(v) => setCfg({ ...cfg, summarize: v })} />
        </label>
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Card>
  );
}

// ── Caveman: Terse Output ──

const CAVEMAN_PRESETS: Record<string, string> = {
  default: "You are a helpful AI assistant. Be concise. Reply with the answer directly, no fluff, no preambles, no summaries unless asked. Write code, don't explain it unless asked.",
  extreme: "You are a terse AI. Reply with only the essential information. No greetings, no explanations, no follow-up offers. If code: just the code. If answer: just the answer. One sentence if possible.",
  coder: "You are a senior engineer. Write minimal, correct code. No comments unless the logic is truly non-obvious. No explanations unless explicitly requested. YAGNI.",
};

function CavemanCard() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [cfg, setCfg] = useState<CavemanSettings>({ enabled: false, prompt: CAVEMAN_PRESETS.default });
  const [preset, setPreset] = useState("default");

  useEffect(() => {
    if (s.data?.terse_mode) {
      setCfg(s.data.terse_mode);
      // detect preset
      for (const [k, v] of Object.entries(CAVEMAN_PRESETS)) {
        if (v === s.data.terse_mode.prompt) { setPreset(k); break; }
      }
    }
  }, [s.data]);

  const save = useMutation({
    mutationFn: (next: CavemanSettings) => settings.update({ terse_mode: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Caveman saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const toggle = (v: boolean) => {
    const next = { ...cfg, enabled: v };
    setCfg(next);
    save.mutate(next);
  };

  const applyPreset = (key: string) => {
    setPreset(key);
    const next = { ...cfg, prompt: CAVEMAN_PRESETS[key] };
    setCfg(next);
  };

  return (
    <Card className="overflow-hidden">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15">
          <Coffee className="h-4.5 w-4.5 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold">Terse Output Mode</h3>
              <a href="https://github.com/JuliusBrussee/caveman" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20">
                Caveman <ExternalLink size={10} />
              </a>
            </div>
            <Switch checked={cfg.enabled} onChange={toggle} disabled={save.isPending} aria-label="Enable Caveman" />
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Terse-style system prompt → <strong>~65% fewer output tokens</strong> (up to 87%).
            Strips fluff, greetings, and unsolicited explanations.
          </p>
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); save.mutate(cfg); }} className={`space-y-3 ${cfg.enabled ? "" : "pointer-events-none opacity-50"}`}>
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">Preset</label>
          <div className="flex gap-1.5 flex-wrap">
            {Object.keys(CAVEMAN_PRESETS).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => applyPreset(k)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  preset === k
                    ? "bg-accent text-white"
                    : "bg-bg-base text-text-muted hover:text-text-primary hover:bg-bg-raised"
                }`}
              >
                {k === "default" ? "Default" : k === "extreme" ? "Extreme" : "Coder"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">System prompt (editable)</label>
          <textarea
            className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-xs text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y"
            rows={3}
            value={cfg.prompt}
            onChange={(e) => { setPreset("custom"); setCfg({ ...cfg, prompt: e.target.value }); }}
            placeholder="Enter terse system prompt..."
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Card>
  );
}

// ── Ponytail: Lazy Senior Dev ──

const PONYTAIL_LABELS: Record<string, string> = {
  light: "Light — prefer simplicity, fewer lines",
  moderate: "Moderate — YAGNI, stdlib, delete over comment",
  extreme: "Extreme — one-liners, no error handling, minimal everything",
};

function PonytailCard() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [cfg, setCfg] = useState<PonytailSettings>({ enabled: false, strength: "moderate" });

  useEffect(() => {
    if (s.data?.ponytail) setCfg(s.data.ponytail);
  }, [s.data]);

  const save = useMutation({
    mutationFn: (next: PonytailSettings) => settings.update({ ponytail: next }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Ponytail saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  const toggle = (v: boolean) => {
    const next = { ...cfg, enabled: v };
    setCfg(next);
    save.mutate(next);
  };

  return (
    <Card className="overflow-hidden">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/15">
          <Coffee className="h-4.5 w-4.5 text-rose-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold">Lazy Senior Dev Bias</h3>
              <a href="https://github.com/DietrichGebert/ponytail" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20">
                Ponytail <ExternalLink size={10} />
              </a>
            </div>
            <Switch checked={cfg.enabled} onChange={toggle} disabled={save.isPending} aria-label="Enable Ponytail" />
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Biases the model toward minimal code: <strong>YAGNI, reuse stdlib, deletion over addition</strong>.
            Injects a system prompt — works with any model.
          </p>
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); save.mutate(cfg); }} className={`space-y-3 ${cfg.enabled ? "" : "pointer-events-none opacity-50"}`}>
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">Strength</label>
          <div className="flex gap-1.5 flex-wrap">
            {(["light", "moderate", "extreme"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setCfg({ ...cfg, strength: k })}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-left transition-colors ${
                  cfg.strength === k
                    ? "bg-accent text-white"
                    : "bg-bg-base text-text-muted hover:text-text-primary hover:bg-bg-raised"
                }`}
              >
                <div>{k === "light" ? "Light" : k === "moderate" ? "Moderate" : "Extreme"}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{PONYTAIL_LABELS[k]}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={save.isPending}>Save</Button>
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
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<{ progress: number; stage: string; status: "running" | "success" | "error" } | null>(null);
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
    mutationFn: async ({ id, mode }: { id: string; mode: "merge" | "overwrite" }) => {
      setRestoreProgress({ progress: 10, stage: "Preparing backup restore…", status: "running" });
      const data = await backups.restore(id, mode);
      if (data.mode === "merge") {
        setRestoreProgress({ progress: 80, stage: "Finishing database merge…", status: "running" });
        const added = Object.entries(data.added ?? {}).filter(([, n]) => n > 0).map(([t, n]) => `${t}: +${n}`).join(", ");
        const skipped = Object.entries(data.skipped ?? {}).filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n}`).join(", ");
        toast(`Merge done. ${added || "Nothing added"}.${skipped ? ` Duplicates skipped (${skipped}).` : ""}`, "success");
        qc.invalidateQueries({ queryKey: ["backups"] });
        setRestoreProgress({ progress: 100, stage: "Restore completed successfully.", status: "success" });
      } else {
        setRestoreProgress({ progress: 55, stage: "Restarting Mirais…", status: "running" });
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            await healthInfo.detailed();
            qc.invalidateQueries({ queryKey: ["backups"] });
            setRestoreProgress({ progress: 100, stage: "Mirais is back online. Restore completed successfully.", status: "success" });
            return;
          } catch {
            setRestoreProgress({ progress: Math.min(95, 60 + attempt), stage: "Waiting for Mirais to come back online…", status: "running" });
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
        }
        throw new Error("Mirais did not come back online within one minute");
      }
    },
    onSuccess: () => setRestoreId(null),
    onError: (e) => {
      setRestoreProgress({ progress: 100, stage: e.message, status: "error" });
      toast(e.message, "error");
    },
  });

  const formatSize = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  const formatDate = (value: string) => new Date(value).toLocaleString();
  const startRestore = (mode: "merge" | "overwrite") => {
    if (!restoreId) return;
    setRestoreId(null);
    restore.mutate({ id: restoreId, mode });
  };

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-accent" />
            <h3 className="text-sm font-medium">Backup & restore</h3>
          </div>
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
            <Button size="sm" variant="outline" onClick={() => setRestoreId(backup.id)}><RotateCcw size={14} /> Restore</Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmId(backup.id)}><Trash2 size={14} /></Button>
          </div>
        </div>)}
      </div>}
      <ConfirmModal open={!!confirmId} onClose={() => setConfirmId(null)} onConfirm={() => confirmId && remove.mutate(confirmId)} title="Delete backup" message="This backup will be permanently deleted." danger loading={remove.isPending} />

      <Modal open={!!restoreId} onClose={() => setRestoreId(null)} title="Restore backup">
        <p className="mb-5 text-sm text-text-muted">Choose how to restore this backup:</p>
        <div className="space-y-3">
          <button
            onClick={() => startRestore("merge")}
            disabled={restore.isPending}
            className="w-full rounded-xl border border-border p-4 text-left hover:border-accent/40 hover:bg-bg-raised disabled:opacity-50"
          >
            <p className="text-sm font-medium">Merge</p>
            <p className="mt-1 text-xs text-text-muted">Adds data from the backup into the current database. Rows that already exist (e.g. same provider key) are skipped — no duplicates.</p>
          </button>
          <button
            onClick={() => startRestore("overwrite")}
            disabled={restore.isPending}
            className="w-full rounded-xl border border-destructive/30 p-4 text-left hover:bg-destructive/10 disabled:opacity-50"
          >
            <p className="text-sm font-medium text-destructive">Overwrite</p>
            <p className="mt-1 text-xs text-text-muted">Replaces the entire database with the backup. Current data is lost (a pre-restore fallback backup is created automatically). Mirais restarts.</p>
          </button>
        </div>
      </Modal>

      <Modal open={!!restoreProgress} onClose={() => restoreProgress?.status !== "running" && setRestoreProgress(null)} title="Restoring backup">
        {restoreProgress && <div className="space-y-4">
          <div className="flex items-center gap-3">
            {restoreProgress.status === "running" ? <Loader2 className="h-5 w-5 animate-spin text-accent" /> : restoreProgress.status === "success" ? <CheckCircle2 className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-danger" />}
            <p className="text-sm text-text-muted">{restoreProgress.stage}</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bg-base" role="progressbar" aria-label="Restore progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={restoreProgress.progress}>
            <div className={`h-full rounded-full transition-all duration-300 ${restoreProgress.status === "error" ? "bg-danger" : restoreProgress.status === "success" ? "bg-success" : "bg-accent"}`} style={{ width: `${restoreProgress.progress}%` }} />
          </div>
          <p className="text-right font-mono text-xs text-text-muted">{restoreProgress.progress}%</p>
          {restoreProgress.status !== "running" && <div className="flex justify-end"><Button size="sm" onClick={() => setRestoreProgress(null)}>Close</Button></div>}
        </div>}
      </Modal>
    </Card>
  );
}

// ── XAI IMAP settings ──

function XaiImapSection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [form, setForm] = useState({
    enabled: false,
    gmail_username: "",
    gmail_app_password: "",
    email_domain: "levanza.my.id",
    account_password: "",
    headless: false,
    otp_check_interval: 5,
    otp_max_retries: 12,
  });

  useEffect(() => {
    if (s.data?.xai_imap) {
      setForm({
        enabled: s.data.xai_imap.enabled ?? false,
        gmail_username: s.data.xai_imap.gmail_username ?? "",
        gmail_app_password: s.data.xai_imap.gmail_app_password ?? "",
        email_domain: s.data.xai_imap.email_domain ?? "levanza.my.id",
        account_password: s.data.xai_imap.account_password ?? "",
        headless: s.data.xai_imap.headless ?? false,
        otp_check_interval: s.data.xai_imap.otp_check_interval ?? 5,
        otp_max_retries: s.data.xai_imap.otp_max_retries ?? 12,
      });
    }
  }, [s.data]);

  const save = useMutation({
    mutationFn: () => settings.update({
      xai_imap: {
        ...form,
        gmail_app_password: form.gmail_app_password.replace(/[\s-]/g, ""),
        account_password: form.account_password || undefined,
      },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast("XAI IMAP settings saved");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const updateField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <Mail size={14} className="text-accent" />
        <h3 className="text-sm font-medium">XAI IMAP</h3>
      </div>
      <p className="mb-4 text-xs text-text-muted">Configure Gmail IMAP for xAI (Grok) account farming. OTP emails are forwarded to this Gmail account.</p>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-text-primary">Enable xAI farming</p>
            <p className="mt-0.5 text-xs text-text-muted">Allow automated xAI account registration</p>
          </div>
          <Switch checked={form.enabled} onChange={(v) => updateField("enabled", v)} />
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Gmail address (receives OTP)</label>
          <Input type="email" value={form.gmail_username} onChange={(e) => updateField("gmail_username", e.target.value)} placeholder="your.email@gmail.com" disabled={!form.enabled} />
          <p className="mt-1 text-xs text-text-muted">The Gmail account that receives forwarded OTP emails from {form.email_domain}</p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Gmail App Password</label>
          <div className="relative">
            <Input type={showAppPassword ? "text" : "password"} value={form.gmail_app_password} onChange={(e) => updateField("gmail_app_password", e.target.value)} placeholder="abcd efgh ijkl mnop" maxLength={19} disabled={!form.enabled} className="pr-10" />
            <button type="button" onClick={() => setShowAppPassword((visible) => !visible)} aria-label={showAppPassword ? "Hide Gmail App Password" : "Show Gmail App Password"} title={showAppPassword ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted transition-colors hover:text-text-primary">
              {showAppPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">16-character App Password from Google Account ? Security ? 2-Step Verification ? App passwords. Spaces are accepted and removed automatically.</p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Email domain for farming</label>
          <Input type="text" value={form.email_domain} onChange={(e) => updateField("email_domain", e.target.value)} placeholder="levanza.my.id" disabled={!form.enabled} />
          <p className="mt-1 text-xs text-text-muted">Random emails will be generated as {`<random>`}@{form.email_domain}</p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-text-muted">Farm account password</label>
          <Input type="password" value={form.account_password} onChange={(e) => updateField("account_password", e.target.value)} placeholder="Minimum 8 characters (optional)" disabled={!form.enabled} />
          <p className="mt-1 text-xs text-text-muted">Password used for newly farmed xAI accounts. Leave empty to auto-generate a random password.</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-text-primary">Headless browser</p>
            <p className="mt-0.5 text-xs text-text-muted">Run Camoufox in headless mode (no visible browser window)</p>
          </div>
          <Switch checked={form.headless} onChange={(v) => updateField("headless", v)} disabled={!form.enabled} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs text-text-muted">OTP check interval (seconds)</label>
            <Input type="number" min={1} max={60} value={form.otp_check_interval} onChange={(e) => updateField("otp_check_interval", Number(e.target.value))} disabled={!form.enabled} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">Max OTP retries</label>
            <Input type="number" min={1} max={60} value={form.otp_max_retries} onChange={(e) => updateField("otp_max_retries", Number(e.target.value))} disabled={!form.enabled} />
          </div>
        </div>

        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-300"><strong>Note:</strong> Make sure your domain's email routing forwards all emails to the Gmail address above. The farm script will monitor this Gmail inbox for OTP verification codes from x.ai.</p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>Save XAI Settings</Button>
        </div>
      </form>
    </Card>
  );
}

function AboutSection() {
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Info size={14} className="text-accent" />
        <h3 className="text-sm font-medium">About</h3>
      </div>
      <div className="space-y-1 text-xs text-text-muted">
        <p><span className="text-text-primary">Mirais</span> — self-hosted AI gateway & router</p>
        <p>Gateway endpoint: <code className="font-mono text-accent">http://localhost:1463/v1</code></p>
        <p>All data stays on this machine. No telemetry, ever.</p>
      </div>
    </Card>
  );
}
