/**
 * Route-level loading screen. Mirrors the inline boot splash in index.html so
 * navigating into the dashboard (lazy chunks, auth check) looks continuous
 * instead of flashing a bare "Loading…" line.
 */
export function Splash({ label }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      <img src="/icon.png" alt="" className="size-14 rounded-xl anim-pulse-slow" />
      <span className="block h-0.5 w-24 overflow-hidden rounded-full bg-foreground/10">
        <span className="block h-full w-2/5 rounded-full bg-accent anim-slide-track" />
      </span>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}
