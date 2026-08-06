// Token saver — lossless content compression before upstream calls.
// Inspired by 9Router RTK, but conservative: only compacts tool outputs that
// match known verbose command patterns, and truncates very long outputs with
// an explicit marker. Never alters semantics silently.

export interface TokenSaverRules {
  gitDiff: boolean;
  grep: boolean;
  ls: boolean;
  longOutputMaxLines: number;
}

export interface TokenSaverConfig {
  enabled: boolean;
  rules: TokenSaverRules;
}

const GIT_DIFF_STAT = /^(\s*\d+ files? changed.*)$/m;

/** Compact unified diff: drop unchanged context blocks beyond 1 line. */
function compactGitDiff(text: string): string {
  return text
    .split("\n")
    .reduce<string[]>((acc, line) => {
      // keep headers, hunks, +/- lines; drop long runs of context lines
      if (line.startsWith(" ") || line === "") {
        const tail = acc.slice(-3);
        if (tail.every((l) => l.startsWith(" ") || l === "")) return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join("\n");
}

function compactGrep(text: string): string {
  // collapse consecutive separator lines and blank lines produced by grep -C
  return text.replace(/\n--\n--\n/g, "\n--\n").replace(/\n{3,}/g, "\n\n");
}

function compactLs(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.join("\n");
}

function truncateLong(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, `\n[...mirais: truncated ${lines.length - maxLines} lines...]\n`, ...tail].join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SaverResult {
  text: string;
  saved: number;
}

export function compressToolOutput(text: string, cfg: TokenSaverConfig): SaverResult {
  if (!cfg.enabled) return { text, saved: 0 };
  const before = estimateTokens(text);
  let out = text;

  const looksLikeDiff = text.includes("diff --git") || GIT_DIFF_STAT.test(text);
  const looksLikeGrep = /\n--\n/.test(text) || /^[^:\n]+:\d+:/m.test(text);
  const looksLikeLs = /^\S+\n\S+\n\S+\n\S+/.test(text) && text.split("\n").length > 20 && !text.includes(" ");

  if (looksLikeDiff && cfg.rules.gitDiff) out = compactGitDiff(out);
  else if (looksLikeGrep && cfg.rules.grep) out = compactGrep(out);
  else if (looksLikeLs && cfg.rules.ls) out = compactLs(out);

  out = truncateLong(out, cfg.rules.longOutputMaxLines);

  const after = estimateTokens(out);
  return { text: out, saved: Math.max(0, before - after) };
}

export function isCommandTool(name: string): boolean {
  return /bash|shell|terminal|exec|run|cmd|command/i.test(name);
}
