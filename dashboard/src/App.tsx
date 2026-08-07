import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { auth, music as musicApiClient } from "./api";
import { Layout } from "./components/Layout";
import { ToastHost } from "./components/ui";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicMiniPlayer from "./components/MusicMiniPlayer";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import Overview from "./pages/Overview";
import Providers from "./pages/Providers";
import ProviderDetail from "./pages/ProviderDetail";
import Combos from "./pages/Combos";
import Keys from "./pages/Keys";
import Logs from "./pages/Logs";
import WarmupLogs from "./pages/WarmupLogs";
import UsageLog from "./pages/UsageLog";
import Settings from "./pages/Settings";
import Integrations from "./pages/Integrations";
import Proxy from "./pages/Proxy";
import Playground from "./pages/Playground";
import Music from "./pages/Music";
import { Skeleton } from "./components/ui";

export default function App() {
  const location = useLocation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["auth-check"],
    queryFn: auth.check,
    retry: false,
  });

  if (location.pathname === "/login") {
    return (
      <>
        <Login />
        <ToastHost />
      </>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="text-danger">Cannot reach the Mirais server.</p>
        <p className="text-sm text-text-muted">Is it running on port 1463?</p>
      </div>
    );
  }

  if (data?.needs_setup && !data?.passwordless) {
    return (
      <>
        <Setup />
        <ToastHost />
      </>
    );
  }

  if (!data?.authenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <>
      <MusicPlayerProvider streamUrlFor={musicApiClient.streamUrl}>
        <Layout>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/providers/:id" element={<ProviderDetail />} />
            <Route path="/combos" element={<Combos />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/warmup-logs" element={<WarmupLogs />} />
            <Route path="/usage" element={<UsageLog />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/proxies" element={<Proxy />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/music" element={<Music />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
        <MusicMiniPlayer />
      </MusicPlayerProvider>
      <ToastHost />
    </>
  );
}
