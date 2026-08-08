import { Navigate } from "react-router-dom";

/** Backwards-compat route — the unified Logs page now owns warmup logs. */
export default function WarmupLogs() {
  return <Navigate to="/dashboard/logs?tab=warmup" replace />;
}