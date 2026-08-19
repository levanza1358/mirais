import { useEffect, useState } from "react";
import { Button, Input, Modal, Select } from "../../components/ui";
import type { ProviderModel } from "../../api";

const UNITS: Array<NonNullable<ProviderModel["credit_unit"]>> = ["token", "credit", "request", "image"];

/**
 * Set the per-model credit rate used to estimate usage cost. Providers that
 * report real credit consumption always win over this value; it is only a
 * fallback and is always labelled as an estimate in the logs.
 */
export function ModelCostModal({
  model,
  onClose,
  onSave,
  saving,
}: {
  model: ProviderModel | null;
  onClose: () => void;
  onSave: (patch: { creditRate: number | null; creditUnit: ProviderModel["credit_unit"] }) => void;
  saving: boolean;
}) {
  const [rate, setRate] = useState("");
  const [unit, setUnit] = useState<NonNullable<ProviderModel["credit_unit"]>>("credit");

  useEffect(() => {
    setRate(model?.credit_rate != null ? String(model.credit_rate) : "");
    setUnit(model?.credit_unit ?? "credit");
  }, [model]);

  const parsed = rate.trim() === "" ? null : Number(rate);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);

  return (
    <Modal open={model !== null} onClose={onClose} title={`Estimated cost — ${model?.model_id ?? ""}`}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Units consumed per 1,000 tokens</label>
          <Input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 0.012 — leave empty for unknown" />
          {invalid && <p className="mt-1 text-xs text-danger">Enter a non-negative number, or leave it empty.</p>}
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Unit</label>
          <Select value={unit} onChange={(e) => setUnit(e.target.value as NonNullable<ProviderModel["credit_unit"]>)} className="h-10 rounded-xl bg-bg-base">
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </div>
        <p className="text-xs text-text-muted">
          This is only used when the provider does not report real credit usage. Logs always mark such values as estimated.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={invalid || saving} loading={saving} onClick={() => onSave({ creditRate: parsed, creditUnit: parsed === null ? null : unit })}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
