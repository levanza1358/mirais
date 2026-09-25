import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import { audit } from "../api";
import { Button, Card, EmptyState, Skeleton } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Audit() {
  const [page, setPage] = useState(1);
  const limit = 50;
  const query = useQuery({ queryKey: ["audit", page], queryFn: () => audit.list(page, limit), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  return <div>
    <PageHeader title="Audit log"><span className="text-xs text-text-muted">{total} recorded changes</span></PageHeader>
    {query.isLoading ? <Card><Skeleton className="h-48 w-full" /></Card> : !query.data?.items.length ? <Card><EmptyState icon={<ShieldCheck size={32} />} title="No admin changes yet" hint="Configuration changes will appear here without storing secrets or request bodies." /></Card> : <><Card className="overflow-hidden p-0"><div className="divide-y divide-border">{query.data.items.map((entry) => { let detail = entry.detail ?? "—"; try { detail = JSON.stringify(JSON.parse(detail), null, 2); } catch { /* legacy plain text */ } return <div key={entry.id} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr_1fr]"><span className="text-xs text-text-muted">{new Date(entry.ts).toLocaleString()}</span><span><strong>{entry.action}</strong> <span className="text-text-muted">{entry.resource}</span>{entry.resource_id && <span className="block text-[10px] text-text-muted">{entry.resource_id}</span>}</span><pre className="overflow-x-auto whitespace-pre-wrap text-xs text-text-muted">{detail}</pre></div>; })}</div></Card><div className="mt-4 flex items-center justify-between"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} /> Previous</Button><span className="text-xs text-text-muted">Page {page} of {pages}</span><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next <ChevronRight size={14} /></Button></div></>}
  </div>;
}
