import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, CalendarCheck, ChevronLeft, ChevronRight, Download, Gauge, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type Provider, type ProviderAccount, providers } from "../../api";
import { Badge, Button, Card, ConfirmModal, Modal, Select, Switch, fmtNum, fmtTime, toast } from "../../components/ui";
import { AccountMetaModal } from "./AccountMetaModal";
import { AddAccountModal } from "./AddAccountModal";
import { CodexQuotaModal, InlineCodexQuota, InlineCopilotQuota, quotaTitle } from "./quota";
import { ACCOUNT_PAGE_SIZE_OPTIONS, DEFAULT_ACCOUNTS_PER_PAGE } from "./types";
import { downloadCsv, toCsv } from "../../utils/csv";

type AccountStatusTab = "healthy" | "rate_limited" | "failing" | "unknown";

const ACCOUNT_STATUS_TABS: Array<{ id: AccountStatusTab; label: string; activeClassName: string }> = [
  { id: "healthy", label: "Healthy", activeClassName: "border-success bg-success/10 text-success" },
  { id: "rate_limited", label: "Rate Limited", activeClassName: "border-warning bg-warning/10 text-warning" },
  { id: "failing", label: "Failing", activeClassName: "border-danger bg-danger/10 text-danger" },
  { id: "unknown", label: "Unknown", activeClassName: "border-muted bg-muted/10 text-text-muted" },
];

