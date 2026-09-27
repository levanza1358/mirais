export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Position is in milliseconds. */
export function formatPosition(positionMs: number, durationMs: number): { elapsed: string; remaining: string } {
  const elapsed = formatDuration(positionMs / 1000);
  const remaining = durationMs > 0 ? `-${formatDuration((durationMs - positionMs) / 1000)}` : "0:00";
  return { elapsed, remaining };
}