import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Eye, EyeOff, ListChecks, Loader2, Plus } from "lucide-react";
import { type Provider, providers } from "../../api";
import { Button, Input, Modal, toast } from "../../components/ui";

export function AddAccountModal({ provider: p, accountCount, onClose }: { provider: Provider; accountCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"pick" | "single" | "bulk" | "oauth">("pick");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [bulk, setBulk] = useState("");
  const [bulkProgress, setBulkProgress] = useState(0);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["providers"] });
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

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

  const oauthStarted = useRef(false);
  useEffect(() => {
    if (mode === "oauth" && !oauthStarted.current) {
      oauthStarted.current = true;
      startOauth.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!oauthState) return;
    const t = setInterval(async () => {
      try {
        const s = await providers.oauthStatus(oauthState);
        if (s.done) {
          clearInterval(t);
          if (s.ok) {
            invalidate();
            onClose();
            toast(s.message || "ChatGPT account connected");
          } else {
            toast(s.message || "Login failed", "error");
            setOauthState(null);
            setMode("pick");
          }
        }
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthState]);

  const addSingle = useMutation({
    mutationFn: () => providers.addAccount(p.id, { label, apiKey }),
    onSuccess: () => { invalidate(); onClose(); toast("Account added"); },
    onError: (e) => toast(e.message, "error"),
  });

  const bulkKeys = bulk.split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean);

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
    <Modal open onClose={onClose} title="Add account">
      {mode === "pick" ? (
        <div className="flex flex-col gap-2">
          <p className="mb-2 text-xs text-text-muted">How do you want to add API keys to <strong className="text-text-primary">{p.name}</strong>?</p>
          {["openai", "codebuddy-global", "codebuddy-cn"].includes(p.type) && (
            <Button variant="primary" onClick={() => setMode("oauth")}>
              <ExternalLink size={14} /> Login with browser
            </Button>
          )}
          <Button variant="outline" onClick={() => { setMode("single"); setLabel(`${p.name}-${accountCount + 1}`); }}>
            <Plus size={14} /> Single API key
          </Button>
          <Button variant="outline" onClick={() => setMode("bulk")}>
            <ListChecks size={14} /> Bulk API keys
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      ) : mode === "oauth" ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <Loader2 size={22} className="animate-spin text-accent" />
          <p className="text-sm font-medium">{oauthState ? "Waiting for browser login…" : "Opening login page…"}</p>
          <p className="max-w-xs text-xs text-text-muted">Complete the sign-in in the browser tab that just opened. This dialog closes automatically when the account is connected.</p>
          {oauthUrl && <a href={oauthUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline underline-offset-2">Open login page</a>}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setOauthState(null); oauthStarted.current = false; setMode("pick"); }}>Back</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : mode === "single" ? (
        <form onSubmit={(e) => { e.preventDefault(); addSingle.mutate(); }} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Label</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${p.name}-${accountCount + 1}`} required autoFocus />
          </div>
          <div className="relative">
            <label className="mb-1 block text-xs text-text-muted">API key</label>
            <Input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." required className="pr-9" />
            <button type="button" onClick={() => setShowKey(!showKey)} className="absolute bottom-2.5 right-2.5 text-text-muted" aria-label="Toggle key visibility">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode("pick")}>Back</Button>
            <Button type="submit" size="sm" loading={addSingle.isPending} disabled={!label.trim() || !apiKey.trim()}>Add account</Button>
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
