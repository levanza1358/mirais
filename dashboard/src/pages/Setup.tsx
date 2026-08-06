import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { auth, ApiError } from "../api";
import { Button, Input } from "../components/ui";

export default function Setup() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords do not match");
    setLoading(true);
    try {
      await auth.setup(password); // sets session cookie server-side
      await qc.invalidateQueries({ queryKey: ["auth-check"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_#1a2030_0%,_#0b0e14_60%)]">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface/80 p-8 backdrop-blur">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Sparkles size={28} className="text-accent" />
          <h1 className="text-lg font-semibold">Welcome to Mirais</h1>
          <p className="text-center text-xs text-text-muted">Set a dashboard password to get started. This protects your gateway admin UI.</p>
        </div>
        <div className="mb-3 space-y-3">
          <Input type="password" placeholder="New password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <Input type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <Button type="submit" className="w-full" loading={loading} disabled={!password || !confirm}>
          Create password
        </Button>
      </form>
    </div>
  );
}
