import { Navigate } from "react-router-dom";

/** Backwards-compat route — the unified Logs page now owns model test logs. */
export default function TestLogs() {
  return <Navigate to="/dashboard/logs?tab=test" replace />;
}