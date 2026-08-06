import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, Eye, EyeOff } from "lucide-react";
import { auth, settings, ApiError } from "../api";
import { Button, Input } from "../components/ui";

export default function Login() {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    // Pre-check the box when the admin enabled it as default in Settings.
    settings.get().then((s) => setRemember(!!s.session_remember_default)).catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await auth.login(password, remember);
      await qc.invalidateQueries({ queryKey: ["auth-check"] });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_#1a2030_0%,_#0b0e14_60%)]">
      <form
        onSubmit={submit}
        className={`w-full max-w-sm rounded-2xl border border-border bg-bg-surface/80 p-8 backdrop-blur ${shake ? "animate-[shake_0.4s]" : ""}`}
        style={{ animationName: shake ? "shake" : undefined }}
      >
        <style>{`@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }`}</style>
        <div className="mb-6 flex flex-col items-center gap-2">
          <Sparkles size={28} className="text-accent" />
          <h1 className="text-lg font-semibold">Mirais</h1>
          <p className="text-xs text-text-muted">Sign in to your gateway dashboard</p>
        </div>
        <div className="relative mb-4">
          <Input
            type={show ? "text" : "password"}
            placeholder="Dashboard password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <label className="mb-4 flex cursor-pointer items-center gap-2 text-xs text-text-muted select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          Never ask password on this device (30 days)
        </label>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        <Button type="submit" className="w-full" loading={loading} disabled={!password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
