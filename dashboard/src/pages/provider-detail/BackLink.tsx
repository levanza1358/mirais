import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export function BackLink() {
  return <Link to="/providers" className="inline-flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"><ArrowLeft size={13} /> Back to Providers</Link>;
}
