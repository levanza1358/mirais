import { PageHeader } from "../components/Layout";
import { XaiImapSection } from "./Settings";

export default function XaiImap() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="XAI IMAP"
      >
        <p className="text-sm text-text-muted">Configure the inbox used to receive xAI account verification codes.</p>
      </PageHeader>
      <XaiImapSection />
    </div>
  );
}