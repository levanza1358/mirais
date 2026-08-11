import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, ExternalLink, Loader2, Play, Smartphone, XCircle } from "lucide-react";
import { type Provider, providers } from "../../api";
import { Modal, toast } from "../../components/ui";

type FarmCheck = Awaited<ReturnType<typeof providers.xaiFarmCheck>>;
type FarmResult = Awaited<ReturnType<typeof providers.xaiFarm>>;

export function XaiFarmCard({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const queryClient = useQueryClient();

  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [farmResult, setFarmResult] = useState<FarmResult | null>(null);
  const [showFarmSetup, setShowFarmSetup] = useState(false);
  const [farmCheck, setFarmCheck] = useState<FarmCheck | null>(null);
  const [farmCount, setFarmCount] = useState(1);
  const [farmConcurrency, setFarmConcurrency] = useState(1);

  const deviceCodeMut = useMutation({
    mutationFn: () => providers.xaiDeviceCode(),
    onSuccess: (data) => {
      setDeviceCode(data.deviceCode);
      setUserCode(data.userCode);
      toast("Device code created. Please authorize in your browser.");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const pollMut = useMutation({
    mutationFn: () => {
      if (!deviceCode) throw new Error("No device code");
      return providers.xaiPollToken(deviceCode, provider.id);
    },
    onSuccess: () => {
      toast("Account authenticated successfully!", "success");
      setDeviceCode(null);
      setUserCode(null);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    },
    onError: (e) => toast(e.message, "error"),
  });

  const farmCheckMut = useMutation({
    mutationFn: () => providers.xaiFarmCheck(),
    onSuccess: (result) => setFarmCheck(result),
    onError: (e) => toast(e.message, "error"),
  });

  const installBrowserMut = useMutation({
    mutationFn: () => providers.xaiFarmInstallBrowser(),
    onSuccess: () => {
      toast("Camoufox browser installed", "success");
      farmCheckMut.mutate();
    },
    onError: (e) => toast(e.message, "error"),
  });

  const farmMut = useMutation({
    mutationFn: () => providers.xaiFarm(provider.id, farmCount, farmConcurrency),
    onSuccess: (result) => {
      setFarmResult(result);
      setShowFarmSetup(false);
      toast(`Farm finished: ${result.succeeded} succeeded, ${result.failed} failed`, result.failed ? "error" : "success");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e) => toast(e.message, "error"),
  });

  const openFarmSetup = () => {
    setShowFarmSetup(true);
    setFarmCheck(null);
    farmCheckMut.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-blue-500" />
          <h3 className="text-sm font-medium">Manual OAuth (Device Code)</h3>
        </div>
        {!deviceCode ? (
          <button
            onClick={() => deviceCodeMut.mutate()}
            disabled={deviceCodeMut.isPending}
            className="flex items-center gap-2 rounded-md bg-blue-500/10 text-blue-500 border border-blue-500/20 px-3 py-1.5 text-xs font-medium hover:bg-blue-500/20 transition-colors disabled:opacity-50"
          >
            {deviceCodeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {deviceCodeMut.isPending ? "Creating..." : "Start Device Flow"}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="p-3 bg-muted rounded-md">
              <div className="text-xs text-muted-foreground mb-1">User Code:</div>
              <div className="font-mono text-lg font-bold tracking-wider">{userCode}</div>
            </div>
            <a
              href="https://x.ai/auth/device"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-500 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open x.ai/auth/device
            </a>
            <button
              onClick={() => pollMut.mutate()}
              disabled={pollMut.isPending}
              className="flex items-center gap-2 rounded-md bg-blue-500 text-white px-3 py-1.5 text-xs font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              {pollMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {pollMut.isPending ? "Checking..." : "I've authorized — Check"}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Bot className="h-4 w-4 text-orange-500" />
          <h3 className="text-sm font-medium">Farm New Account</h3>
        </div>
        <button
          onClick={openFarmSetup}
          disabled={farmMut.isPending || farmCheckMut.isPending}
          className="flex items-center gap-2 rounded-md bg-orange-500/10 text-orange-500 border border-orange-500/20 px-3 py-1.5 text-xs font-medium hover:bg-orange-500/20 transition-colors disabled:opacity-50"
        >
          {farmCheckMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
          {farmCheckMut.isPending ? "Checking..." : "Farm New Account"}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">Check requirements, choose batch size and concurrency, then start farming.</p>
      </div>

      <Modal open={showFarmSetup} onClose={() => setShowFarmSetup(false)} title="Farm Setup" width="max-w-xl">
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium">Requirements</div>
            {farmCheckMut.isPending ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking requirements...</div>
            ) : farmCheck ? (
              <div className="space-y-2">
                {farmCheck.checks.map((check) => (
                  <div key={check.key} className="flex items-start gap-3 rounded-lg border border-border p-3">
                    {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{check.label}</div>
                      <div className="text-xs text-muted-foreground">{check.detail}</div>
                    </div>
                    {!check.ok && check.key === "browser" && (
                      <button onClick={() => installBrowserMut.mutate()} disabled={installBrowserMut.isPending} className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                        {installBrowserMut.isPending ? "Installing..." : "Install"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : <div className="py-3 text-sm text-muted-foreground">Failed to load requirements.</div>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">How many accounts?</span>
              <input type="number" min={1} max={50} value={farmCount} onChange={(e) => setFarmCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Concurrent workers</span>
              <input type="number" min={1} max={10} value={farmConcurrency} onChange={(e) => setFarmConcurrency(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button onClick={() => setShowFarmSetup(false)} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">Close</button>
            <button onClick={() => farmMut.mutate()} disabled={!farmCheck?.ok || farmMut.isPending} className="flex items-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50">
              {farmMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {farmMut.isPending ? `Farming ${farmCount} accounts...` : "Start"}
            </button>
          </div>
        </div>
      </Modal>

      {farmResult && (
        <div className="p-4 bg-green-500/5 border border-green-500/20 rounded-lg">
          <h4 className="text-sm font-medium text-green-500 mb-2">Farm Result</h4>
          <div className="space-y-1 text-xs font-mono">
            <div><span className="text-muted-foreground">Requested:</span> {farmResult.requested}</div>
            <div><span className="text-muted-foreground">Succeeded:</span> {farmResult.succeeded}</div>
            <div><span className="text-muted-foreground">Failed:</span> {farmResult.failed}</div>
          </div>
          {farmResult.accounts.length > 0 && <div className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded border border-border p-2 text-xs font-mono">{farmResult.accounts.map((account) => <div key={account.accountId}>{account.email}</div>)}</div>}
          {farmResult.errors.length > 0 && <div className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{farmResult.errors.map((error, index) => <div key={`${index}-${error}`}>{error}</div>)}</div>}
          <p className="text-xs text-muted-foreground mt-2">Successful accounts have been added to the provider.</p>
        </div>
      )}
    </div>
  );
}
