import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { music as musicApiClient, settings as settingsApi } from "./api";
import { Layout } from "./components/Layout";
import { AuthGate } from "./components/AuthGate";
import { Splash } from "./components/Splash";
import { ToastHost } from "./components/ui";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicMiniPlayer from "./components/MusicMiniPlayer";
import Landing from "./pages/Landing";

const Overview = lazy(() => import("./pages/Overview"));
const Chat = lazy(() => import("./pages/Chat"));
const Providers = lazy(() => import("./pages/Providers"));
const ProviderDetail = lazy(() => import("./pages/ProviderDetail"));
const Combos = lazy(() => import("./pages/Combos"));
const Keys = lazy(() => import("./pages/Keys"));
const Logs = lazy(() => import("./pages/Logs"));
const WarmupLogsRedirect = lazy(() => import("./pages/WarmupLogs"));
const TestLogsRedirect = lazy(() => import("./pages/TestLogs"));
const UsageLog = lazy(() => import("./pages/UsageLog"));
const Settings = lazy(() => import("./pages/Settings"));
const Music = lazy(() => import("./pages/Music"));

const ACCENT_STORAGE_KEY = "mirais.ui.accent";
const ACCENT_DEFAULT = "#7c5cff";

function applyAccentColor(value: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--color-accent", value);
}

function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "124, 92, 255";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function AccentBoot() {
  useEffect(() => {
    // 1. Local cache first so the accent is correct before the network reply.
    try {
      const cached = window.localStorage.getItem(ACCENT_STORAGE_KEY);
      if (cached && /^#[0-9a-fA-F]{6}$/.test(cached)) applyAccentColor(cached);
      else applyAccentColor(ACCENT_DEFAULT);
    } catch {
      applyAccentColor(ACCENT_DEFAULT);
    }
    // 2. Refresh from server so it follows the server settings.
    let cancelled = false;
    void settingsApi.get()
      .then((s) => {
        if (cancelled) return;
        const fromServer = s.ui?.accent;
        if (fromServer && /^#[0-9a-fA-F]{6}$/.test(fromServer)) {
          applyAccentColor(fromServer);
          try {
            window.localStorage.setItem(ACCENT_STORAGE_KEY, fromServer);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* ignore — we already applied the local fallback */
      });
    // 3. Listen for changes from other tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACCENT_STORAGE_KEY && typeof e.newValue === "string" && /^#[0-9a-fA-F]{6}$/.test(e.newValue)) {
        applyAccentColor(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}

function DashboardMusicMiniPlayer() {
  const location = useLocation();
  return location.pathname === "/dashboard/music" ? null : <MusicMiniPlayer />;
}

export default function App() {
  return (
    <>
      <AccentBoot />
      <AuthGate>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard/*" element={
            <MusicPlayerProvider streamUrlFor={musicApiClient.streamUrl}>
              <Layout>
                <Suspense fallback={<Splash />}>
                  <Routes>
                    <Route index element={<Overview />} />
                    <Route path="chat" element={<Chat />} />
                    <Route path="providers" element={<Providers />} />
                    <Route path="providers/:id" element={<ProviderDetail />} />
                    <Route path="combos" element={<Combos />} />
                    <Route path="keys" element={<Keys />} />
                    <Route path="logs" element={<Logs />} />
                    <Route path="warmup-logs" element={<WarmupLogsRedirect />} />
                    <Route path="test-logs" element={<TestLogsRedirect />} />
                    <Route path="usage" element={<UsageLog />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="music" element={<Music />} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </Suspense>
              </Layout>
              <DashboardMusicMiniPlayer />
            </MusicPlayerProvider>
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
      <ToastHost />
    </>
  );
}
