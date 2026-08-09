import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ListChecks, Loader2, Plus, RefreshCw, Trash2, XCircle, Zap } from "lucide-react";
import { type Provider, providers } from "../../api";
import { Button, Card, ConfirmModal, Modal, toast } from "../../components/ui";
// Labels show the full model id (no alias shortening).
import { AddCustomModelModal } from "./AddCustomModelModal";
import type { ModelTestResult } from "./types";

function fmtCtx(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function parseCaps(caps: string | null): string[] {
  if (!caps) return [];
  try { return JSON.parse(caps) as string[]; } catch { return []; }
}

const CAP_STYLE: Record<string, { label: string; className: string }> = {
  reasoning: { label: "Reasoning", className: "border-accent/40 text-accent" },
  vision: { label: "Vision", className: "border-success/40 text-success" },
  pdf: { label: "PDF", className: "border-warning/40 text-warning" },
  tools: { label: "Tools", className: "border-border text-text-muted" },
  json: { label: "JSON", className: "border-border text-text-muted" },
};

export function ModelsCard({ provider: p }: { provider: Provider }) {
  const qc = useQueryClient();
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testAllPrompt, setTestAllPrompt] = useState(false);
  const [addCustomOpen, setAddCustomOpen] = useState(false);
  const [deleteAllPrompt, setDeleteAllPrompt] = useState(false);
  const modelsQuery = useQuery({ queryKey: ["providers", p.id, "models"], queryFn: () => providers.models(p.id) });
  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["providers"] }),
    qc.invalidateQueries({ queryKey: ["providers", p.id, "models"] }),
  ]);
  const models = modelsQuery.data ?? [];

  async function testOne(modelId: string): Promise<ModelTestResult> {
    setResults((r) => ({ ...r, [modelId]: { ok: false, latency_ms: 0, testing: true } }));
    try {
      const res = await providers.testModel(p.id, modelId);
      const out: ModelTestResult = {
        ok: res.ok,
        latency_ms: res.latency_ms,
        detail: res.detail,
        preview_text: res.preview_text,
        context_length: res.context_length,
        max_output_tokens: res.max_output_tokens,
        capabilities: res.capabilities,
      };
      setResults((r) => ({ ...r, [modelId]: out }));
      const modelLabel = modelId;
      if (res.ok) {
        toast(res.preview_text?.trim() || `${modelLabel} responded in ${res.latency_ms}ms`, "success", { title: `Model: ${modelLabel}` });
      } else {
        toast(`Test failed: ${res.detail ?? `HTTP ${res.status}`}`, "error", { title: `Model: ${modelLabel}` });
      }
      return out;
    } catch (err) {
      const out: ModelTestResult = { ok: false, latency_ms: 0, detail: err instanceof Error ? err.message : String(err) };
      setResults((r) => ({ ...r, [modelId]: out }));
      toast(`Test failed: ${out.detail ?? "Unknown error"}`, "error", { title: `Model: ${modelId}` });
      return out;
    }
  }

  async function testAll(deleteErrors: boolean) {
    setTestAllPrompt(false);
    setTestingAll(true);
    const failed: string[] = [];
    try {
      for (const m of models) {
        // eslint-disable-next-line no-await-in-loop
        const r = await testOne(m.model_id);
        if (!r.ok) failed.push(m.model_id);
      }
      const okCount = models.length - failed.length;
      if (deleteErrors && failed.length > 0) {
        for (const id of failed) {
          // eslint-disable-next-line no-await-in-loop
          await providers.removeModel(p.id, id).catch(() => {});
        }
        invalidate();
        toast(`Tested ${models.length} models — removed ${failed.length} failing, ${okCount} working`, "success");
      } else {
        toast(`Tested ${models.length} models — ${okCount} ok, ${failed.length} failed`, failed.length ? "error" : "success");
      }
    } finally {
      setTestingAll(false);
    }
  }

  const fetchModels = useMutation({
    mutationFn: () => providers.sync(p.id),
    onSuccess: (r) => { invalidate(); toast(`Fetched ${r.synced} models from ${p.name}`); },
    onError: (e) => toast(e.message, "error"),
  });

  const autoFetched = useRef(false);
  useEffect(() => {
    if (autoFetched.current) return;
    const hasAccount = (p.accounts ?? []).some((a) => a.enabled);
    if (hasAccount && models.length === 0) {
      autoFetched.current = true;
      fetchModels.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.accounts, models.length]);

  const addModel = useMutation({
    mutationFn: (payload: { modelId: string; patch?: Partial<{ contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null }> }) =>
      providers.upsertModel(p.id, payload.modelId, {
        contextLength: payload.patch?.contextLength ?? null,
        maxOutputTokens: payload.patch?.maxOutputTokens ?? null,
        capabilities: payload.patch?.capabilities ?? null,
      }),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const toggleModel = useMutation({
    mutationFn: (m: { model_id: string; enabled: number }) => providers.upsertModel(p.id, m.model_id, { enabled: !m.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const removeModel = useMutation({
    mutationFn: (modelId: string) => providers.removeModel(p.id, modelId),
    onSuccess: invalidate,
    onError: (e) => toast(e.message, "error"),
  });

  const removeAllModels = useMutation({
    mutationFn: (modelIds: string[]) => providers.removeAllModels(p.id, modelIds),
    onSuccess: () => {
      invalidate();
      setDeleteAllPrompt(false);
      toast(`Removed all models from ${p.name}`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks size={15} className="text-success" />
          <h2 className="text-sm font-semibold">Models</h2>
          <span className="text-xs text-text-muted">{models.filter((m) => m.enabled).length} active · {models.filter((m) => !m.enabled).length} disabled</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" loading={fetchModels.isPending} onClick={() => fetchModels.mutate()} title="Fetch all models from the provider API"><RefreshCw size={13} /> Fetch models</Button>
          <Button variant="outline" size="sm" loading={testingAll} disabled={models.length === 0} onClick={() => setTestAllPrompt(true)} title="Send a tiny test request to every model"><Zap size={13} /> Test all</Button>
          <Button variant="ghost" size="sm" onClick={() => setAddCustomOpen(true)} aria-label="Add custom model" title="Add custom model"><Plus size={14} /> Add custom model</Button>
          <Button variant="danger" size="sm" disabled={models.length === 0 || removeAllModels.isPending} loading={removeAllModels.isPending} onClick={() => setDeleteAllPrompt(true)} title="Delete all registered models for this provider"><Trash2 size={14} /> Delete all</Button>
        </div>
      </div>

      {modelsQuery.isError ? <p className="py-4 text-center text-xs text-danger">Failed to load provider models.</p> : modelsQuery.isLoading ? (
        <p className="py-4 text-center text-xs text-text-muted">Loading models…</p>
      ) : models.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{fetchModels.isPending ? "Fetching models from the provider…" : "No models registered. Press Fetch models to pull the full list from the provider."}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {models.map((m) => {
            const r = results[m.model_id];
            const modelLabel = m.model_id;
            const caps = parseCaps(m.capabilities);
            const meta: string[] = [];
            if (m.context_length) meta.push(`Context: ${m.context_length.toLocaleString()} tokens`);
            if (m.max_output_tokens) meta.push(`Max output: ${m.max_output_tokens.toLocaleString()} tokens`);
            if (caps.length) meta.push(`Supports: ${caps.join(", ")}`);
            const testLine = r?.testing ? "Testing…" : r ? (r.ok ? `${r.preview_text ?? `Test: OK · ${r.latency_ms}ms`}` : `Test failed: ${r.detail ?? "error"}`) : null;
            const tip = [modelLabel, m.model_id !== modelLabel ? m.model_id : null, ...meta, testLine].filter(Boolean).join("\n");
            return (
              <span key={m.id} title={tip} className={`group inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${m.enabled ? "bg-bg-raised" : "bg-bg-raised/40 text-text-muted/60 line-through"}`}>
                {r && (r.testing ? <Loader2 size={11} className="animate-spin text-text-muted" /> : r.ok ? <CheckCircle2 size={11} className="text-success" /> : <XCircle size={11} className="text-danger" />)}
                <button onClick={() => toggleModel.mutate(m)} className="hover:text-accent" title={m.enabled ? "Disable" : "Enable"}>{modelLabel}</button>
                {(m.context_length != null || m.max_output_tokens != null) && <span className="text-[10px] text-text-muted/70">{m.context_length != null && `${fmtCtx(m.context_length)} ctx`}{m.context_length != null && m.max_output_tokens != null && " · "}{m.max_output_tokens != null && `${fmtCtx(m.max_output_tokens)} out`}</span>}
                {caps.map((c) => {
                  const style = CAP_STYLE[c] ?? { label: c, className: "border-border text-text-muted" };
                  return <span key={c} className={`rounded border px-1 text-[9px] leading-3 ${style.className}`}>{style.label}</span>;
                })}
                {r && !r.testing && <span className={r.ok ? "text-success/80" : "text-danger/80"}>{r.ok ? `${r.latency_ms}ms` : "✗"}</span>}
                <button onClick={() => testOne(m.model_id)} disabled={r?.testing || testingAll} className="text-text-muted/40 hover:text-accent disabled:opacity-40" aria-label={`Test ${m.model_id}`} title="Test this model"><Zap size={11} /></button>
                <button onClick={() => removeModel.mutate(m.model_id)} className="text-text-muted/40 hover:text-danger" aria-label={`Remove ${m.model_id}`}><Trash2 size={11} /></button>
              </span>
            );
          })}
        </div>
      )}

      <Modal open={testAllPrompt} onClose={() => setTestAllPrompt(false)} title="Test all models">
        <p className="mb-4 text-xs text-text-muted">Send a tiny test request to all <strong className="text-text-primary">{models.length}</strong> models of <strong className="text-text-primary">{p.name}</strong>, one by one. What should happen to models that fail?</p>
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={() => testAll(false)}><Zap size={14} /> Test all models only</Button>
          <Button variant="danger" onClick={() => testAll(true)}><Trash2 size={14} /> Test all &amp; delete error models</Button>
          <Button variant="ghost" onClick={() => setTestAllPrompt(false)}>Cancel</Button>
        </div>
      </Modal>

      <ConfirmModal open={deleteAllPrompt} onClose={() => setDeleteAllPrompt(false)} onConfirm={() => removeAllModels.mutate(models.map((m) => m.model_id))} title="Delete all models" message={`Delete all ${models.length} models from ${p.name}? This only clears the local model list for this provider.`} danger loading={removeAllModels.isPending} />

      <AddCustomModelModal
        open={addCustomOpen}
        onClose={() => setAddCustomOpen(false)}
        onTest={testOne}
        onSave={(modelId, testResult) => addModel.mutate({
          modelId,
          patch: {
            contextLength: testResult.context_length ?? null,
            maxOutputTokens: testResult.max_output_tokens ?? null,
            capabilities: testResult.capabilities ?? null,
          },
        }, { onSuccess: () => { toast(`Added custom model ${modelId}`); setAddCustomOpen(false); } })}
        saving={addModel.isPending}
      />
    </Card>
  );
}
