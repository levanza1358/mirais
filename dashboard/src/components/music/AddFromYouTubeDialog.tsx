import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Loader2, Play, Plus, X } from "lucide-react";
import { music, youtube, type MusicPlaylist, type YouTubeSearchResult } from "../../api";
import { Button, Card, Input, Modal, Skeleton, toast } from "../ui";

interface AddFromYouTubeDialogProps {
  open: boolean;
  onClose: () => void;
  /** Optional playlist to add imported tracks to. */
  playlistId?: string;
}

export function AddFromYouTubeDialog({ open, onClose, playlistId }: AddFromYouTubeDialogProps) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => { if (!open) { setQuery(""); setDebouncedQuery(""); } }, [open]);

  const search = useQuery({
    queryKey: ["youtube-search", debouncedQuery],
    queryFn: () => youtube.search(debouncedQuery, 1),
    enabled: debouncedQuery.length > 0,
  });

  const playlists = useQuery({ queryKey: ["music-playlists"], queryFn: music.listPlaylists, enabled: open });
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(playlistId ?? null);
  useEffect(() => { setSelectedPlaylist(playlistId ?? null); }, [playlistId, open]);

  const importTrack = useMutation({
    mutationFn: (video: YouTubeSearchResult) =>
      youtube.import({ video_id: video.id, playlist_id: selectedPlaylist ?? undefined }),
    onSuccess: (track) => {
      qc.invalidateQueries({ queryKey: ["music-tracks"] });
      if (playlistId) qc.invalidateQueries({ queryKey: ["music-playlists", playlistId] });
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      toast(`Added "${track.title}"${selectedPlaylist ? " to playlist" : ""}`);
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const results = useMemo(() => {
    const payload = search.data;
    return payload && "items" in payload ? payload.items : [];
  }, [search.data]);

  return (
    <Modal open={open} onClose={onClose} title="Add from YouTube" wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-2.5 text-text-muted" />
            <Input
              className="pl-9"
              placeholder="Search YouTube"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </label>
          <select
            className="h-9 rounded-md border border-border bg-bg-base px-2 text-sm"
            value={selectedPlaylist ?? ""}
            onChange={(event) => setSelectedPlaylist(event.target.value || null)}
            aria-label="Add to playlist"
          >
            <option value="">Library only</option>
            {(playlists.data ?? []).map((p: MusicPlaylist) => (
              <option key={p.id} value={p.id}>Add to: {p.name}</option>
            ))}
          </select>
        </div>

        {debouncedQuery.length === 0 ? (
          <p className="text-xs text-text-muted">Type at least one character to search.</p>
        ) : search.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : search.isError ? (
          <Card>
            <p className="text-sm text-danger">Search failed: {(search.error as Error | undefined)?.message ?? "unknown error"}</p>
          </Card>
        ) : results.length === 0 ? (
          <p className="text-xs text-text-muted">No results.</p>
        ) : (
          <ul className="max-h-[420px] divide-y divide-border/60 overflow-y-auto">
            {results.map((video) => (
              <li key={video.id} className="flex items-center gap-3 py-2">
                {video.thumbnail_url ? (
                  <img src={video.thumbnail_url} alt="" className="h-12 w-20 shrink-0 rounded-md object-cover" />
                ) : (
                  <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md bg-bg-raised text-text-muted">
                    <Play size={16} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{video.title}</p>
                  <p className="truncate text-xs text-text-muted">
                    {video.author}
                    {video.duration_sec ? ` · ${formatSeconds(video.duration_sec)}` : ""}
                  </p>
                </div>
                <Button
                  size="icon"
                  onClick={() => importTrack.mutate(video)}
                  disabled={importTrack.isPending && importTrack.variables?.id === video.id}
                  loading={importTrack.isPending && importTrack.variables?.id === video.id}
                  aria-label={`Add ${video.title} to library`}
                  title="Add to library"
                >
                  {!importTrack.isPending && <Plus size={14} />}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {importTrack.isPending && (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Importing…
          </div>
        )}

        <p className="flex items-center gap-1.5 text-[10px] text-text-muted">
          <X size={10} /> Search + streaming are proxied via the configured Invidious instances. Configure
          them under Settings → Music.
        </p>
      </div>
    </Modal>
  );
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}