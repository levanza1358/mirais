import { type ReactNode, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Boxes,
  GitBranch,
  KeyRound,
  ScrollText,
  BarChart3,
  Settings as SettingsIcon,
  LogOut,
  Plug,
  Globe2,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  FlaskConical,
} from "lucide-react";
import { auth, health } from "../api";
import { APP_BUILD } from "../main";
import miraisLogo from "../assets/mirais-logo.svg";

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
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/playground", label: "Playground", icon: FlaskConical },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    items: [
      { to: "/providers", label: "Providers", icon: Boxes },
      { to: "/proxies", label: "Proxy Pool", icon: Globe2 },
      { to: "/combos", label: "Combos", icon: GitBranch },
      { to: "/keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { to: "/logs", label: "Logs", icon: ScrollText },
      { to: "/usage", label: "Usage", icon: BarChart3 },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { to: "/integrations", label: "Integrations", icon: Plug },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const DEFAULT_OPEN_GROUPS = new Set<string>(["dashboard", "infrastructure", "operations", "system"]);

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: h } = useQuery({
    queryKey: ["health"],
    queryFn: health,
    refetchInterval: 10_000,
    retry: false,
  });
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(DEFAULT_OPEN_GROUPS);

  const online = h?.status === "ok";

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-screen bg-[radial-gradient(circle_at_top,#1a2030_0%,#0b0e14_45%,#090c12_100%)] text-text-primary">
      {/* sidebar */}
      <aside
        className={`group/sidebar relative m-3 flex shrink-0 flex-col rounded-3xl border border-border/80 bg-bg-surface/90 shadow-[0_18px_44px_rgba(0,0,0,0.32)] backdrop-blur-xl transition-[width] duration-300 ease-out ${collapsed ? "w-[76px]" : "w-[260px]"}`}
      >
        {/* Header */}
        <div className={`flex items-center gap-3 border-b border-border/70 px-4 py-4 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent shadow-inner shadow-accent/15">
            <img src={miraisLogo} alt="Mirais" className="size-5" />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1 anim-fade-in">
              <p className="truncate text-sm font-semibold tracking-tight">Mirais</p>
              <p className="text-[11px] text-text-muted" title={`Build ${APP_BUILD.time}`}>
                v{APP_BUILD.version} · {APP_BUILD.stamp}
              </p>
            </div>
          )}
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose size={15} />
            </button>
          )}
        </div>

        {/* Expand handle when collapsed */}
        {collapsed && (
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
        <nav className={`flex-1 overflow-y-auto py-3 ${collapsed ? "px-2" : "px-3"}`}>
          {GROUPS.map((group) => {
            const isOpen = collapsed ? true : openGroups.has(group.id);
            return (
              <div key={group.id} className="mb-2">
                {!collapsed && (
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex w-full items-center gap-2 px-2 pb-1.5 pt-1 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted/80 transition-colors hover:text-text-muted"
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
                  <ul className="space-y-0.5">
                    {group.items.map(({ to, label, icon: Icon, end }) => (
                      <li key={to}>
                        <NavLink
                          to={to}
                          end={end}
                          title={collapsed ? label : undefined}
                          className={({ isActive }) =>
                            `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
                              isActive
                                ? "bg-accent/15 text-text-primary shadow-[inset_0_0_0_1px_rgba(124,92,255,0.25)]"
                                : "text-text-muted hover:bg-bg-raised/60 hover:text-text-primary"
                            } ${collapsed ? "justify-center" : ""}`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span
                                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                                  isActive
                                    ? "bg-accent/25 text-accent"
                                    : "bg-bg-raised/60 text-text-muted group-hover:text-text-primary"
                                }`}
                              >
                                <Icon size={15} strokeWidth={1.75} />
                              </span>
                              {!collapsed && <span className="truncate">{label}</span>}
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
        <div className={`border-t border-border/70 p-3 ${collapsed ? "px-2" : ""}`}>
          <div
            className={`mb-2 flex items-center gap-2 rounded-xl border border-border/70 bg-bg-base/60 px-3 py-2 text-[11px] ${collapsed ? "justify-center px-2" : ""}`}
            title={online ? "Server online" : "Server offline"}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {online && <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-65 anim-pulse-soft" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${online ? "bg-success" : "bg-danger"}`} />
            </span>
            {!collapsed && (
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
          <button
            onClick={async () => {
              try {
                await auth.logout();
              } catch {
                /* server unreachable — still sign out locally */
              }
              qc.clear();
              navigate("/login");
            }}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-muted transition-colors hover:bg-bg-raised/70 hover:text-text-primary ${collapsed ? "justify-center" : ""}`}
            title="Sign out"
          >
            <LogOut size={14} />
            {!collapsed && "Sign out"}
          </button>
        </div>
      </aside>

      {/* main — `min-h-0 overflow-hidden` lets individual pages (e.g. Playground)
          fill the viewport and own their own scroll region without the main
          scrollbar fighting them. Other pages still opt into overflow-y-auto
          if they need to grow. */}
      <main className="flex min-h-0 flex-1 overflow-hidden">
        {/* key=pathname forces the page-enter animation to re-run on every
            route change. CSS animations only fire on mount. */}
        <div key={useLocation().pathname} className="page-enter min-h-0 w-full overflow-y-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex items-center justify-between anim-fade-in-down">
      <div>
        <p className="mb-1 text-xs uppercase tracking-[0.24em] text-text-muted">Mirais dashboard</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}