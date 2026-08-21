import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { Badge, Button, Input, Modal } from "../../components/ui";
import type { ModelTestResult } from "./types";

export function AddCustomModelModal({
  open,
  onClose,
  onTest,
  onSave,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onTest: (modelId: string) => Promise<ModelTestResult>;
  onSave: (modelId: string, testResult: ModelTestResult) => void;
  saving: boolean;
}) {
  const [modelId, setModelId] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ModelTestResult | null>(null);

  useEffect(() => {
    if (!open) {
      setModelId("");
      setTesting(false);
      setResult(null);
    }
  }, [open]);

  async function handleTest() {
    const trimmed = modelId.trim();
    if (!trimmed) return;
    setTesting(true);
    try {
      setModelId(trimmed);
      const out = await onTest(trimmed);
      setResult(out);
    } finally {
      setTesting(false);
    }
  }

  const caps = result?.capabilities ?? [];

  return (
    <Modal open={open} onClose={onClose} title="Add custom model">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Name model</label>
          <Input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="e.g. kimi-k3 or gpt-5.4" />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleTest} loading={testing} disabled={!modelId.trim()}>
            <Zap size={14} /> Test model
          </Button>
          <Button onClick={() => result && onSave(modelId.trim(), result)} disabled={!result?.ok || saving} loading={saving}>Save model</Button>
        </div>

        {result && (
          <div className="rounded-xl border border-border bg-bg-raised/60 p-3 text-xs">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className={result.ok ? "text-success" : "text-danger"}>{result.ok ? "Test passed" : `Test failed: ${result.detail ?? "error"}`}</span>
              <span className="text-text-muted">{result.latency_ms}ms</span>
            </div>
            {result.preview_text && <p className="mb-3 text-text-muted">{result.preview_text}</p>}
            {result.ok && (
              <div className="space-y-2">
                <div className="text-text-muted">
                  Context: <span className="text-text-primary">{result.context_length?.toLocaleString() ?? "Unknown"}</span>
                  {" · "}
                  Max output: <span className="text-text-primary">{result.max_output_tokens?.toLocaleString() ?? "Unknown"}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(["reasoning", "tools", "json", "vision"] as const).map((cap) => (
                    <Badge key={cap} tone={caps.includes(cap) ? "success" : "muted"}>{cap}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
