import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Globe2, Power, RefreshCw, ShieldCheck, Trash2, Wand2 } from "lucide-react";
import { proxies, providers, type ProxyRecord, type ProxyStatus } from "../api";
import { Badge, Button, Card, ConfirmModal, EmptyState, Input, Skeleton, Switch, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";

const STATUS_TONE: Record<ProxyStatus, "muted" | "success" | "warning" | "danger" | "accent"> = {
  pending: "muted",
  healthy: "success",
  slow: "warning",
  failing: "danger",
  disabled: "muted",
};

const STATUS_LABEL: Record<ProxyStatus, string> = {
  pending: "Pending",
  healthy: "Healthy",
  slow: "Slow",
  failing: "Failing",
  disabled: "Disabled",
};

const PAGE_SIZE = 20;

export default function Proxies() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const bundle = useQuery({
    queryKey: ["proxies", page],
    queryFn: () => proxies.list({ page, pageSize: PAGE_SIZE }),
    refetchInterval: 15_000,
  });
  const providerList = useQuery({ queryKey: ["providers"], queryFn: providers.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["proxies"] });
  const invalidateAll = () => { qc.invalidateQueries({ queryKey: ["proxies"] }); setPage(1); };

  const scrape = useMutation({
    mutationFn: () => proxies.scrape(),
    onSuccess: (r) => {
      invalidate();
      const added = r.results.reduce((acc, x) => acc + x.added, 0);
      const fetched = r.results.reduce((acc, x) => acc + x.fetched, 0);
      toast(`Scraped ${fetched} entries · added ${added} new · probed ${r.probed.length}`, "success");
    },
    onError: (e) => toast(e.message, "error"),
  });

  const probe = useMutation({
    mutationFn: (id?: string) => proxies.probe(id),
    onSuccess: (r) => { invalidate(); toast(`Re-probed ${r.probed.length} proxies`, "success"); },
    onError: (e) => toast(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => proxies.remove(id),
    onSuccess: () => { invalidate(); },
    onError: (e) => toast(e.message, "error"),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => proxies.toggle(id),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const clear = useMutation({
    mutationFn: () => proxies.clear(),
    onSuccess: (r) => { invalidateAll(); toast(`Removed ${r.removed} proxies`, "success"); },
    onError: (e) => toast(e.message, "error"),
  });

  const [confirmClear, setConfirmClear] = useState(false);

  const summary = useMemo(() => {
    const list = bundle.data?.proxies ?? [];
    return {
      total: bundle.data?.total ?? 0,
      healthy: list.filter((p) => p.status === "healthy").length,
      slow: list.filter((p) => p.status === "slow").length,
      failing: list.filter((p) => p.status === "failing").length,
    };
  }, [bundle.data]);

  const totalPages = bundle.data?.total_pages ?? 1;

  return (
    <div>
      <PageHeader
        title="Proxy Pool"
        subtitle="Free HTTP proxies for upstream connectivity. Use only on providers you trust with proxy traffic."
      >
        <Button
          variant="outline"
          onClick={() => probe.mutate(undefined)}
          loading={probe.isPending}
          disabled={!bundle.data}
        >
          <RefreshCw size={14} /> Probe all
        </Button>
        <Button
          onClick={() => scrape.mutate()}
          loading={scrape.isPending}
          disabled={!bundle.data}
        >
          <Wand2 size={14} /> Scrape now
        </Button>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={summary.total} />
        <StatTile label="Healthy (page)" value={summary.healthy} tone="success" />
        <StatTile label="Slow (page)" value={summary.slow} tone="warning" />
        <StatTile label="Failing (page)" value={summary.failing} tone="danger" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Discovered proxies</h3>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => probe.mutate(undefined)} loading={probe.isPending}>
                  <RefreshCw size={12} /> Re-probe
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)} disabled={!summary.total}>
                  <Trash2 size={12} /> Clear all
                </Button>
              </div>
            </div>
            {bundle.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (bundle.data?.proxies.length ?? 0) === 0 ? (
              <EmptyState
                icon={<Globe2 size={36} className="text-accent/60" />}
                title="No proxies yet"
                hint="Run a scrape to discover free public proxies, or add one manually below."
                action={<Button onClick={() => scrape.mutate()} loading={scrape.isPending}><Wand2 size={14} /> Scrape now</Button>}
              />
            ) : (
              <>
                <ProxyTable
                  proxies={bundle.data?.proxies ?? []}
                  onToggle={(id) => toggle.mutate(id)}
                  onProbe={(id) => probe.mutate(id)}
                  onRemove={(id) => remove.mutate(id)}
                />
                <PaginationBar
                  page={bundle.data?.page ?? 1}
                  totalPages={totalPages}
                  total={bundle.data?.total ?? 0}
                  pageSize={PAGE_SIZE}
                  onChange={(p) => setPage(p)}
                />
              </>
            )}
            <ConfirmModal
              open={confirmClear}
              onClose={() => setConfirmClear(false)}
              onConfirm={() => { clear.mutate(); setConfirmClear(false); }}
              title="Remove all proxies?"
              message="This deletes every discovered proxy. Routing will fall back to direct connections until you scrape again."
              danger
              loading={clear.isPending}
            />
          </Card>
        </div>

        <div className="space-y-6">
          <SchedulerCard
            config={bundle.data?.config ?? { enabled: false, interval_minutes: 60 }}
            onSaved={invalidate}
          />
          <ManualAddCard onAdded={invalidateAll} />
          <BulkAddCard onAdded={invalidateAll} />
          <AssignmentsCard
            assignments={bundle.data?.assignments ?? []}
            providers={providerList.data ?? []}
            onSaved={invalidate}
          />
          <SourcesCard sources={bundle.data?.sources ?? []} runs={bundle.data?.scrape_runs ?? []} />
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  const toneCls = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-text-primary";
  return (
    <Card className="!p-4">
      <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneCls}`}>{value}</p>
    </Card>
  );
}

function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return (
      <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
        <span>{total} proxies total</span>
        <span>page {page} / {totalPages}</span>
      </div>
    );
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-xs text-text-muted">
      <span>showing {start}–{end} of {total}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onChange(page - 1)} disabled={page <= 1}>
          <ChevronLeft size={12} /> Prev
        </Button>
        <PageNumbers page={page} totalPages={totalPages} onChange={onChange} />
        <Button size="sm" variant="ghost" onClick={() => onChange(page + 1)} disabled={page >= totalPages}>
          Next <ChevronRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function PageNumbers({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  const max = 5;
  const start = Math.max(1, Math.min(page - 2, totalPages - max + 1));
  const end = Math.min(totalPages, start + max - 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  return (
    <>
      {pages.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${
            p === page
              ? "bg-accent/20 text-text-primary"
              : "text-text-muted hover:bg-bg-raised hover:text-text-primary"
          }`}
        >
          {p}
        </button>
      ))}
    </>
  );
}

