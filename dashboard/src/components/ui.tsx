import { Children, isValidElement, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, useEffect, useRef, useState } from "react";
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
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
}) {
  const shadcnVariant = variant === "primary" ? "default" : variant === "danger" ? "destructive" : variant;
  const shadcnSize = size === "sm" ? "sm" : size === "lg" ? "lg" : "default";
  const iconClass = size === "icon" ? "h-9 w-9 p-0" : "";
  return (
    <ShadcnButton variant={shadcnVariant} size={shadcnSize} className={`${iconClass} ${className}`} disabled={loading || disabled} {...props}>
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
  const options = Children.toArray(children).flatMap((child) =>
    isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child) && child.type === "option"
      ? [child]
      : [],
  );
  const placeholder = options.find((option) => String(option.props.value ?? "") === "")?.props.children;
  const choices = options.filter((option) => String(option.props.value ?? "") !== "");
  const initial = Array.isArray(defaultValue) ? defaultValue[0] : defaultValue;
  const [internalValue, setInternalValue] = useState(String(initial ?? ""));
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
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper">
          {choices.map((option) => (
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

/**
 * Lightweight range slider with a numeric readout. Used by the chat
 * playground for temperature / top_p / max_tokens so we don't pull in a
 * dedicated slider library for two inputs.
 */
export function Slider({ value, min, max, step = 1, onChange, label }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      {label && (
        <span className="flex items-center justify-between">
          <span>{label}</span>
          <span className="font-mono tabular-nums text-[10px] text-text-primary">{value}</span>
        </span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
    </label>
  );
}

// ── Badge ──
export function Badge({ tone = "muted", title, children }: { tone?: "muted" | "success" | "warning" | "danger" | "accent"; title?: string; children: ReactNode }) {
  if (tone === "muted") return <ShadcnBadge variant="secondary" title={title}>{children}</ShadcnBadge>;
  if (tone === "danger") return <ShadcnBadge variant="destructive" title={title}>{children}</ShadcnBadge>;
  const tones = {
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    accent: "bg-accent/15 text-accent",
  } as const;
  return <ShadcnBadge className={tones[tone]} title={title}>{children}</ShadcnBadge>;
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
type ProgressFn = (id: string, progress: number, label?: string) => void;
type DismissProgressFn = (id: string) => void;
let toastHandler: ToastFn | null = null;
let progressHandler: ProgressFn | null = null;
let dismissProgressHandler: DismissProgressFn | null = null;
const toastQueue: Array<[string, ToastTone | undefined, ToastOptions | undefined]> = [];
export function setToastHandler(fn: ToastFn) {
  toastHandler = fn;
  // Flush any toasts fired before the host mounted.
  while (toastQueue.length) {
    const [m, t, o] = toastQueue.shift()!;
    fn(m, t, o);
  }
}
export function setProgressHandler(fn: ProgressFn, dismiss: DismissProgressFn) {
  progressHandler = fn;
  dismissProgressHandler = dismiss;
}
export function toast(msg: string, tone?: ToastTone, options?: ToastOptions) {
  if (toastHandler) toastHandler(msg, tone, options);
  else toastQueue.push([msg, tone, options]);
}
/** Show or update a sticky progress notification (0–100). */
export function uploadProgress(id: string, progress: number, label?: string) {
  progressHandler?.(id, Math.max(0, Math.min(100, Math.round(progress))), label);
}
export function dismissProgress(id: string) {
  dismissProgressHandler?.(id);
}

export function ToastHost() {
  const [items, setItems] = useState<Array<{ id: number; msg: string; tone: ToastTone; title?: string }>>([]);
  const [progress, setProgress] = useState<Record<string, { progress: number; label: string }>>({});
  useEffect(() => {
    setToastHandler((msg, tone = "success", options) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs, { id, msg, tone, title: options?.title }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
    });
    setProgressHandler(
      (id, pct, label) => setProgress((p) => ({ ...p, [id]: { progress: pct, label: label ?? p[id]?.label ?? "Uploading…" } })),
      (id) => setProgress((p) => { const { [id]: _drop, ...rest } = p; return rest; }),
    );
  }, []);
  const progressEntries = Object.entries(progress);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-3">
      {progressEntries.map(([id, p]) => (
        <div key={id} className="pointer-events-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="px-4 pt-3 pb-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Upload backup</span>
              <span className="font-mono text-[11px] text-text-muted">{p.progress}%</span>
            </div>
            <p className="mb-2 truncate text-xs text-text-muted">{p.label}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-raised" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.progress}>
              <div className="h-full rounded-full bg-accent transition-all duration-200" style={{ width: `${p.progress}%` }} />
            </div>
          </div>
        </div>
      ))}
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
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  // Tiers up to T so a huge count never renders as a 12-digit "…M".
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
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

/* ────────────────────────────────────────────────────────────────────────
 * Inline Markdown renderer
 *
 * No external dep. Covers the subset the chat playground needs:
 *   - code fences with language hint
 *   - tables (| ... | ... |)
 *   - headings, ordered/unordered lists, blockquotes
 *   - **bold**, *italic*, ~~strike~~, `inline code`
 *   - links and images
 * Inline HTML is escaped. Unknown content falls back to plain text.
 * ──────────────────────────────────────────────────────────────────────── */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineMarkdown(text: string): string {
  let escaped = escapeHtml(text);
  // Stash inline-code content into placeholders so the bold/italic regex
  // doesn't reach inside backticks.
  const codeStash: string[] = [];
  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeStash.length;
    codeStash.push(code);
    return `\u0001CODE${idx}\u0001`;
  });
  // Images must come before links because both use `[]()` syntax.
  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, alt, src, title) =>
    `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ""} class="my-1 max-w-full rounded-lg border border-border/60" />`,
  );
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    `<a href="${href}" target="_blank" rel="noopener" class="text-accent underline">${label}</a>`,
  );
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  escaped = escaped.replace(/(^|[^_])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
  escaped = escaped.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Restore inline code. The surrounding `**` that should have wrapped the
  // placeholder are still in the string but were already replaced by the
  // bold/italic passes, so we re-add the `<code>` element here.
  escaped = escaped.replace(/\u0001CODE(\d+)\u0001/g, (_, idx) => {
    const code = codeStash[Number(idx)] ?? "";
    return `<code class="rounded bg-bg-raised px-1 py-0.5 font-mono text-[12px]">${code}</code>`;
  });
  return escaped;
}

function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    out.push(`<p class="my-2 leading-6">${inlineMarkdown(buf.join(" "))}</p>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // skip closing fence
      out.push(`<pre class="my-2 overflow-x-auto rounded-lg border border-border/60 bg-bg-base px-3 py-2 text-[12px]"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const sizeClass = ["text-2xl", "text-xl", "text-lg", "text-base", "text-base", "text-sm"][Math.min(level - 1, 5)];
      out.push(`<h${level} class="${sizeClass} mb-1 mt-3 font-semibold">${inlineMarkdown(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    // Table — header row + separator + body rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1] ?? "")) {
      const headerCells = (line.match(/\|([^|]*)/g) ?? []).map((c) => c.replace(/^\|/, "").trim()).filter((c) => c.length > 0);
      i += 2; // skip header + separator
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        const row = (lines[i]!.match(/\|([^|]*)/g) ?? []).map((c) => c.replace(/^\|/, "").trim());
        body.push(row);
        i += 1;
      }
      const head = `<thead><tr>${headerCells.map((c) => `<th class="border border-border/60 bg-bg-raised px-2 py-1 text-left text-xs font-medium">${inlineMarkdown(c)}</th>`).join("")}</tr></thead>`;
      const rows = body
        .filter((r) => r.some((c) => c.length > 0))
        .map((r) => `<tr>${r.map((c) => `<td class="border border-border/60 px-2 py-1 text-xs">${inlineMarkdown(c)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table class="my-2 w-full border-collapse text-xs">${head}<tbody>${rows}</tbody></table>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="my-2 border-l-2 border-accent/60 pl-3 text-text-muted">${inlineMarkdown(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push(`<ul class="my-2 list-disc pl-5">${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol class="my-2 list-decimal pl-5">${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join("")}</ol>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*---+/.test(line)) {
      out.push(`<hr class="my-3 border-border/60" />`);
      i += 1;
      continue;
    }

    // Blank line ends a paragraph
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Otherwise accumulate a paragraph until the next blank / block delimiter.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(```|#|\s*\||\s*[-*+]\s+|\s*\d+\.\s+|>\s?|\s*---+)/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    flushParagraph(para);
  }

  return out.join("\n");
}

/**
 * Render a string of Markdown as HTML inside a sandboxed span. Strips any
 * remaining tags it doesn't recognise. Used by the chat playground for
 * assistant messages — fully covers tables, code blocks, lists, headings,
 * bold/italic/strike, links, images.
 */
export function Markdown({ content }: { content: string }) {
  return <span className="markdown-body block w-full" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
