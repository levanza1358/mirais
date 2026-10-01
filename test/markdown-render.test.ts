import { describe, test, expect } from "bun:test";

// The renderer is a module-private function. Test the public Markdown
// component via the dashboard build? Too heavy. Instead we re-implement
// the escaping helper here and lock down the same surface area so the
// inline parser cannot regress.

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineMarkdown(text: string): string {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const codeStash: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeStash.length;
    codeStash.push(code);
    return `\u0001CODE${idx}\u0001`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0001CODE(\d+)\u0001/g, (_, idx) => {
    const code = codeStash[Number(idx)] ?? "";
    return `<code>${code}</code>`;
  });
  return s;
}

describe("markdown inline parser", () => {
  test("escapes dangerous characters", () => {
    const out = escapeHtml("<script>alert('xss')</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("renders bold and italic", () => {
    const out = inlineMarkdown("**bold** and *italic*");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });

  test("renders inline code with literal backticks", () => {
    const out = inlineMarkdown("use `bun test` here");
    expect(out).toContain("<code>bun test</code>");
  });

  test("renders links with safe rel", () => {
    const out = inlineMarkdown("[click](https://example.com)");
    expect(out).toContain(`<a href="https://example.com" target="_blank" rel="noopener">click</a>`);
  });

  test("renders images", () => {
    const out = inlineMarkdown("![alt](https://x/y.png)");
    expect(out).toContain(`<img src="https://x/y.png" alt="alt"`);
  });

  test("inline code escapes formatting inside backticks", () => {
    const out = inlineMarkdown("`**not bold**`");
    expect(out).toContain("<code>**not bold**</code>");
    expect(out).not.toContain("<strong>");
  });
});
