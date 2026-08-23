import { type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Boxes,
  GitBranch,
  KeyRound,
  ScrollText,
  BarChart3,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Music,
  Menu,
  MessageSquare,
  X,
} from "lucide-react";
import { health } from "../api";
import { APP_BUILD } from "../main";

type NavGroup = {
  id: string;
  label: string;
  items: Array<{ to: string; label: string; icon: typeof LayoutDashboard; end?: boolean }>;
};

const GROUPS: NavGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    items: [
      { to: "/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/dashboard/chat", label: "Chat", icon: MessageSquare },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    items: [
      { to: "/dashboard/providers", label: "Providers", icon: Boxes },
      { to: "/dashboard/combos", label: "Combos", icon: GitBranch },
      { to: "/dashboard/keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
      { to: "/dashboard/usage", label: "Usage", icon: BarChart3 },

      { to: "/dashboard/music", label: "Music", icon: Music },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { to: "/dashboard/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const MOBILE_NAV: Array<{ to: string; label: string; icon: typeof LayoutDashboard; end?: boolean }> = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { to: "/dashboard/providers", label: "Providers", icon: Boxes },
  { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { to: "/dashboard/settings", label: "Settings", icon: SettingsIcon },
];

const DEFAULT_OPEN_GROUPS = new Set<string>(["dashboard", "infrastructure", "operations", "system"]);

export function Layout({ children }: { children: ReactNode }) {
  const { data: h } = useQuery({
    queryKey: ["health"],
    queryFn: health,
    refetchInterval: 10_000,
    retry: false,
  });
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(DEFAULT_OPEN_GROUPS);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Auto-collapse the sidebar below the sm breakpoint, and turn it into an
  // overlay drawer on mobile so the content can use the full width.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      setIsMobile(mq.matches);
      if (mq.matches) {
        setCollapsed(false);
        setMobileOpen(false);
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const online = h?.status === "ok";

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const effectiveCollapsed = isMobile ? false : collapsed;
  const sidebarHidden = isMobile && !mobileOpen;

  return (
    <div className="block min-h-screen md:flex md:h-screen bg-bg-base text-text-primary">
      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      )}
      {/* Mobile menu trigger — compact pill on top-left that opens the full sidebar drawer */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-30 flex h-9 items-center gap-2 rounded-lg border border-border bg-bg-surface px-2.5 text-xs text-text-muted hover:text-text-primary md:hidden"
        aria-label="Open full menu"
        title="Open full menu"
      >
        <Menu size={15} />
        <span className="hidden xs:inline">Menu</span>
      </button>

      {/* sidebar */}
      <aside
        aria-hidden={sidebarHidden}
        className={`group/sidebar flex shrink-0 flex-col border-r border-border bg-bg-surface transition-[width,transform] duration-300 ease-out md:relative md:translate-x-0 ${effectiveCollapsed ? "md:w-[60px]" : "md:w-[240px]"} ${isMobile ? "fixed inset-y-0 left-0 z-50 w-[240px]" : ""} ${isMobile && mobileOpen ? "translate-x-0" : isMobile ? "-translate-x-[120%]" : ""} md:translate-x-0 ${sidebarHidden ? "md:flex" : ""}`}
      >
        <div className={`flex items-center gap-2.5 border-b border-border/70 px-3 py-3 ${effectiveCollapsed ? "justify-center" : ""}`}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            <img src="/icon.png" alt="Mirais" className="size-6 rounded-md" />
          </div>
          {!effectiveCollapsed && (
            <div className="min-w-0 flex-1 anim-fade-in">
              <p className="truncate text-sm font-semibold tracking-tight">Mirais</p>
            </div>
          )}
          {!effectiveCollapsed && !isMobile && (
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose size={15} />
            </button>
          )}
          {isMobile && mobileOpen && (
            <button
              onClick={() => setMobileOpen(false)}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary"
              title="Close menu"
              aria-label="Close menu"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Expand handle when collapsed (desktop only) */}
        {collapsed && !isMobile && (
          <button
            onClick={() => setCollapsed(false)}
            className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border/80 bg-bg-surface text-text-muted shadow-md transition-colors hover:bg-bg-raised hover:text-text-primary"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen size={13} />
          </button>
        )}

        {/* Nav */}
        <nav className={`flex-1 overflow-y-auto py-2 ${effectiveCollapsed ? "px-1.5" : "px-2.5"}`}>
          {GROUPS.map((group) => {
            const isOpen = effectiveCollapsed ? true : openGroups.has(group.id);
            return (
              <div key={group.id} className="mb-1.5">
                {!effectiveCollapsed && (
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex w-full items-center gap-2 px-2 pb-1 pt-0.5 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted/80 transition-colors hover:text-text-muted"
                    aria-expanded={isOpen}
                  >
                    <span className="flex-1">{group.label}</span>
                    <ChevronDown
                      size={12}
                      className={`transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                  </button>
                )}
                {isOpen && (
                  <ul className="space-y-px">
                    {group.items.map(({ to, label, icon: Icon, end }) => (
                      <li key={to}>
                        <NavLink
                          to={to}
                          end={end}
                          onClick={() => isMobile && setMobileOpen(false)}
                          title={effectiveCollapsed ? label : undefined}
                          className={({ isActive }) =>
                            `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-all duration-200 ${
                              isActive
                                ? "bg-bg-raised text-text-primary"
                                : "text-text-muted hover:translate-x-0.5 hover:bg-bg-raised/50 hover:text-text-primary"
                            } ${effectiveCollapsed ? "justify-center" : ""}`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span
                                className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-200 ${
                                  isActive
                                    ? "bg-accent/15 text-accent"
                                    : "text-text-muted group-hover:text-accent"
                                }`}
                              >
                                <Icon size={14} strokeWidth={1.75} />
                              </span>
                              {!effectiveCollapsed && <span className="truncate">{label}</span>}
                            </>
                          )}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className={`border-t border-border/70 p-2 ${effectiveCollapsed ? "px-1.5" : ""}`}>
          <div
            className={`mb-1.5 flex items-center gap-2 rounded-lg border border-border/70 bg-bg-base/60 px-2.5 py-1.5 text-[11px] ${effectiveCollapsed ? "justify-center px-1.5" : ""}`}
            title={online ? "Server online" : "Server offline"}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {online && <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-65 anim-pulse-soft" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${online ? "bg-success" : "bg-danger"}`} />
            </span>
            {!effectiveCollapsed && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className={online ? "text-success" : "text-text-muted"}>
                  {online ? "online" : "offline"}
                </span>
                {h?.uptime_s !== undefined && (
                  <span className="ml-auto text-text-muted">{formatUptime(h.uptime_s)}</span>
                )}
              </div>
            )}
          </div>
          {!effectiveCollapsed && (
            <p className="px-1 pb-0.5 text-[10px] text-text-muted/70" title={`Build ${APP_BUILD.time}`}>
              v{APP_BUILD.version} · {APP_BUILD.stamp}
            </p>
          )}
        </div>
      </aside>

        {/* main — `min-h-0 overflow-hidden` lets individual pages (e.g. Playground)
          fill the viewport and own their own scroll region without the main
          scrollbar fighting them. On mobile, the top padding keeps content
          clear of the fixed menu trigger and the bottom padding clears bottom
          navigation. */}
      <main className="flex min-h-screen min-w-0 w-full flex-1 overflow-hidden pt-14 pb-20 md:h-screen md:min-h-0 md:pt-0 md:pb-0">
        {/* key=pathname forces the page-enter animation to re-run on every
            route change. CSS animations only fire on mount. */}
        <div key={useLocation().pathname} className="page-enter min-h-0 w-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden p-3 md:p-6">
          {children}
        </div>
      </main>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch justify-around border-t border-border bg-bg-surface px-2 md:hidden"
      >
        {MOBILE_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1.5 py-1.5 text-[10px] transition-colors ${
                isActive ? "text-accent" : "text-text-muted hover:text-text-primary"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  strokeWidth={isActive ? 2 : 1.75}
                />
                <span className="truncate">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 anim-fade-in-down md:mb-8">
      <div className="min-w-0">
        <p className="mb-1 text-[10px] uppercase tracking-[0.24em] text-text-muted md:text-xs">Mirais dashboard</p>
        <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}