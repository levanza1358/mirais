import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { providers } from "../../api";
import { Button, Input, Modal, Select, toast } from "../../components/ui";
import { TYPES } from "./types";

export function ProviderModal({ provider, onClose }: { provider: { id: string; name: string; base_url?: string | null; priority: number }; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: provider.name, baseUrl: provider.base_url ?? "", priority: provider.priority });
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => providers.update(provider.id, { name: form.name, baseUrl: form.baseUrl || null, priority: form.priority }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast("Provider updated");
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Edit provider">
      <form onSubmit={(e) => { e.preventDefault(); setError(""); save.mutate(); }} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Name</label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Base URL <span className="text-text-muted/50">(blank = default for type)</span></label>
          <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Priority <span className="text-text-muted/50">(lower = preferred)</span></label>
          <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export function NewProviderModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<{ name: string; type: typeof TYPES[number]; baseUrl: string; priority: number }>({ name: "", type: "openai", baseUrl: "", priority: 0 });
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => providers.create({ name: form.name, type: form.type, baseUrl: form.baseUrl || undefined, priority: form.priority }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast("Provider added");
      onClose();
      navigate(`/dashboard/providers/${p.id}`);
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Add provider">
      <form onSubmit={(e) => { e.preventDefault(); setError(""); save.mutate(); }} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Name</label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-openai" required />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Type</label>
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Base URL <span className="text-text-muted/50">(blank = default for type)</span></label>
          <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Priority <span className="text-text-muted/50">(lower = preferred)</span></label>
          <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Add provider</Button>
        </div>
      </form>
    </Modal>
  );
}
