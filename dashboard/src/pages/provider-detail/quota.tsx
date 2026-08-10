import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { type CodexQuota, type CodexQuotaWindow, type ProviderAccount, providers } from "../../api";
import { Badge, Button, ConfirmModal, Modal, fmtNum, toast } from "../../components/ui";

export function windowLabel(windowData: CodexQuotaWindow | null, fallback: string): string {
  const seconds = windowData?.window_seconds;
  if (!seconds) return fallback;
  if (seconds <= 5 * 3600) return "5-hour limit";
  if (seconds <= 24 * 3600) return "Daily limit";
  if (seconds <= 7 * 24 * 3600) return "Weekly limit";
  return "Monthly limit";
}

export function resetLabel(windowData: CodexQuotaWindow | null): string {
  if (!windowData) return "—";
  if (windowData.reset_at) {
    const date = new Date(windowData.reset_at * 1000);
    return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (windowData.resets_in_seconds != null) {
    const seconds = windowData.resets_in_seconds;
    if (seconds >= 86400) return `in ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
    if (seconds >= 3600) return `in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `in ${Math.floor(seconds / 60)}m`;
  }
  return "—";
}

export function QuotaBar({ title, windowData }: { title: string; windowData: CodexQuotaWindow | null }) {
  const used = windowData?.used_percent ?? 0;
  const color = used >= 100 ? "bg-danger" : used >= 80 ? "bg-warning" : "bg-accent";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-text-base">{title}</span>
        <span className="text-text-muted">{Math.round(used)}% used</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-base">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${used}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
        <span>{Math.round(windowData?.remaining_percent ?? 100)}% remaining</span>
        <span>resets {resetLabel(windowData)}</span>
      </div>
    </div>
  );
}

export function InlineCodexQuota({ data, loading }: { data: CodexQuota | undefined; loading: boolean }) {
  if (loading) return <span className="text-[11px] text-text-muted">Checking quota…</span>;
  if (!data) return <span className="text-[11px] text-text-muted">Quota unavailable</span>;

  const windowData = data.secondary ?? data.primary;
  const used = Math.max(0, Math.min(100, windowData?.used_percent ?? 0));
  const remaining = Math.max(0, Math.min(100, windowData?.remaining_percent ?? 100));
  const color = used >= 100 ? "bg-danger" : used >= 80 ? "bg-warning" : "bg-accent";

  return (
    <div className="flex min-w-44 items-center gap-2" title={`${windowLabel(windowData, "Quota")}: ${Math.round(remaining)}% remaining, resets ${resetLabel(windowData)}`}>
      <span className="shrink-0 text-[11px] text-text-muted">{Math.round(remaining)}% left</span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-bg-base">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${used}%` }} />
      </div>
      <span className="truncate text-[11px] text-text-muted">resets {resetLabel(windowData)}</span>
    </div>
  );
}

function isCodeBuddyQuota(data: CodexQuota | undefined, account: ProviderAccount): data is CodexQuota & {
  plan?: string | null;
  quotas?: {
    Credits?: {
      used?: number;
      total?: number;
      remaining?: number;
      remainingPercentage?: number;
      resetAt?: string | null;
    };
  } | null;
} {
  return !!data && (account.label.toLowerCase().includes("codebuddy") || "quotas" in data || "plan" in data);
}

function fmtQuotaReset(resetAt: string | null | undefined): string {
  if (!resetAt) return "—";
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return resetAt;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function quotaTitle(account: ProviderAccount, resolved = false): string {
  if (!resolved) return "Loading quota checker";
  if (account.provider_type === "codebuddy-cn") return "CodeBuddy China quota";
  if (account.provider_type === "codebuddy-global") return "CodeBuddy Global quota";
  return "ChatGPT / Codex quota";
}

function CodeBuddyQuotaCard({ data }: {
  data: {
    plan?: string | null;
    quotas?: {
      Credits?: {
        used?: number;
        total?: number;
        remaining?: number;
        remainingPercentage?: number;
        resetAt?: string | null;
      };
    } | null;
  };
}) {
  const credits = data.quotas?.Credits;
  const total = credits?.total ?? 0;
  const used = credits?.used ?? 0;
  const remaining = credits?.remaining ?? Math.max(0, total - used);
  const remainingPercentage = Math.max(0, Math.min(100, credits?.remainingPercentage ?? (total > 0 ? (remaining / total) * 100 : 0)));
  const usedPercentage = Math.max(0, Math.min(100, total > 0 ? 100 - remainingPercentage : 0));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <Badge>{data.plan ?? "CodeBuddy plan"}</Badge>
        <Badge tone="success">active</Badge>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium text-text-base">Credit quota</span>
          <span className="text-text-muted">{Math.round(usedPercentage)}% used</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-base">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${usedPercentage}%` }} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-text-muted">
          <div><div className="text-text-primary">{fmtNum(total)}</div><div>Total</div></div>
          <div><div className="text-text-primary">{fmtNum(used)}</div><div>Used</div></div>
          <div><div className="text-text-primary">{fmtNum(remaining)}</div><div>Remaining</div></div>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
          <span>{Math.round(remainingPercentage)}% remaining</span>
          <span>resets {fmtQuotaReset(credits?.resetAt)}</span>
        </div>
      </div>
    </div>
  );
}

