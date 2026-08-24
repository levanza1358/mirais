import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Eye, EyeOff, ListChecks, Loader2, Plus } from "lucide-react";
import { type Provider, type ProviderAccount, providers } from "../../api";
import { Button, Input, Modal, toast } from "../../components/ui";

export function AddAccountModal({ provider: p, accountCount, reconnectAccount, onClose }: { provider: Provider; accountCount: number; reconnectAccount?: ProviderAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"pick" | "single" | "bulk" | "oauth">(reconnectAccount ? "oauth" : "pick");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [bulk, setBulk] = useState("");
  const [bulkProgress, setBulkProgress] = useState(0);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["providers"] });
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [copilotAccountId, setCopilotAccountId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [dupe, setDupe] = useState<{ login: string; accountId: string } | null>(null);
  const overwriteRef = useRef(false);
  const copilotConnected = useRef(false);
  const [startingCopilot, setStartingCopilot] = useState(false);

  const close = () => {
    if (copilotAccountId && !copilotConnected.current) void providers.copilotCancel(copilotAccountId).catch(() => undefined);
    setStartingCopilot(false);
    onClose();
  };

  const startOauth = useMutation({
    mutationFn: () => providers.oauthStart(p.id),
    onSuccess: (r) => {
      setOauthState(r.state);
      setOauthUrl(r.url);
      const popup = window.open(r.url, "_blank", "noopener,noreferrer");
      if (!popup) toast("The login tab was blocked. Use the Open login page link below.", "error");
    },
    onError: (e) => { toast(e.message, "error"); setMode("pick"); },
  });

  const startCopilot = useMutation({
    mutationFn: (accountLabel: string) => reconnectAccount ? providers.copilotReconnect(reconnectAccount.id) : providers.copilotStart(p.id, accountLabel),
    onSuccess: (result) => { setCopilotAccountId(result.accountId); setMode("oauth"); setStartingCopilot(false); },
    onError: (e) => { toast(e.message, "error"); setStartingCopilot(false); },
  });

  const confirmCopilot = useMutation({
    mutationFn: () => providers.copilotStatus(copilotAccountId!),
    onSuccess: (status) => {
      if (status.duplicate) {
        setDupe({ login: status.login ?? "?", accountId: copilotAccountId! });
      } else if (status.done && status.ok) {
        copilotConnected.current = true;
        invalidate();
        onClose();
        toast(status.message || "GitHub Copilot connected");
      } else {
        toast(status.message || "Authorization is still being finalized");
      }
    },
    onError: (error) => toast(error.message, "error"),
  });

  const oauthStarted = useRef(false);
  const backFromOauth = () => {
    if (copilotAccountId && !copilotConnected.current) void providers.copilotCancel(copilotAccountId).catch(() => undefined);
    setCopilotAccountId(null);
    setDeviceCode(null);
    setOauthState(null);
    oauthStarted.current = false;
    setMode("pick");
  };

  useEffect(() => {
    if (reconnectAccount && !oauthStarted.current) {
      oauthStarted.current = true;
      setStartingCopilot(true);
      startCopilot.mutate(reconnectAccount.label);
      return;
    }
    if (mode === "oauth" && p.type !== "github-copilot" && !oauthStarted.current) {
      oauthStarted.current = true;
      startOauth.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, reconnectAccount]);

  useEffect(() => {
    if (!oauthState && !copilotAccountId) return;
    const t = setInterval(async () => {
      try {
        const s = copilotAccountId ? await providers.copilotStatus(copilotAccountId) : await providers.oauthStatus(oauthState!);
        if (copilotAccountId && s.duplicate && !overwriteRef.current) {
          clearInterval(t);
          setDupe({ login: s.login ?? "?", accountId: copilotAccountId });
          return;
        }
        if (s.done) {
          clearInterval(t);
          if (s.ok) {
            copilotConnected.current = true;
            invalidate();
            onClose();
            toast(s.message || "ChatGPT account connected");
          } else {
            toast(s.message || "Login failed", "error");
          }
        }
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthState, copilotAccountId]);

  // Poll device-code for Copilot manual login (device flow, not web-flow)
  useEffect(() => {
    if (!copilotAccountId) return;
    const t = setInterval(async () => {
      try {
        const info = await providers.copilotLoginInfo(copilotAccountId);
        if (info.code) setDeviceCode(info.code);
        if (info.done) {
          clearInterval(t);
          if (info.ok === false) toast(info.error || "GitHub Copilot login failed", "error");
        }
      } catch {
        // flow may already be finished/deleted
      }
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copilotAccountId]);

  const submitCallback = useMutation({
    mutationFn: () => providers.oauthSubmitCallback(callbackUrl.trim()),
    onSuccess: () => {
      setCallbackUrl("");
      toast("Callback received — finishing the connection…");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const addSingle = useMutation({
    mutationFn: () => providers.addAccount(p.id, { label, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined }),
    onSuccess: () => { invalidate(); onClose(); toast("Account added"); },
    onError: (e) => toast(e.message, "error"),
  });

  const bulkKeys = bulk.split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean);

  const copilotBulk = useMutation({
    mutationFn: () => providers.copilotBulk(p.id, bulk),
    onSuccess: (r) => {
      invalidate();
      onClose();
      toast(`Bulk login started for ${r.total} account(s)`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const confirmOverwrite = useMutation({
    mutationFn: (accountId: string) => providers.copilotOverwrite(accountId),
    onSuccess: () => {
      overwriteRef.current = true;
      setDupe(null);
      toast("Overwriting previous account…");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const addBulk = useMutation({
    mutationFn: () => {
      setBulkProgress(10);
      const interval = setInterval(() => {
        setBulkProgress((value) => (value < 85 ? value + Math.random() * 12 : value));
      }, 120);
      return providers.addAccountsBulk(p.id, bulkKeys).finally(() => {
        clearInterval(interval);
        setBulkProgress(100);
      });
    },
    onSuccess: (r) => {
      setTimeout(() => setBulkProgress(0), 400);
      invalidate();
      onClose();
      toast(`Added ${r.added} account${r.added === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"} skipped` : ""}`, r.added ? "success" : "error");
    },
    onError: (e) => {
      setBulkProgress(0);
      toast(e.message, "error");
    },
  });

  return (
    <Modal open onClose={close} title={reconnectAccount ? `Reconnect ${reconnectAccount.label}` : "Add account"}>
      {mode === "pick" ? (
        <div className="flex flex-col gap-2">
          <p className="mb-2 text-xs text-text-muted">{p.type === "github-copilot" ? <>Add one local Copilot sidecar for each entitled GitHub account. The sidecar must remain private to this machine or network.</> : <>How do you want to add API keys to <strong className="text-text-primary">{p.name}</strong>?</>}</p>
          {["openai", "codebuddy-global", "codebuddy-cn"].includes(p.type) && (
            <Button variant="primary" onClick={() => setMode("oauth")}>
              <ExternalLink size={14} /> Login with browser
            </Button>
          )}
          <Button variant="outline" onClick={() => { const nextLabel = p.type === "github-copilot" ? "" : `${p.name}-${accountCount + 1}`; setLabel(nextLabel); if (p.type === "github-copilot") { setStartingCopilot(true); startCopilot.mutate(nextLabel); } else setMode("single"); }} loading={startingCopilot}>
            <Plus size={14} /> {p.type === "github-copilot" ? "Login with GitHub" : "Single API key"}
          </Button>
          {p.type !== "github-copilot" && <Button variant="outline" onClick={() => setMode("bulk")}>
            <ListChecks size={14} /> Bulk API keys
          </Button>}
          {p.type === "github-copilot" && <Button variant="outline" onClick={() => setMode("bulk")}>
            <ListChecks size={14} /> Bulk Google login
          </Button>}
          <Button variant="ghost" onClick={close}>Cancel</Button>
        </div>
      ) : dupe ? (
        <div className="flex flex-col gap-3 py-2">
          <p className="text-sm">GitHub account <strong className="text-text-primary">{dupe.login}</strong> is already connected.</p>
          <p className="text-xs text-text-muted">Overwrite will remove the existing account and use the new login session instead.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>Keep existing</Button>
            <Button variant="primary" size="sm" loading={confirmOverwrite.isPending} onClick={() => confirmOverwrite.mutate(dupe.accountId)}>Overwrite</Button>
          </div>
        </div>
      ) : mode === "oauth" ? (
        <div className="space-y-5 py-1">
          <div className="flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15">
              <Loader2 size={18} className="animate-spin text-accent" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">{p.type === "github-copilot" ? "Authorize GitHub Copilot" : oauthState ? "Waiting for browser login…" : "Opening login page…"}</p>
              <p className="mt-0.5 text-xs text-text-muted">This dialog closes automatically after the account is connected.</p>
            </div>
          </div>
          {p.type === "github-copilot" ? (
            <div className="space-y-4" role="status" aria-live="polite">
              <p className="text-xs leading-5 text-text-muted">Open GitHub Device Activation in an incognito window, sign in with the correct GitHub account, then enter the code below.</p>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-base/70 p-3">
                <a href="https://github.com/login/device" target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-accent hover:text-accent/80">
                  <ExternalLink size={14} className="shrink-0" />
                  <span className="truncate">github.com/login/device</span>
                </a>
                <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2.5" onClick={() => { navigator.clipboard.writeText("https://github.com/login/device"); toast("Link copied"); }}>
                  <Copy size={13} /> Copy link
                </Button>
              </div>
              {deviceCode ? (
                <div className="rounded-xl border border-accent/25 bg-bg-base px-5 py-4 text-center shadow-inner">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Device code</div>
                  <div className="mt-2 select-all font-mono text-2xl font-bold tracking-[0.2em] text-text-primary sm:text-3xl">{deviceCode}</div>
                  <Button type="button" variant="outline" size="sm" className="mt-4 h-8" onClick={() => { navigator.clipboard.writeText(deviceCode); toast("Code copied"); }}>
                    <Copy size={13} /> Copy code
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-base px-4 py-5 text-xs text-text-muted">
                  <Loader2 size={14} className="animate-spin" /> Preparing device code…
                </div>
              )}
            </div>
          ) : (
            <p className="max-w-xs text-xs text-text-muted">Complete the sign-in in the browser tab that just opened. This dialog closes automatically when the account is connected.</p>
          )}
          {oauthUrl && p.type !== "github-copilot" && <a href={oauthUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline underline-offset-2">Open login page</a>}
          {p.type === "openai" && (
            <div className="w-full space-y-2 text-left">
              <label className="block text-xs font-medium text-text-primary">Paste callback URL (VPS / remote dashboard)</label>
              <p className="text-[11px] leading-relaxed text-text-muted">After login, your browser opens or fails at <code>localhost:1455</code>. Copy the complete URL from its address bar and paste it here.</p>
              <Input
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                aria-label="OpenAI OAuth callback URL"
                disabled={submitCallback.isPending}
              />
              <Button className="w-full" size="sm" onClick={() => submitCallback.mutate()} loading={submitCallback.isPending} disabled={!callbackUrl.trim()}>
                Connect callback
              </Button>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" size="sm" onClick={backFromOauth}>Back</Button>
            {p.type === "github-copilot" && copilotAccountId && (
                <Button variant="primary" size="sm" loading={confirmCopilot.isPending} onClick={() => confirmCopilot.mutate()}><Check size={14} /> I've authorized</Button>
            )}
            </div>
          </div>
        </div>
      ) : mode === "single" ? (
        <form onSubmit={(e) => { e.preventDefault(); addSingle.mutate(); }} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Label</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${p.name}-${accountCount + 1}`} required autoFocus />
          </div>
          {p.type === "github-copilot" && <div>
            <label className="mb-1 block text-xs text-text-muted">Sidecar base URL</label>
            <Input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:4141/v1" required />
          </div>}
          <div className="relative">
            <label className="mb-1 block text-xs text-text-muted">{p.type === "github-copilot" ? "Sidecar API key (optional)" : "API key"}</label>
            <Input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={p.type === "github-copilot" ? "Optional Bearer token" : "sk-..."} required={p.type !== "github-copilot"} className="pr-9" />
            <button type="button" onClick={() => setShowKey(!showKey)} className="absolute bottom-2.5 right-2.5 text-text-muted" aria-label="Toggle key visibility">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode("pick")}>Back</Button>
            <Button type="submit" size="sm" loading={addSingle.isPending} disabled={!label.trim() || (p.type === "github-copilot" ? !baseUrl.trim() : !apiKey.trim())}>Add account</Button>
          </div>
        </form>
      ) : p.type === "github-copilot" ? (
        <form onSubmit={(e) => { e.preventDefault(); copilotBulk.mutate(); }} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Google Workspace accounts — email|password per line ({bulk.split(/\n/).filter(Boolean).length} detected)</label>
            <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"user1@domain.com|password1\nuser2@domain.com|password2"} rows={8} autoFocus disabled={copilotBulk.isPending} className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none disabled:opacity-50" />
          </div>
          <p className="text-[11px] text-text-muted">The Camoufox browser signs in to each Google Workspace account automatically. A browser window appears for every login.</p>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode("pick")} disabled={copilotBulk.isPending}>Back</Button>
            <Button type="submit" size="sm" loading={copilotBulk.isPending} disabled={bulk.trim().split(/\n/).filter(Boolean).length === 0}>Start bulk login</Button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); addBulk.mutate(); }} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">API keys — one per line ({bulkKeys.length} detected)</label>
            <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"sk-aaaa...\nsk-bbbb...\nsk-cccc..."} rows={8} autoFocus disabled={addBulk.isPending} className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none disabled:opacity-50" />
          </div>
          {bulkProgress > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">Importing {bulkKeys.length} key{bulkKeys.length === 1 ? "" : "s"}…</span>
                <span className="text-text-muted">{Math.round(bulkProgress)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-bg-muted">
                <div className="h-full rounded-full bg-accent transition-all duration-200 ease-out" style={{ width: `${bulkProgress}%` }} />
              </div>
            </div>
          )}
          <p className="text-[11px] text-text-muted">Labels are auto-generated ({p.name}-{accountCount + 1}, {p.name}-{accountCount + 2}, …). Duplicates and keys already added are skipped.</p>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode("pick")} disabled={addBulk.isPending}>Back</Button>
            <Button type="submit" size="sm" loading={addBulk.isPending} disabled={bulkKeys.length === 0}>Import {bulkKeys.length > 0 ? `${bulkKeys.length} key${bulkKeys.length === 1 ? "" : "s"}` : ""}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
