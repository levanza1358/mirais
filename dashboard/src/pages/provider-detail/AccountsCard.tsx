import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, ChevronLeft, ChevronRight, Gauge, Pencil, Plus, Trash2 } from "lucide-react";
import { type Provider, type ProviderAccount, providers } from "../../api";
import { Badge, Button, Card, ConfirmModal, Switch, fmtNum, fmtTime, toast } from "../../components/ui";
import { AccountMetaModal } from "./AccountMetaModal";
import { AddAccountModal } from "./AddAccountModal";
import { CodexQuotaModal, InlineCodexQuota, quotaTitle } from "./quota";
import { ACCOUNT_PAGE_SIZE_OPTIONS, DEFAULT_ACCOUNTS_PER_PAGE } from "./types";

export function AccountsCard({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderAccount | null>(null);
  const [quotaFor, setQuotaFor] = useState<ProviderAccount | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_ACCOUNTS_PER_PAGE);
  const [editingMeta, setEditingMeta] = useState<ProviderAccount | null>(null);
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

  const updateMeta = useMutation({
    mutationFn: ({ accountId, notes, tags }: { accountId: string; notes: string; tags: string }) => providers.updateAccount(accountId, { notes: notes || null, tags: tags || null }),
    onSuccess: () => {
      invalidate();
      setEditingMeta(null);
      toast("Account metadata updated");
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const accounts = provider.accounts ?? [];
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
  const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageAccounts = accounts.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cable size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">Accounts</h2>
          <span className="text-xs text-text-muted">{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>Show</span>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="rounded-md border border-border bg-bg-base px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none">
              {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Add account</Button>
        </div>
      </div>

      {accounts.length === 0 && <p className="py-4 text-center text-xs text-text-muted">No accounts yet — add an API key to enable this provider.</p>}

      <div className="space-y-2">
        {pageAccounts.map((account) => {
          const row = usageByLabel.get(account.label);
          const quota = codexQuotaByAccountId.get(account.id);
          return (
            <div key={account.id} className="relative rounded-lg bg-bg-base/50 px-3 py-3 text-xs">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-block size-2 shrink-0 rounded-full ${account.enabled ? "bg-success" : "bg-text-muted/30"}`} />
                    <span className="font-medium">{account.label}</span>
                    {account.last_warmup_status === "healthy" && <Badge tone="success">healthy</Badge>}
                    {account.last_warmup_status === "rate_limited" && <Badge tone="warning">rate limited</Badge>}
                    {account.last_warmup_status === "failing" && <Badge tone="danger">failing</Badge>}
                    <span className="break-all font-mono text-text-muted">{account.api_key}</span>
                  </div>
                  <div className="flex flex-col gap-1 text-text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                    <span title={row ? `Today: ${row.requests_today} req · ${fmtNum(row.tokens_today)} tok\nAll-time: ${row.requests_total} req · ${fmtNum(row.tokens_total)} tok` : "No usage recorded yet"}>{row ? `${fmtNum(row.requests_today)} req · ${fmtNum(row.tokens_today)} tok today` : "—"}</span>
                    {quota && <div className="lg:hidden"><InlineCodexQuota data={quota.data} loading={quota.isLoading} /></div>}
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
                  <Button variant="ghost" size="sm" onClick={() => setEditingMeta(account)}><Pencil size={13} /></Button>
                  {(account.auth_kind === "oauth" || provider.type === "codebuddy-global" || provider.type === "codebuddy-cn") && (
                    <Button variant="ghost" size="sm" onClick={() => setQuotaFor(account)} aria-label={`Quota for ${account.label}`} title={quotaTitle(account, true)}><Gauge size={13} className="text-accent" /></Button>
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
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
          <span>{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, accounts.length)} of {accounts.length}</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={13} /> Prev</Button>
            <span className="px-2">Page {safePage} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next <ChevronRight size={13} /></Button>
          </div>
        </div>
      )}

      {adding && <AddAccountModal provider={provider} accountCount={accounts.length} onClose={() => setAdding(false)} />}
      {quotaFor && <CodexQuotaModal account={quotaFor} onClose={() => setQuotaFor(null)} />}
      {editingMeta && <AccountMetaModal account={editingMeta} loading={updateMeta.isPending} onClose={() => setEditingMeta(null)} onSave={(notes, tags) => updateMeta.mutate({ accountId: editingMeta.id, notes, tags })} />}

      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && removeAccount.mutate(removing.id)} title="Remove account" message={`Remove account "${removing?.label}" from ${provider.name}? Requests will no longer use this key.`} danger loading={removeAccount.isPending} />
    </Card>
  );
}
