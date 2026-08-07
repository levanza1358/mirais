import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, FileJson, Plug, ShieldCheck } from "lucide-react";
import { integrations, type IntegrationCli } from "../api";
import { Button, Card, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { keys } from "../api";
import { labelForProvider } from "../utils/modelLabels";

export default function Integrations() {
  const catalog = useQuery({ queryKey: ["integrations-catalog"], queryFn: integrations.catalog });
  const keyList = useQuery({ queryKey: ["keys"], queryFn: keys.list });
  const [selectedCli, setSelectedCli] = useState<IntegrationCli["id"]>("opencode");
  const [model, setModel] = useState("");
  const [applied, setApplied] = useState<{ cli: string; path: string; backup: string | null } | null>(null);

  const models = catalog.data?.models ?? [];
  const selected = catalog.data?.clis.find((cli) => cli.id === selectedCli);
  const firstModel = models[0]?.id ?? "";
  const effectiveModel = model || firstModel;
  const primary = keyList.data?.[0];
  const apply = useMutation({
    mutationFn: async () => {
      if (!primary) throw new Error("No gateway key available. Create one in Keys first.");
      // Rotate the primary key to get a new plaintext (only available at rotation time)
      const rotated = await keys.rotate(primary.id);
      if (!rotated.plaintext) throw new Error("Failed to rotate key");
      return integrations.apply({ cli: selectedCli, model: effectiveModel, apiKey: rotated.plaintext });
    },
    onSuccess: (result) => {
      setApplied(result);
      toast(`${result.cli} configuration applied`);
    },
    onError: (error) => toast(error.message, "error"),
  });

  const preview = useMemo(() => {
    if (!selected || !effectiveModel) return "Select a CLI and model to preview the integration.";
    return `${selected.name}\nConfig: ${selected.configPath}\nBase URL: ${catalog.data?.baseUrl ?? "http://127.0.0.1:1463"}\nModel: ${effectiveModel}\n\nExisting config will be backed up before Apply.`;
  }, [catalog.data?.baseUrl, effectiveModel, selected]);

  if (catalog.isLoading) return <Skeleton className="h-64 w-full" />;
  if (catalog.isError || !catalog.data) return <p className="text-danger">Unable to load CLI integrations.</p>;

  return (
    <div>
      <PageHeader title="Integrations">
        <span className="rounded-full border border-success/20 bg-success/10 px-3 py-1.5 text-xs text-success">Dynamic model catalog</span>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <div className="space-y-4">
          <Card>
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent/15 text-accent"><Plug size={18} /></div>
              <div>
                <h2 className="font-semibold">Connect a CLI to Mirais</h2>
                <p className="mt-1 text-sm text-text-muted">Choose a CLI and any active Mirais model. The CLI will route through the gateway.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {catalog.data.clis.map((cli) => (
                <button key={cli.id} type="button" onClick={() => setSelectedCli(cli.id)} className={`rounded-2xl border p-4 text-left transition ${selectedCli === cli.id ? "border-accent bg-accent/10" : "border-border bg-bg-base/40 hover:border-accent/40"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{cli.name}</span>
                    <span className={`text-[11px] ${cli.detected ? "text-success" : "text-warning"}`}>{cli.detected ? `Installed${cli.configExists ? " · config found" : " · config new"}` : "Not installed"}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-text-muted">{cli.note}</p>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <div className="mb-4 flex items-center gap-2"><FileJson size={16} className="text-accent" /><h2 className="font-semibold">Integration settings</h2></div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-text-muted">Model from Mirais catalog</label>
                <select value={effectiveModel} onChange={(event) => setModel(event.target.value)} className="h-10 w-full rounded-xl border border-border bg-bg-base px-3 text-sm text-text-primary outline-none focus:border-accent">
                  <option value="" disabled>Select a model</option>
                  {models.map((entry) => <option key={`${entry.providerType}:${entry.id}`} value={entry.id}>{labelForProvider(entry.provider, entry.id)}</option>)}
                </select>
                {!models.length && <p className="mt-2 text-xs text-warning">No enabled models are available in Mirais.</p>}
              </div>
              <div className="rounded-2xl border border-border bg-bg-base/40 p-3 text-xs text-text-muted">
                Mirais gateway key will be selected automatically. {primary ? "A key is available." : "No gateway keys configured. Create one in Keys first."}
              </div>
              <div className="rounded-2xl border border-success/20 bg-success/5 p-3 text-xs text-text-muted"><ShieldCheck size={15} className="mr-2 inline text-success" />Existing files are backed up automatically before Apply.</div>
              {!selected?.detected && <p className="text-xs text-warning">Install {selected?.name ?? "this CLI"} and ensure its command is available on PATH before applying.</p>}
              <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!selected?.detected || !effectiveModel || !primary}><Check size={15} /> Apply to {selected?.name ?? "CLI"}</Button>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Preview</h2><Copy size={15} className="text-text-muted" /></div>
            <pre className="min-h-40 whitespace-pre-wrap rounded-2xl border border-border bg-bg-base p-4 font-mono text-xs leading-6 text-text-muted">{preview}</pre>
          </Card>
          <Card>
            <h2 className="font-semibold">Selected CLI</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3"><span className="text-text-muted">Name</span><span>{selected?.name}</span></div>
              <div className="flex justify-between gap-3"><span className="text-text-muted">Command</span><code className="text-xs text-accent">{selected?.command ?? "Not found on PATH"}</code></div>
              <div className="flex justify-between gap-3"><span className="text-text-muted">Config path</span><code className="max-w-[65%] truncate text-right text-xs text-accent">{selected?.configPath}</code></div>
              <p className="pt-2 text-xs leading-5 text-text-muted">This first version writes a complete integration config. It does not claim that a CLI supports models it hardcodes internally; the selected model is passed through its custom provider configuration.</p>
            </div>
          </Card>
          {applied && <Card className="border-success/20 bg-success/5"><h2 className="font-semibold text-success">Applied successfully</h2><p className="mt-2 text-xs text-text-muted">{applied.cli} config saved at <code>{applied.path}</code>.</p>{applied.backup && <p className="mt-1 text-xs text-text-muted">Backup created at <code>{applied.backup}</code>.</p>}<a className="mt-3 inline-flex items-center gap-1 text-xs text-accent underline" href="/integrations"><ExternalLink size={13} /> Refresh integration page</a></Card>}
        </div>
      </div>
    </div>
  );
}