function ProxyTable({
  proxies,
  onToggle,
  onProbe,
  onRemove,
}: {
  proxies: ProxyRecord[];
  onToggle: (id: string) => void;
  onProbe: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-border/70 text-left text-xs uppercase tracking-wider text-text-muted">
            <th className="px-2 py-2">Proxy</th>
            <th className="px-2 py-2">Auth</th>
            <th className="px-2 py-2">Status</th>
            <th className="px-2 py-2">Latency</th>
            <th className="px-2 py-2">Source</th>
            <th className="px-2 py-2">Last check</th>
            <th className="px-2 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {proxies.map((p) => (
            <tr key={p.id} className="border-b border-border/40 transition-colors hover:bg-bg-raised/40">
              <td className="px-2 py-2 font-mono">
                {p.host}:{p.port}
                {p.country && <span className="ml-2 text-xs text-text-muted">{p.country}</span>}
              </td>
              <td className="px-2 py-2 text-xs text-text-muted">{p.username ? "user:pass" : "—"}</td>
              <td className="px-2 py-2"><Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge></td>
              <td className="px-2 py-2 text-text-muted">{p.latency_ms != null ? `${p.latency_ms}ms` : "—"}</td>
              <td className="px-2 py-2 text-text-muted">{p.source}</td>
              <td className="px-2 py-2 text-text-muted" title={p.last_error ?? ""}>{p.last_checked?.slice(11, 19) ?? "—"}</td>
              <td className="px-2 py-2">
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onProbe(p.id)} title="Re-probe">
                    <RefreshCw size={12} />
                  </Button>
                  <button
                    className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary"
                    onClick={() => onToggle(p.id)}
                    title={p.status === "disabled" ? "Enable" : "Disable"}
                  >
                    <Power size={12} />
                  </button>
                  <button
                    className="rounded-md p-1 text-danger/80 transition-colors hover:bg-danger/15 hover:text-danger"
                    onClick={() => onRemove(p.id)}
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulerCard({ config, onSaved }: { config: { enabled: boolean; interval_minutes: number }; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [minutes, setMinutes] = useState(String(config.interval_minutes));
  const save = useMutation({
    mutationFn: () => proxies.saveConfig({ enabled, interval_minutes: Number(minutes) }),
    onSuccess: () => { onSaved(); toast("Scheduler saved"); },
    onError: (e) => toast(e.message, "error"),
  });
  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Auto-scrape schedule</h3>
      <p className="mb-4 text-xs text-text-muted">Runs the scraper periodically and re-probes every discovered proxy.</p>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Enabled</span>
          <Switch checked={enabled} onChange={setEnabled} aria-label="Enable auto scrape" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Interval (minutes)</label>
          <Input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
        </div>
      </div>
    </Card>
  );
}

function ManualAddCard({ onAdded }: { onAdded: () => void }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [country, setCountry] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const create = useMutation({
    mutationFn: () => proxies.create({
      host: host.trim(),
      port: Number(port),
      country: country.trim() || undefined,
      username: username.trim() || undefined,
      password: password.trim() || undefined,
    }),
    onSuccess: () => {
      setHost(""); setPort(""); setCountry(""); setUsername(""); setPassword("");
      onAdded();
      toast("Proxy added — probing now");
      proxies.probe().catch(() => undefined);
    },
    onError: (e) => toast(e.message, "error"),
  });
  const submit = () => {
    const portNum = Number(port);
    if (!host.trim() || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toast("Host and valid port required", "error");
      return;
    }
    if ((username.trim() && !password.trim()) || (!username.trim() && password.trim())) {
      toast("Username and password must be provided together", "error");
      return;
    }
    create.mutate();
  };
  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Add manually</h3>
      <p className="mb-4 text-xs text-text-muted">Use only proxies you trust. Traffic to the upstream goes through it.</p>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} className="col-span-2" />
          <Input placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <Input placeholder="country (optional ISO-2)" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="username (optional)" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input placeholder="password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button onClick={submit} loading={create.isPending}>Add proxy</Button>
        </div>
      </div>
    </Card>
  );
}

