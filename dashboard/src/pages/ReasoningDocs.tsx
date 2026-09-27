import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Card, Skeleton } from "../components/ui";
import { PageHeader } from "../components/Layout";

interface Section {
  level: number;
  text: string;
  id: string;
}

/**
 * Render the reasoning guide as Markdown served by Mirais itself.
 *
 * The page intentionally uses a tiny Markdown renderer (no third-party
 * dependency). It's enough for the headings/lists/tables/code blocks the
 * reasoning guide uses and keeps the dashboard bundle small.
 */
export default function ReasoningDocs() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/docs/09-reasoning.md")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((body) => { if (!cancelled) setMarkdown(body); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reasoning guide"
        subtitle="How Mirais translates the universal reasoning block for every supported upstream."
      >
        <a
          href="/docs/09-reasoning.md"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
        >
          <ExternalLink size={13} /> Open raw Markdown
        </a>
      </PageHeader>

      {error ? (
        <Card>
          <p className="text-sm text-danger">Failed to load the reasoning guide: {error}</p>
        </Card>
      ) : markdown === null ? (
        <Card><Skeleton className="h-72 w-full" /></Card>
      ) : (
        <Card>
          <article className="prose prose-invert max-w-none text-sm leading-6">
            <RenderedMarkdown markdown={markdown} />
          </article>
        </Card>
      )}
    </div>
  );
}

function RenderedMarkdown({ markdown }: { markdown: string }) {
  const blocks = splitBlocks(markdown);
  return (
    <>
      {blocks.map((block, index) => (
        <RenderBlock key={index} block={block} />
      ))}
    </>
  );
}

interface Block {
  kind: "heading" | "paragraph" | "list" | "code" | "table" | "rule";
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  text?: string;
  items?: string[];
  language?: string;
  rows?: string[][];
}

function splitBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i += 1; continue; }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = lines[i]!.split("|").slice(1, -1).map((cell) => cell.trim());
        if (!/^[-:\s|]+$/.test(lines[i]!)) rows.push(cells);
        i += 1;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      const level = Number(line.match(/^#+/)?.[0].length ?? 1) as Block["level"];
      blocks.push({ kind: "heading", level, text: line.replace(/^#+\s*/, "") });
      i += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (/^```/.test(line)) {
      const language = line.replace(/^```/, "").trim();
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) { buffer.push(lines[i]!); i += 1; }
      i += 1;
      blocks.push({ kind: "code", language, text: buffer.join("\n") });
      continue;
    }
    if (/^---$/.test(line.trim())) { blocks.push({ kind: "rule" }); i += 1; continue; }
    const buffer: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6} |[-*] |\||```)/.test(lines[i]!)) {
      buffer.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: buffer.join(" ") });
  }
  return blocks;
}

function RenderBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level ?? 2}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const className = block.level === 1
        ? "text-2xl font-semibold mt-8 mb-4"
        : block.level === 2
          ? "text-xl font-semibold mt-8 mb-3 flex items-center gap-2"
          : "text-base font-semibold mt-6 mb-2 text-text-primary";
      const id = block.text ?? "";
      return <Tag id={slug(id)} className={className}>{inlineRender(block.text ?? "")}</Tag>;
    }
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5 marker:text-text-muted">
          {block.items?.map((item, index) => <li key={index}>{inlineRender(item)}</li>)}
        </ul>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg border border-border bg-bg-base p-3 text-xs">
          <code className={`font-mono text-text-primary ${block.language ? `language-${block.language}` : ""}`}>{block.text}</code>
        </pre>
      );
    case "table":
      if (!block.rows?.length) return null;
      const header = block.rows[0];
      const body = block.rows.slice(1);
      return (
        <div className="overflow-x-auto my-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                {header?.map((cell, index) => <th key={index} className="px-2 py-1.5 font-medium">{inlineRender(cell)}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border/60">
                  {row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1.5 align-top">{inlineRender(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="my-6 border-border/60" />;
    default:
      return <p className="my-3 text-text-primary">{inlineRender(block.text ?? "")}</p>;
  }
}

function inlineRender(text: string): React.ReactNode {
  const segments: React.ReactNode[] = [];
  let remaining = text;
  let depth = 0;
  const inlineRegex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push(text.slice(lastIndex, match.index));
    const [whole] = match;
    if (whole.startsWith("`")) segments.push(<code key={`c${depth++}`} className="rounded bg-bg-raised px-1 font-mono text-[11px]">{whole.slice(1, -1)}</code>);
    else if (whole.startsWith("**")) segments.push(<strong key={`b${depth++}`}>{whole.slice(2, -2)}</strong>);
    else if (whole.startsWith("[")) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(whole);
      if (linkMatch) segments.push(<a key={`a${depth++}`} href={linkMatch[2]} target="_blank" rel="noreferrer" className="text-accent underline">{linkMatch[1]}</a>);
      else segments.push(whole);
    } else segments.push(whole);
    lastIndex = match.index + whole.length;
    remaining = text.slice(lastIndex);
  }
  if (remaining) segments.push(remaining);
  return <>{segments}</>;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}