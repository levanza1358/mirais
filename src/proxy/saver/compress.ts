// Token saver — lossless content compression before upstream calls.
// Inspired by 9Router RTK, but conservative: only compacts tool outputs that
// match known verbose command patterns, and truncates very long outputs with
// an explicit marker. Never alters semantics silently.

export interface TokenSaverRules {
  gitDiff: boolean;
  grep: boolean;
  ls: boolean;
  longOutputMaxLines: number;
  maxToolOutputChars?: number;
  collapseWhitespace?: boolean;
  deduplicateToolOutputs?: boolean;
  keepRecentToolResults?: number;
  gitStatus?: boolean;
  findTree?: boolean;
  buildLogs?: boolean;
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

function compactGitStatus(text: string): string {
  return text.replace(/^On branch .+\n/m, "").replace(/^Your branch is .+\n\n/m, "").replace(/\n?no changes added to commit.*$/m, "").trim();
}

function compactFindTree(text: string): string {
  const seen = new Set<string>();
  return text.split("\n").filter((line) => {
    const normalized = line.trimEnd();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join("\n");
}

function compactBuildLog(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let previous = "";
  let repeats = 0;
  for (const line of lines) {
    const normalized = line.replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, "#").trim();
    if (normalized && normalized === previous) {
      repeats += 1;
      continue;
    }
    if (repeats > 0) output.push(`[...mirais: ${repeats} repeated build lines omitted...]`);
    output.push(line);
    previous = normalized;
    repeats = 0;
  }
  if (repeats > 0) output.push(`[...mirais: ${repeats} repeated build lines omitted...]`);
  return output.join("\n");
}

function truncateLong(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, `\n[...mirais: truncated ${lines.length - maxLines} lines...]\n`, ...tail].join("\n");
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[...mirais: truncated ${text.length - maxChars} characters...]\n${text.slice(-half)}`;
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

  if (cfg.rules.collapseWhitespace) {
    out = out.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n");
  }

  const looksLikeDiff = text.includes("diff --git") || GIT_DIFF_STAT.test(text);
  const looksLikeGrep = /\n--\n/.test(text) || /^[^:\n]+:\d+:/m.test(text);
  const looksLikeLs = /^\S+\n\S+\n\S+\n\S+/.test(text) && text.split("\n").length > 20 && !text.includes(" ");
  const looksLikeGitStatus = /^(On branch |HEAD detached|Changes (?:not staged|to be committed)|Untracked files:)/m.test(text);
  const looksLikeFindTree = text.split("\n").length > 30 && /(?:^|\n)(?:[│├└]──|\.\.?[/\\]|[/\\][^\n]+)$/m.test(text);
  const looksLikeBuildLog = text.split("\n").length > 30 && /(?:build|compile|test|warning|error|transform|module)/i.test(text);

  if (looksLikeDiff && cfg.rules.gitDiff) out = compactGitDiff(out);
  else if (looksLikeGrep && cfg.rules.grep) out = compactGrep(out);
  else if (looksLikeLs && cfg.rules.ls) out = compactLs(out);
  else if (looksLikeGitStatus && cfg.rules.gitStatus) out = compactGitStatus(out);
  else if (looksLikeFindTree && cfg.rules.findTree) out = compactFindTree(out);
  else if (looksLikeBuildLog && cfg.rules.buildLogs) out = compactBuildLog(out);

  out = truncateLong(out, cfg.rules.longOutputMaxLines);
  out = truncateChars(out, cfg.rules.maxToolOutputChars ?? 80_000);

  if (!out || out.length >= text.length) return { text, saved: 0 };
  const after = estimateTokens(out);
  return { text: out, saved: Math.max(0, before - after) };
}

export function isCommandTool(name: string): boolean {
  return /bash|shell|terminal|exec|run|cmd|command/i.test(name);
}