function BulkAddCard({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("manual");
  const create = useMutation({
    mutationFn: () => proxies.bulkAdd({
      lines: text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      source: source.trim() || "manual",
    }),
    onSuccess: (r) => {
      setText("");
      onAdded();
      toast(`Bulk add · received ${r.received} · added ${r.added} · skipped ${r.skipped} · invalid ${r.invalid}`, "success");
      proxies.probe().catch(() => undefined);
    },
    onError: (e) => toast(e.message, "error"),
  });
  const submit = () => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      toast("Paste at least one proxy line", "error");
      return;
    }
    if (lines.length > 2_000) {
      toast(`Too many lines (${lines.length}); max 2,000`, "error");
      return;
    }
    create.mutate();
  };
  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Bulk add</h3>
      <p className="mb-3 text-xs text-text-muted">
        One per line, in any of these shapes:
        <br />
        <code className="font-mono">host:port</code> ·{" "}
        <code className="font-mono">host:port:US</code> ·{" "}
        <code className="font-mono">host:port:user:pass</code>
      </p>
      <textarea
        className="h-32 w-full resize-y rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted/60 transition-all duration-[var(--duration-base)] ease-[var(--ease-out-soft)] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 hover:border-border/80"
        placeholder={"31.59.20.176:6754:rslbrigs:p1xor2bbd19d\n31.56.127.193:7684:rslbrigs:p1xor2bbd19d\n45.38.107.97:6014:rslbrigs:p1xor2bbd19d"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-3 flex items-center gap-2">
        <Input placeholder="source tag" value={source} maxLength={32} onChange={(e) => setSource(e.target.value)} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={() => setText("")} disabled={!text}>Clear</Button>
          <Button onClick={submit} loading={create.isPending}>Bulk add</Button>
        </div>
      </div>
    </Card>
  );
}

