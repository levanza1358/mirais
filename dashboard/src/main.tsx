import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

declare const __APP_BUILD_TIME__: string;
declare const __APP_BUILD_VERSION__: string;

/**
 * Format an ISO timestamp as `DD-MM-YY HH:MM` in UTC. We use UTC so the same
 * bundle shows the same string everywhere — there's no point in the sidebar
 * telling the user the build time in their local timezone if the timezone
 * is going to shift every time they travel.
 */
function formatBuildStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(d.getUTCDate());
  const month = pad(d.getUTCMonth() + 1);
  const year = String(d.getUTCFullYear()).slice(-2);
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  return `${day}-${month}-${year} ${hours}:${minutes} UTC`;
}

export const APP_BUILD = {
  time: __APP_BUILD_TIME__,
  stamp: formatBuildStamp(__APP_BUILD_TIME__),
  version: __APP_BUILD_VERSION__,
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);