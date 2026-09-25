import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { providers } from "../api";
import { Badge, Card, EmptyState, Select, Skeleton } from "../components/ui";
import { PageHeader } from "../components/Layout";

function capabilities(raw: string | null): string[] { try { const parsed = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }

export default function Capabilities() {
  const [filter, setFilter] = useState("");
  const query = useQuery({ queryKey: ["capabilities"], queryFn: providers.list, staleTime: 30_000 });
  const rows = useMemo(() => (query.data ?? []).flatMap((provider) => (provider.models ?? []).filter((model) => model.enabled).map((model) => ({ provider, model, caps: capabilities(model.capabilities) }))).filter(({ caps }) => !filter || caps.includes(filter)), [query.data, filter]);
  const available = [...new Set(rows.flatMap((row) => row.caps))].sort();
  return <div><PageHeader title="Model capabilities"><div className="w-48"><Select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">All capabilities</option>{available.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</Select></div></PageHeader><Card className="overflow-hidden p-0"><div className="grid grid-cols-[minmax(12rem,1fr)_10rem_10rem_1fr] gap-3 border-b border-border px-4 py-3 text-[10px] uppercase tracking-[0.18em] text-text-muted"><span>Model</span><span>Context</span><span>Output</span><span>Capabilities</span></div>{query.isLoading ? <div className="p-4"><Skeleton className="h-32 w-full" /></div> : rows.map(({ provider, model, caps }) => <div key={`${provider.id}-${model.id}`} className="grid grid-cols-[minmax(12rem,1fr)_10rem_10rem_1fr] items-center gap-3 border-b border-border/60 px-4 py-3 text-xs"><div><p className="font-medium">{model.display_name || model.model_id}</p><p className="text-[11px] text-text-muted">{provider.name}</p></div><span className="text-text-muted">{model.context_length ? `${Math.round(model.context_length / 1000)}k` : "—"}</span><span className="text-text-muted">{model.max_output_tokens ? `${Math.round(model.max_output_tokens / 1000)}k` : "—"}</span><div className="flex flex-wrap gap-1">{caps.length ? caps.map((capability) => <Badge key={capability} tone="accent">{capability}</Badge>) : <span className="text-text-muted">Not reported</span>}</div></div>)}</Card>{!query.isLoading && !rows.length && <Card className="mt-4"><EmptyState icon={<SlidersHorizontal size={32} />} title="No matching model metadata" hint="Sync provider models or clear the capability filter." /></Card>}</div>;
}
