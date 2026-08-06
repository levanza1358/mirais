import { useState, useEffect, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { settings, auth, ApiError, type TokenSaverSettings } from "../api";
import { Button, Card, Input, Switch, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Settings() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GatewaySection />
        <ModelSyncSection />
        <TokenSaverSection />
        <SecuritySection />
        <div className="lg:col-span-2">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <PasswordSection />
            <AboutSection />
          </div>
        </div>
      </div>
    </div>
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

// ── security (session) ──

function SecuritySection() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: settings.get });
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (s.data) setRemember(!!s.data.session_remember_default);
  }, [s.data]);

  const save = useMutation({
    mutationFn: (v: boolean) => settings.update({ session_remember_default: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast("Security setting saved"); },
    onError: (e) => toast(e.message, "error"),
  });

  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Security</h3>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-text-primary">Never ask password by default</p>
          <p className="mt-0.5 text-xs text-text-muted">
            Pre-checks the "Never ask password" box on the login screen. Sessions last 6 hours by default;
            with the box checked they stay valid for 30 days on this device.
          </p>
        </div>
        <Switch checked={remember} onChange={(v) => { setRemember(v); save.mutate(v); }} />
      </div>
    </Card>
  );
}

// ── password ──

function PasswordSection() {
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState("");

  const changePw = useMutation({
    mutationFn: () => auth.changePassword(pw.current, pw.next),
    onSuccess: () => {
      toast("Password changed");
      setPw({ current: "", next: "", confirm: "" });
      setError("");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed to change password"),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (pw.next.length < 8) return setError("New password must be at least 8 characters");
    if (pw.next !== pw.confirm) return setError("Passwords do not match");
    changePw.mutate();
  }

  return (
    <Card>
      <h3 className="mb-4 text-sm font-medium">Change dashboard password</h3>
      <form onSubmit={submit} className="space-y-3">
        <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        <Input type="password" placeholder="New password (min 8 chars)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
        <Input type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" loading={changePw.isPending} disabled={!pw.current || !pw.next || !pw.confirm}>Change password</Button>
        </div>
      </form>
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
