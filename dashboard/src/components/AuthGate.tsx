import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Lock } from "lucide-react";
import { auth } from "../api";
import { Splash } from "./Splash";
import { Button, Card, Input } from "./ui";

/**
 * Renders the login screen while a dashboard password is configured and the
 * browser has no valid session. Passwordless installs render children as-is.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["auth"], queryFn: auth.check, retry: false });
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.isLoading) return <Splash />;
  if (!state.data || !state.data.password_set || state.data.authenticated) return <>{children}</>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(password, remember);
      setPassword("");
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <div className="mb-1 flex items-center gap-2">
          <Lock size={14} className="text-accent" />
          <h1 className="text-sm font-medium">Mirais dashboard</h1>
        </div>
        <p className="mb-5 text-xs text-text-muted">Enter the dashboard password to continue. API clients using gateway keys are unaffected.</p>
        <form onSubmit={submit} className="space-y-4">
          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={password}
              autoFocus
              autoComplete="current-password"
              aria-label="Dashboard password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-2 text-text-muted hover:text-text-primary"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember this browser for 30 days
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || password.length === 0}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
