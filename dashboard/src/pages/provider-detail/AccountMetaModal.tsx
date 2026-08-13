import { useState } from "react";
import type { ProviderAccount } from "../../api";
import { Button, Input, Modal } from "../../components/ui";

export function AccountMetaModal({ account, loading, onClose, onSave }: { account: ProviderAccount; loading: boolean; onClose: () => void; onSave: (notes: string, tags: string, sessionCookie: string) => void }) {
  const [notes, setNotes] = useState(account.notes ?? "");
  const [tags, setTags] = useState(account.tags ?? "");
  const [sessionCookie, setSessionCookie] = useState(account.session_cookie ?? "");

  return (
    <Modal open onClose={onClose} title={`Account metadata · ${account.label}`}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(notes, tags, sessionCookie); }} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Tags</label>
          <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="main, backup, cheap" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Notes</label>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none" placeholder="Internal notes" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Session cookie</label>
          <Input value={sessionCookie} onChange={(event) => setSessionCookie(event.target.value)} placeholder="Optional session cookie" />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