export function CodexQuotaModal({ account, onClose }: { account: ProviderAccount; onClose: () => void }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const q = useQuery({
    queryKey: ["codex-quota", account.id],
    queryFn: () => providers.codexQuota(account.id),
    retry: 1,
  });
  const reset = useMutation({
    mutationFn: () => providers.codexQuotaReset(account.id),
    onSuccess: (result) => {
      toast(result.message || "Banked reset requested");
      void q.refetch();
    },
    onError: (error: Error) => toast(error.message, "error"),
  });
  const d: CodexQuota | undefined = q.data;
  const codeBuddy = isCodeBuddyQuota(d, account);
  const canReset = account.auth_kind === "oauth" && !codeBuddy;
  const bankedRemaining = d?.banked_resets?.remaining ?? 0;
  const bankedTotal = d?.banked_resets?.total;
  const bankedLabel = bankedTotal != null ? `${bankedRemaining}/${bankedTotal}` : `${bankedRemaining}`;

  return (
    <Modal open onClose={onClose} title={quotaTitle(account, !!d || q.isError)}>
      {q.isLoading && <div className="flex items-center gap-2 py-6 text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading quota checker…</div>}
      {q.isError && <p className="py-4 text-xs text-danger">{(q.error as Error).message}</p>}
      {d && (
        <div className="space-y-4">
          {codeBuddy ? <CodeBuddyQuotaCard data={d} /> : (
            <>
              <div className="flex items-center gap-2 text-xs">
                {d.plan_type && <Badge>{d.plan_type}</Badge>}
                {d.limit_reached ? <Badge tone="danger">limit reached</Badge> : <Badge tone="success">active</Badge>}
                {d.email && <span className="ml-auto text-text-muted">{d.email}</span>}
              </div>
              {d.secondary ? <QuotaBar title={windowLabel(d.secondary, "5-hour limit")} windowData={d.secondary} /> : <p className="text-[11px] text-text-muted">No 5-hour window for this plan.</p>}
              <QuotaBar title={windowLabel(d.primary, "Weekly limit")} windowData={d.primary} />
              <div className="rounded-lg bg-bg-base/50 px-3 py-2 text-xs text-text-muted">
                <div className="flex items-center justify-between gap-3">
                  <span>Banked reset quota</span>
                  <span className="font-medium text-text-primary">{bankedLabel}</span>
                </div>
              </div>
              {d.credits && (d.credits.has_credits || d.credits.unlimited) && (
                <div className="rounded-lg bg-bg-base/50 px-3 py-2 text-xs text-text-muted">
                  {d.credits.unlimited ? "Unlimited credits" : `Credit balance: ${d.credits.balance ?? "—"}`}
                </div>
              )}
            </>
          )}
          <div className="flex justify-end">
            <div className="flex gap-2">
              {canReset && (
                <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)} disabled={reset.isPending || bankedRemaining <= 0}>
                  {reset.isPending && <Loader2 size={13} className="animate-spin" />}
                  Banked reset ({bankedLabel})
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
                <RefreshCw size={13} className={q.isFetching ? "animate-spin" : ""} /> Refresh
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          reset.mutate();
        }}
        title="Reset OpenAI quota"
        message={`Do you want to reset quota for ${account.label}? Remaining banked reset quota: ${bankedLabel}.`}
        loading={reset.isPending}
      />
    </Modal>
  );
}
