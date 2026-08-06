import { type ReactNode, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
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
} from "lucide-react";
import { auth, health } from "../api";
import { APP_BUILD } from "../main";
import miraisLogo from "../assets/mirais-logo.svg";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/providers", label: "Providers", icon: Boxes },
  { to: "/combos", label: "Combos", icon: GitBranch },
  { to: "/keys", label: "API Keys", icon: KeyRound },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/warmup-logs", label: "Warmup Logs", icon: ScrollText },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: h } = useQuery({ queryKey: ["health"], queryFn: health, refetchInterval: 10_000, retry: false });
  const [collapsed, setCollapsed] = useState(false);

  const online = h?.status === "ok";

  return (
    <div className="flex h-screen bg-[radial-gradient(circle_at_top,#1a2030_0%,#0b0e14_45%,#090c12_100%)] text-text-primary">
      {/* sidebar */}
      <aside className={`m-3 flex flex-col rounded-3xl border border-border/80 bg-bg-surface/85 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-all duration-300 ${collapsed ? "w-16" : "w-64"}`}>
        <div className={`flex h-16 items-center gap-3 border-b border-border/70 px-5 ${collapsed ? "justify-center px-2" : ""}`}>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent shadow-inner shadow-accent/10 transition-all hover:bg-accent/20"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <img src={miraisLogo} alt="Mirais" className="size-5" />
          </button>
          {!collapsed && (
            <div>
              <span className="block text-sm font-semibold tracking-wide">Mirais</span>
              <span className="text-xs text-text-muted">Build {APP_BUILD.time}</span>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-2xl px-3.5 py-3 text-sm transition-all ${
                  isActive
                    ? "border border-accent/25 bg-accent/12 text-text-primary shadow-[0_12px_24px_rgba(124,92,255,0.12)]"
                    : "border border-transparent text-text-muted hover:border-border/70 hover:bg-bg-raised/70 hover:text-text-primary"
                } ${collapsed ? "justify-center px-2" : ""}`
              }
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-raised/70">
                <Icon size={16} strokeWidth={1.75} />
              </div>
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>
        <div className={`border-t border-border/70 p-4 ${collapsed ? "px-2" : ""}`}>
          <div className={`mb-3 flex items-center gap-2 rounded-2xl border border-border/70 bg-bg-base/60 px-3 py-2 text-xs text-text-muted ${collapsed ? "justify-center px-2" : ""}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success" : "bg-danger"}`} />
            {!collapsed && (online ? "online" : "offline")}
            {!collapsed && h?.uptime_s !== undefined && <span className="ml-auto">{formatUptime(h.uptime_s)}</span>}
          </div>
          <button
            onClick={async () => {
              try { await auth.logout(); } catch { /* server unreachable — still sign out locally */ }
              qc.clear();
              navigate("/login");
            }}
            className={`flex w-full items-center gap-2 rounded-2xl px-3 py-3 text-sm text-text-muted transition-all hover:bg-bg-raised/70 hover:text-text-primary ${collapsed ? "justify-center px-2" : ""}`}
            title="Sign out"
          >
            <LogOut size={15} />
            {!collapsed && "Sign out"}
          </button>
        </div>
      </aside>

      {/* main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-6">{children}</div>
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
    <div className="mb-8 flex items-center justify-between">
      <div>
        <p className="mb-1 text-xs uppercase tracking-[0.24em] text-text-muted">Mirais dashboard</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