export function AccountsCard({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [reconnecting, setReconnecting] = useState<ProviderAccount | null>(null);
  const [removing, setRemoving] = useState<ProviderAccount | null>(null);
  const [removingAll, setRemovingAll] = useState(false);
  const [bulkDelete, setBulkDelete] = useState<{ total: number; removed: number; failed: number; running: boolean } | null>(null);
  const [quotaFor, setQuotaFor] = useState<ProviderAccount | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_ACCOUNTS_PER_PAGE);
  const [editingMeta, setEditingMeta] = useState<ProviderAccount | null>(null);
  const [statusTab, setStatusTab] = useState<AccountStatusTab>("healthy");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removingSelected, setRemovingSelected] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["providers"] });

  const usage = useQuery({
    queryKey: ["account-usage", provider.id],
    queryFn: () => providers.accountUsage(provider.id),
    refetchInterval: 30_000,
  });
  const usageByLabel = useMemo(() => new Map((usage.data ?? []).map((row) => [row.account, row])), [usage.data]);

  const toggleAccount = useMutation({
    mutationFn: (account: ProviderAccount) => providers.updateAccount(account.id, { enabled: !account.enabled }),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, "error"),
  });

  const removeAccount = useMutation({
    mutationFn: (accountId: string) => providers.removeAccount(accountId),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
      toast("Account removed");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const removeAllAccounts = useMutation({
    mutationFn: async (accountIds: string[]) => {
      let removed = 0;
      let failed = 0;
      setBulkDelete({ total: accountIds.length, removed, failed, running: true });
      for (const accountId of accountIds) {
        try {
          await providers.removeAccount(accountId);
          removed += 1;
        } catch {
          failed += 1;
        }
        setBulkDelete({ total: accountIds.length, removed, failed, running: true });
      }
      return { removed, failed };
    },
    onSuccess: ({ removed, failed }) => {
      invalidate();
      setRemovingAll(false);
      setRemovingSelected(false);
      setSelected(new Set());
      setPage(1);
      setBulkDelete((current) => current ? { ...current, running: false } : current);
      toast(failed ? `${removed} removed; ${failed} failed` : `${removed} account${removed === 1 ? "" : "s"} removed`, failed ? "error" : "success");
    },
    onError: (error: Error) => {
      setBulkDelete((current) => current ? { ...current, running: false } : current);
      toast(error.message, "error");
    },
  });

  const updateMeta = useMutation({
    mutationFn: ({ accountId, notes, tags, sessionCookie }: { accountId: string; notes: string; tags: string; sessionCookie: string }) =>
      providers.updateAccount(accountId, { notes: notes || null, tags: tags || null, sessionCookie: sessionCookie || null }),
    onSuccess: () => {
      invalidate();
      setEditingMeta(null);
      toast("Account metadata updated");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const checkin = useMutation({
    mutationFn: (accountId: string) => providers.checkinAccount(accountId),
    onSuccess: (result) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["codex-quota"] });
      toast(result.message, result.ok ? "success" : "error");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const accounts = provider.accounts ?? [];
  const exportAccounts = useMutation({
    mutationFn: () => providers.exportAccounts(provider.id),
    onSuccess: (rows) => {
      const csv = toCsv(
        rows.map((account, index) => ({
          no: index + 1,
          label: account.label,
          auth_kind: account.auth_kind ?? "api_key",
          credential: account.api_key,
          refresh_token: account.refresh_token ?? "",
          account_id: account.account_id ?? "",
          expires_at: account.expires_at ? new Date(account.expires_at).toISOString() : "",
          enabled: account.enabled ? "yes" : "no",
          status: account.last_warmup_status ?? "unknown",
          created_at: account.created_at,
        })),
      );
      downloadCsv(`mirais-${provider.name}-accounts-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      toast(`Exported ${rows.length} account${rows.length === 1 ? "" : "s"} — file contains full credentials, store it safely`, "success");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });
  const accountCounts = useMemo(
    () => Object.fromEntries(ACCOUNT_STATUS_TABS.map(({ id }) => [id, id === "unknown"
      ? accounts.filter((account) => !account.last_warmup_status).length
      : accounts.filter((account) => account.last_warmup_status === id).length])) as Record<AccountStatusTab, number>,
    [accounts],
  );
  const filteredAccounts = statusTab === "unknown"
    ? accounts.filter((account) => !account.last_warmup_status)
    : accounts.filter((account) => account.last_warmup_status === statusTab);
  const codexAccounts = accounts.filter((account) => account.auth_kind === "oauth" && provider.type === "openai");
  const codexQuotaQueries = useQueries({
    queries: codexAccounts.map((account) => ({
      queryKey: ["codex-quota", account.id],
      queryFn: () => providers.codexQuota(account.id),
      refetchInterval: 60_000,
      staleTime: 30_000,
      retry: 1,
    })),
  });
  const codexQuotaByAccountId = useMemo(
    () => new Map(codexAccounts.map((account, index) => [account.id, codexQuotaQueries[index]])),
    [codexAccounts, codexQuotaQueries],
  );
  const copilotAccounts = provider.type === "github-copilot" ? accounts : [];
  const copilotQuotaQueries = useQueries({
    queries: copilotAccounts.map((account) => ({
      queryKey: ["copilot-quota", account.id],
      queryFn: () => providers.copilotQuota(account.id),
      refetchInterval: 60_000,
      staleTime: 30_000,
      retry: 1,
    })),
  });
  const copilotQuotaByAccountId = useMemo(
    () => new Map(copilotAccounts.map((account, index) => [account.id, copilotQuotaQueries[index]])),
    [copilotAccounts, copilotQuotaQueries],
  );
  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageAccounts = filteredAccounts.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageAllSelected = pageAccounts.length > 0 && pageAccounts.every((account) => selected.has(account.id));

  const toggleSelected = (accountId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    return next;
  });

  // Select/clear only the rows currently visible, so paging never hides a
  // selection the user cannot see before confirming a delete.
  const toggleSelectPage = () => setSelected((current) => {
    const next = new Set(current);
    for (const account of pageAccounts) {
      if (pageAllSelected) next.delete(account.id);
      else next.add(account.id);
    }
    return next;
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cable size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">Accounts</h2>
          <span className="text-xs text-text-muted">{filteredAccounts.length} of {accounts.length} accounts</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>Show</span>
            <Select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="h-8 w-20 rounded-md px-2 py-1 text-xs">
              {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && <Button variant="ghost" size="sm" onClick={() => setRemovingSelected(true)} aria-label={`Remove ${selected.size} selected accounts`}><Trash2 size={14} className="text-danger" /> Delete {selected.size} selected</Button>}
            {accounts.length > 0 && <Button variant="ghost" size="sm" disabled={exportAccounts.isPending} onClick={() => exportAccounts.mutate()} aria-label={`Export all ${accounts.length} accounts`} title="Download every account with its credentials (CSV)">{exportAccounts.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export</Button>}
            {accounts.length > 0 && <Button variant="ghost" size="sm" onClick={() => setRemovingAll(true)} aria-label={`Remove all ${accounts.length} accounts`}><Trash2 size={14} className="text-danger" /> Delete all</Button>}
            <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Add account</Button>
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Account status">
        {ACCOUNT_STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={statusTab === tab.id}
            onClick={() => { setStatusTab(tab.id); setPage(1); }}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${statusTab === tab.id ? tab.activeClassName : "border-border text-text-muted hover:bg-bg-base hover:text-text-primary"}`}
          >
            {tab.label} <span className="ml-1 opacity-75">{accountCounts[tab.id]}</span>
          </button>
        ))}
      </div>

      {accounts.length === 0 && <p className="py-4 text-center text-xs text-text-muted">No accounts yet — add an API key to enable this provider.</p>}
      {accounts.length > 0 && filteredAccounts.length === 0 && <p className="py-4 text-center text-xs text-text-muted">No {ACCOUNT_STATUS_TABS.find((tab) => tab.id === statusTab)?.label.toLowerCase()} accounts.</p>}

      {pageAccounts.length > 0 && (
        <div className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" checked={pageAllSelected} onChange={toggleSelectPage} aria-label="Select all accounts on this page" className="size-3.5 accent-accent" />
          <span>Select page ({pageAccounts.length})</span>
          {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} className="underline hover:text-text-primary">Clear {selected.size} selected</button>}
        </div>
      )}

      <div className="space-y-2">
        {pageAccounts.map((account) => {
          const row = usageByLabel.get(account.label);
          const quota = codexQuotaByAccountId.get(account.id);
          const copilotQuota = copilotQuotaByAccountId.get(account.id);
          return (
            <div key={account.id} className="relative rounded-lg bg-bg-base/50 px-3 py-3 text-xs">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" checked={selected.has(account.id)} onChange={() => toggleSelected(account.id)} aria-label={`Select ${account.label}`} className="size-3.5 shrink-0 accent-accent" />
                    <span className={`inline-block size-2 shrink-0 rounded-full ${account.enabled ? "bg-success" : "bg-text-muted/30"}`} />
                    <span className="font-medium">{account.label}</span>
                    {account.last_warmup_status === "healthy" && <Badge tone="success">healthy</Badge>}
                    {account.last_warmup_status === "rate_limited" && <Badge tone="warning">rate limited</Badge>}
                    {account.last_warmup_status === "failing" && <Badge tone="danger">failing</Badge>}
                    {!account.last_warmup_status && <Badge tone="muted">unknown</Badge>}
                    {account.api_key && <span className="break-all font-mono text-text-muted">{account.api_key}</span>}
                  </div>
                  <div className="flex flex-col gap-1 text-text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                    {provider.type === "github-copilot" && account.base_url && <span className="break-all font-mono">{account.base_url}</span>}
                    <span title={row ? `Today: ${row.requests_today} req · ${fmtNum(row.tokens_today)} tok\nAll-time: ${row.requests_total} req · ${fmtNum(row.tokens_total)} tok` : "No usage recorded yet"}>{row ? `${fmtNum(row.requests_today)} req · ${fmtNum(row.tokens_today)} tok today` : "—"}</span>
                    {quota && <div className="lg:hidden"><InlineCodexQuota data={quota.data} loading={quota.isLoading} /></div>}
                    {copilotQuota && <div className="lg:hidden"><InlineCopilotQuota data={copilotQuota.data} loading={copilotQuota.isLoading} /></div>}
                    <span>{fmtTime(account.created_at)}</span>
                    {account.last_warmup_at && <span>Warmup: {fmtTime(account.last_warmup_at)}</span>}
                    {account.last_warmup_latency_ms != null && <span>{account.last_warmup_latency_ms}ms</span>}
                  </div>
                  {(account.tags || account.notes || account.last_warmup_detail) && (
                    <div className="flex flex-col gap-1 text-[11px] text-text-muted">
                      {account.tags && <span>Tags: {account.tags}</span>}
                      {account.notes && <span>Notes: {account.notes}</span>}
                      {account.last_warmup_detail && account.last_warmup_status === "failing" && <span>Last error: {account.last_warmup_detail}</span>}
                      {account.last_warmup_detail && account.last_warmup_status === "rate_limited" && <span>Last limit: {account.last_warmup_detail}</span>}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 lg:ml-auto">
                  {provider.type === "github-copilot" && account.last_warmup_status === "failing" && (
                    <Button variant="ghost" size="sm" onClick={() => setReconnecting(account)} aria-label={`Reconnect ${account.label}`} title="Reconnect GitHub"><RefreshCw size={13} className="text-warning" /></Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setEditingMeta(account)}><Pencil size={13} /></Button>
                  {provider.type === "codebuddy-cn" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={checkin.isPending && checkin.variables === account.id}
                      onClick={() => checkin.mutate(account.id)}
                      aria-label={`Check in ${account.label}`}
                      title="Daily check-in (+100 credits). Needs a session cookie saved in the edit dialog if the API token alone is rejected."
                    >
                      <CalendarCheck size={13} className={account.session_cookie ? "text-success" : "text-warning"} />
                    </Button>
                  )}
                  {(account.auth_kind === "oauth" || provider.type === "codebuddy-global" || provider.type === "codebuddy-cn") && (
                    <Button variant="ghost" size="sm" onClick={() => setQuotaFor(account)} aria-label={`Quota for ${account.label}`} title={quotaTitle(provider.type, true)}><Gauge size={13} className="text-accent" /></Button>
                  )}
                  <Switch checked={!!account.enabled} onChange={() => toggleAccount.mutate(account)} aria-label={`Toggle ${account.label}`} />
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(account)} aria-label={`Remove ${account.label}`}><Trash2 size={13} className="text-danger" /></Button>
                </div>
              </div>
              {quota && (
                <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block">
                  <InlineCodexQuota data={quota.data} loading={quota.isLoading} />
                </div>
              )}
              {copilotQuota && (
                <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block">
                  <InlineCopilotQuota data={copilotQuota.data} loading={copilotQuota.isLoading} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
          <span>{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filteredAccounts.length)} of {filteredAccounts.length}</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={13} /> Prev</Button>
            <span className="px-2">Page {safePage} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next <ChevronRight size={13} /></Button>
          </div>
        </div>
      )}

      {adding && <AddAccountModal provider={provider} accountCount={accounts.length} onClose={() => setAdding(false)} />}
      {reconnecting && <AddAccountModal provider={provider} accountCount={accounts.length} reconnectAccount={reconnecting} onClose={() => setReconnecting(null)} />}
      {quotaFor && <CodexQuotaModal account={quotaFor} providerType={provider.type} onClose={() => setQuotaFor(null)} />}
      {editingMeta && <AccountMetaModal account={editingMeta} loading={updateMeta.isPending} onClose={() => setEditingMeta(null)} onSave={(notes, tags, sessionCookie) => updateMeta.mutate({ accountId: editingMeta.id, notes, tags, sessionCookie })} />}

      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && removeAccount.mutate(removing.id)} title="Remove account" message={`Remove account "${removing?.label}" from ${provider.name}? Requests will no longer use this key.`} danger loading={removeAccount.isPending} />
      <ConfirmModal open={removingAll} onClose={() => setRemovingAll(false)} onConfirm={() => removeAllAccounts.mutate(accounts.map((account) => account.id))} title="Remove all accounts" message={`Remove all ${accounts.length} accounts from ${provider.name}? This cannot be undone and requests will no longer use this provider.`} danger loading={removeAllAccounts.isPending} />
      <ConfirmModal open={removingSelected} onClose={() => setRemovingSelected(false)} onConfirm={() => removeAllAccounts.mutate([...selected])} title="Remove selected accounts" message={`Remove ${selected.size} selected account${selected.size === 1 ? "" : "s"} from ${provider.name}? This cannot be undone.`} danger loading={removeAllAccounts.isPending} />
      <Modal open={!!bulkDelete} onClose={() => { if (!bulkDelete?.running) setBulkDelete(null); }} title="Deleting accounts">
        {bulkDelete && (() => {
          const complete = bulkDelete.removed + bulkDelete.failed;
          const percent = bulkDelete.total ? Math.round((complete / bulkDelete.total) * 100) : 100;
          return <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              {bulkDelete.running && <Loader2 size={16} className="animate-spin text-danger" />}
              <span>{bulkDelete.running ? "Removing accounts…" : "Deletion complete"}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={bulkDelete.total} aria-valuenow={complete} aria-label="Accounts deletion progress">
              <div className="h-full rounded-full bg-danger transition-[width] duration-200" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-sm text-text-primary"><span className="font-semibold">{bulkDelete.removed}</span> of {bulkDelete.total} deleted{bulkDelete.failed ? ` · ${bulkDelete.failed} failed` : ""}</p>
            {!bulkDelete.running && <div className="flex justify-end"><Button onClick={() => setBulkDelete(null)}>Done</Button></div>}
          </div>;
        })()}
      </Modal>
    </Card>
  );
}