function AssignmentsCard({
  assignments,
  providers,
  onSaved,
}: {
  assignments: Array<{ provider_id: string; mode: "direct" | "pool" | "scored" }>;
  providers: Array<{ id: string; name: string; type: string }>;
  onSaved: () => void;
}) {
  const setMode = useMutation({
    mutationFn: (input: { provider_id: string; mode: "direct" | "pool" | "scored" }) => proxies.setAssignment(input.provider_id, input.mode),
    onSuccess: onSaved,
    onError: (e) => toast(e.message, "error"),
  });

  const modeOf = (id: string): "direct" | "pool" | "scored" => assignments.find((a) => a.provider_id === id)?.mode ?? "direct";
  const rows: Array<{ id: string; label: string }> = [{ id: "*", label: "Global default" }, ...providers.map((p) => ({ id: p.id, label: p.name }))];

  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Provider routing</h3>
      <p className="mb-4 text-xs text-text-muted">Choose which providers route their upstream requests through the pool.</p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-bg-base/40 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-text-primary">{r.label}</p>
              <p className="text-xs text-text-muted">{r.id === "*" ? "Used when a provider has no specific mode" : r.id}</p>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-bg-base/40 p-0.5">
              {(["direct", "pool", "scored"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    modeOf(r.id) === mode
                      ? "bg-accent/20 text-text-primary"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                  onClick={() => setMode.mutate({ provider_id: r.id, mode })}
                  disabled={setMode.isPending}
                >
                  {mode === "direct" ? "Off · Direct" : mode === "pool" ? "On · Pool" : "On · Scored"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1 text-xs text-text-muted">
        <ShieldCheck size={12} /> Only healthy proxies are used. Failing proxies fall back to direct.
      </p>
    </Card>
  );
}

function SourcesCard({
  sources,
  runs,
}: {
  sources: Array<{ name: string; url: string }>;
  runs: Array<{ id: string; source: string; started_at: string; fetched: number; added: number; skipped: number; error: string | null; triggered_by: string }>;
}) {
  return (
    <Card>
      <h3 className="mb-1 text-sm font-medium">Scrape sources</h3>
      <p className="mb-4 text-xs text-text-muted">Free public proxy lists, polled on demand and on the schedule.</p>
      <ul className="mb-4 space-y-2">
        {sources.map((s) => (
          <li key={s.name} className="rounded-lg border border-border/70 bg-bg-base/40 px-3 py-2">
            <p className="text-sm text-text-primary">{s.name}</p>
            <p className="break-all text-xs text-text-muted">{s.url}</p>
          </li>
        ))}
      </ul>
      <h4 className="mb-2 text-xs uppercase tracking-wider text-text-muted">Recent runs</h4>
      {runs.length === 0 ? (
        <p className="text-xs text-text-muted">No scrape history yet.</p>
      ) : (
        <ul className="space-y-1.5 text-xs text-text-muted">
          {runs.slice(0, 10).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{r.source} · {r.triggered_by}</span>
              <span>
                fetched {r.fetched} · added {r.added} · skipped {r.skipped}
                {r.error ? ` · err ${r.error.slice(0, 24)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}