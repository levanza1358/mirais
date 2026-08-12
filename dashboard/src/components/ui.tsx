import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";

// ── Button ──
export function Button({
  variant = "primary",
  size = "md",
  loading,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none shadow-sm";
  const sizes = { sm: "h-9 px-3.5 text-xs", md: "h-10 px-4.5 text-sm", lg: "h-14 px-10 text-base" };
  const variants = {
    primary: "bg-accent text-white hover:bg-accent/85 hover:shadow-[0_10px_30px_rgba(124,92,255,0.28)]",
    ghost: "text-text-muted hover:text-text-primary hover:bg-bg-raised/80",
    danger: "bg-danger/15 text-danger hover:bg-danger/25",
    outline: "border border-border/80 bg-bg-surface/70 text-text-primary hover:bg-bg-raised/80 hover:border-accent/30",
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

// ── Input ──
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-border bg-bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted/60 focus:border-accent focus:outline-none ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-9 w-full rounded-lg border border-border bg-bg-surface px-3 text-sm text-text-primary focus:border-accent focus:outline-none ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

// ── Switch ──
export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200 disabled:opacity-40 ${checked ? "border-accent bg-accent/90" : "border-border bg-bg-raised"}`}
    >
      <span
        className={`absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`}
      />
    </button>
  );
}

// ── Badge ──
export function Badge({ tone = "muted", children }: { tone?: "muted" | "success" | "warning" | "danger" | "accent"; children: ReactNode }) {
  const tones = {
    muted: "bg-bg-raised text-text-muted",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
    accent: "bg-accent/15 text-accent",
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

// ── Card ──
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl border border-border/80 bg-bg-surface/90 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur ${className}`}>{children}</div>;
}

// ── Modal ──
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);

    // Lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the panel so keyboard users start inside the modal.
    const panel = panelRef.current;
    panel?.focus();

    // Simple focus trap: keep Tab cycling within the panel.
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel)) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
    };
    window.addEventListener("keydown", onTab);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onTab);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[200]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center px-4 py-8 sm:px-6">
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`relative my-auto w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-2xl border border-border/90 bg-bg-surface/96 p-6 shadow-[0_24px_90px_rgba(0,0,0,0.42)] backdrop-blur-xl focus:outline-none`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{title}</h2>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── ConfirmModal ──
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="mb-5 text-sm text-text-muted">{message}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>Confirm</Button>
      </div>
    </Modal>
  );
}

// ── EmptyState ──
export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {icon && <div className="text-text-muted/50">{icon}</div>}
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {hint && <p className="max-w-sm text-xs text-text-muted">{hint}</p>}
      {action}
    </div>
  );
}

// ── Skeleton ──
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-bg-raised ${className}`} />;
}

// ── CopyButton ──
export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <button
      type="button"
      className={`text-xs text-text-muted hover:text-text-primary ${className}`}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

// ── Toast (mobile-style) ──
type ToastTone = "success" | "error";
type ToastOptions = { title?: string };
type ToastFn = (msg: string, tone?: ToastTone, options?: ToastOptions) => void;
let toastHandler: ToastFn | null = null;
const toastQueue: Array<[string, ToastTone | undefined, ToastOptions | undefined]> = [];
export function setToastHandler(fn: ToastFn) {
  toastHandler = fn;
  // Flush any toasts fired before the host mounted.
  while (toastQueue.length) {
    const [m, t, o] = toastQueue.shift()!;
    fn(m, t, o);
  }
}
export function toast(msg: string, tone?: ToastTone, options?: ToastOptions) {
  if (toastHandler) toastHandler(msg, tone, options);
  else toastQueue.push([msg, tone, options]);
}

export function ToastHost() {
  const [items, setItems] = useState<Array<{ id: number; msg: string; tone: ToastTone; title?: string }>>([]);
  useEffect(() => {
    setToastHandler((msg, tone = "success", options) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs, { id, msg, tone, title: options?.title }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
    });
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-3">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto overflow-hidden rounded-2xl border shadow-2xl backdrop-blur ${
            t.tone === "error"
              ? "border-danger/35 bg-[#221214]/95 text-danger"
              : "border-accent/30 bg-[#0d1b1a]/95 text-text-primary"
          }`}
        >
          <div className="flex items-start gap-3 px-4 py-3.5">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-xs font-semibold ${
              t.tone === "error" ? "bg-danger/15 text-danger" : "bg-success/15 text-success"
            }`}>
              {t.tone === "error" ? "!" : "AI"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold uppercase tracking-[0.18em] ${t.tone === "error" ? "text-danger" : "text-success"}`}>
                  {t.title ?? (t.tone === "error" ? "Model error" : "Model reply")}
                </span>
                <span className="text-[11px] text-text-muted">just now</span>
              </div>
              <p className={`line-clamp-5 whitespace-pre-wrap text-sm leading-5 ${t.tone === "error" ? "text-danger" : "text-text-primary"}`}>
                {t.msg}
              </p>
            </div>
          </div>
          <div className={`h-1 w-full ${t.tone === "error" ? "bg-danger/40" : "bg-success/40"}`} />
        </div>
      ))}
    </div>
  );
}

// ── formatters ──
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
