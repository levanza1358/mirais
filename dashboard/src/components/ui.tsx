import { isValidElement, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Input as ShadcnInput } from "@/components/ui/input";
import { Badge as ShadcnBadge } from "@/components/ui/badge";
import { Card as ShadcnCard } from "@/components/ui/card";
import { Skeleton as ShadcnSkeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select as ShadcnSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch as ShadcnSwitch } from "@/components/ui/switch";

// ── Button (legacy API → shadcn) ──
export function Button({
  variant = "primary",
  size = "md",
  loading,
  className = "",
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const shadcnVariant = variant === "primary" ? "default" : variant === "danger" ? "destructive" : variant;
  const shadcnSize = size === "sm" ? "sm" : size === "lg" ? "lg" : "default";
  return (
    <ShadcnButton variant={shadcnVariant} size={shadcnSize} className={className} disabled={loading || disabled} {...props}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </ShadcnButton>
  );
}

// ── Input ──
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput className={className} {...props} />;
}

// ── Select (legacy <option> API → Radix) ──
type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } };
export function Select({
  className = "",
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  name,
  required,
  id,
  title,
  "aria-label": ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  onChange?: (event: SelectChangeEvent) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  id?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const options = (Array.isArray(children) ? children : [children]).flatMap((child) =>
    isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child) && child.type === "option"
      ? [child]
      : [],
  );
  const initial = Array.isArray(defaultValue) ? defaultValue[0] : defaultValue;
  const [internalValue, setInternalValue] = useState(String(initial ?? options[0]?.props.value ?? ""));
  const selectedValue = String((Array.isArray(value) ? value[0] : value) ?? internalValue);

  const choose = (next: string) => {
    if (value === undefined) setInternalValue(next);
    const target = { value: next };
    onChange?.({ target, currentTarget: target });
  };

  return (
    <>
      <ShadcnSelect value={selectedValue} onValueChange={choose} disabled={disabled} required={required}>
        <SelectTrigger id={id} title={title} aria-label={ariaLabel} className={`w-full ${className}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((option) => (
            <SelectItem key={String(option.props.value)} value={String(option.props.value)} disabled={option.props.disabled}>
              {option.props.children}
            </SelectItem>
          ))}
        </SelectContent>
      </ShadcnSelect>
      {name && <input type="hidden" name={name} value={selectedValue} required={required} />}
    </>
  );
}

// ── Switch ──
export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  return <ShadcnSwitch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={ariaLabel} />;
}

// ── Badge ──
export function Badge({ tone = "muted", children }: { tone?: "muted" | "success" | "warning" | "danger" | "accent"; children: ReactNode }) {
  if (tone === "muted") return <ShadcnBadge variant="secondary">{children}</ShadcnBadge>;
  if (tone === "danger") return <ShadcnBadge variant="destructive">{children}</ShadcnBadge>;
  const tones = {
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    accent: "bg-accent/15 text-accent",
  } as const;
  return <ShadcnBadge className={tones[tone]}>{children}</ShadcnBadge>;
}

// ── Card ──
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <ShadcnCard className={`gap-4 p-5 ${className}`}>{children}</ShadcnCard>;
}

// ── Modal (legacy open/onClose API → Radix Dialog) ──
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
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
  return <ShadcnSkeleton className={className} />;
}

// ── CopyButton ──
export function CopyButton({ text, className = "", disabled = false }: { text: string; className?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <button
      type="button"
      disabled={disabled}
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
          className={`pointer-events-auto overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg ${
            t.tone === "error" ? "border-destructive/35" : "border-border"
          }`}
        >
          <div className="flex items-start gap-3 px-4 py-3">
            <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
              t.tone === "error" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
            }`}>
              {t.tone === "error" ? "!" : "AI"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold uppercase tracking-[0.18em] ${t.tone === "error" ? "text-destructive" : "text-success"}`}>
                  {t.title ?? (t.tone === "error" ? "Model error" : "Model reply")}
                </span>
                <span className="text-[11px] text-text-muted">just now</span>
              </div>
              <p className={`line-clamp-5 whitespace-pre-wrap text-sm leading-5 ${t.tone === "error" ? "text-destructive" : "text-text-primary"}`}>
                {t.msg}
              </p>
            </div>
          </div>
          <div className={`h-px w-full ${t.tone === "error" ? "bg-destructive/40" : "bg-success/40"}`} />
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
