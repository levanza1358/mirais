import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Boxes,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Music,
  ScrollText,
  Settings as SettingsIcon,
  BarChart3,
  Search as SearchIcon,
} from "lucide-react";

type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: typeof SearchIcon;
  shortcut?: string;
  run: (helpers: { navigate: ReturnType<typeof useNavigate>; close: () => void }) => void;
};

const COMMANDS: Command[] = [
  { id: "nav-overview", label: "Open Overview", hint: "Dashboard", icon: LayoutDashboard, run: ({ navigate, close }) => { navigate("/dashboard"); close(); } },
  { id: "nav-chat", label: "Open Chat", icon: LayoutDashboard, run: ({ navigate, close }) => { navigate("/dashboard/chat"); close(); } },
  { id: "nav-providers", label: "Open Providers", icon: Boxes, run: ({ navigate, close }) => { navigate("/dashboard/providers"); close(); } },
  { id: "nav-combos", label: "Open Combos", icon: GitBranch, run: ({ navigate, close }) => { navigate("/dashboard/combos"); close(); } },
  { id: "nav-keys", label: "Open API Keys", icon: KeyRound, run: ({ navigate, close }) => { navigate("/dashboard/keys"); close(); } },
  { id: "nav-logs", label: "Open Logs", icon: ScrollText, run: ({ navigate, close }) => { navigate("/dashboard/logs"); close(); } },
  { id: "nav-usage", label: "Open Usage", icon: BarChart3, run: ({ navigate, close }) => { navigate("/dashboard/usage"); close(); } },
  { id: "nav-music", label: "Open Music", icon: Music, run: ({ navigate, close }) => { navigate("/dashboard/music"); close(); } },
  { id: "nav-settings", label: "Open Settings", icon: SettingsIcon, run: ({ navigate, close }) => { navigate("/dashboard/settings"); close(); } },
  { id: "nav-landing", label: "Back to landing page", icon: LayoutDashboard, run: ({ navigate, close }) => { navigate("/"); close(); } },
];

export default function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isFormField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
      if (!open) return;
      if (!isFormField && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    const onOpen = () => setOpen(true);
    window.addEventListener("mirais:command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mirais:command-palette", onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus input next tick so the modal exists.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false));
  }, [query]);

  const runCommand = (cmd: Command) => cmd.run({ navigate, close: () => setOpen(false) });

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      setActive((a) => Math.min(a + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      const cmd = filtered[active];
      if (cmd) runCommand(cmd);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh]" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close command palette" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className="relative w-[min(94vw,560px)] overflow-hidden rounded-2xl border border-border/80 bg-bg-surface/95 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
          <SearchIcon size={16} className="text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKeyDown}
            placeholder="Search pages…"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted/70 focus:outline-none"
            aria-label="Command palette search"
          />
          <kbd className="rounded-md border border-border/70 bg-bg-base/60 px-1.5 py-0.5 text-[10px] text-text-muted">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-text-muted">No matches</li>
          ) : (
            filtered.map((cmd, idx) => {
              const Icon = cmd.icon;
              const isActive = idx === active;
              return (
                <li key={cmd.id}>
                  <button
                    type="button"
                    onClick={() => runCommand(cmd)}
                    onMouseEnter={() => setActive(idx)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${isActive ? "bg-accent/15 text-text-primary" : "text-text-muted hover:bg-bg-raised/60"}`}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${isActive ? "bg-accent/25 text-accent" : "bg-bg-raised/60 text-text-muted"}`}>
                      <Icon size={14} />
                    </span>
                    <span className="flex-1 truncate text-sm">{cmd.label}</span>
                    {cmd.hint && <span className="text-[10px] text-text-muted">{cmd.hint}</span>}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border/70 px-4 py-2 text-[10px] text-text-muted">
          <span>↑↓ navigate · Enter open</span>
          <span>Mirais command palette</span>
        </div>
      </div>
    </div>
  );
}