import { Routes, Route, Navigate } from "react-router-dom";
import { music as musicApiClient } from "./api";
import { Layout } from "./components/Layout";
import { ToastHost } from "./components/ui";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicMiniPlayer from "./components/MusicMiniPlayer";
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

export default function App() {
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
