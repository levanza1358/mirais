import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronUp, ChevronDown, Music2, Play, Plus, Trash2 } from "lucide-react";
import { music } from "../api";
import { Button, Card, EmptyState, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { UploadButton } from "../components/music/UploadButton";
import { usePlayer } from "../components/music/usePlayer";

export default function MusicPlaylistDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const playlist = useQuery({
    queryKey: ["music-playlists", id],
    queryFn: () => music.getPlaylist(id!),
    enabled: !!id,
  });
  const allTracks = useQuery({ queryKey: ["music-tracks", ""], queryFn: () => music.listTracks({ limit: 200 }) });
  const setQueue = usePlayer((s) => s.setQueue);
  const [adding, setAdding] = useState(false);

  const removeTrack = useMutation({
    mutationFn: (trackId: string) => music.removePlaylistTrack(id!, trackId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["music-playlists", id] }),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const reorder = useMutation({
    mutationFn: (tracks: Array<{ track_id: string }>) =>
      music.updatePlaylist(id!, { tracks }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["music-playlists", id] }),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const addTrack = useMutation({
    mutationFn: (trackId: string) => music.addPlaylistTrack(id!, trackId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-playlists", id] });
      setAdding(false);
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  if (!id) return null;
  if (playlist.isLoading) return <Skeleton className="h-32 w-full" />;
  if (!playlist.data) return <EmptyState icon={<Music2 size={28} />} title="Playlist not found" />;

  const tracks = playlist.data.tracks;
  const playAll = () => setQueue(tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration_sec: t.duration_sec,
    mime_type: t.mime_type,
    size_bytes: t.size_bytes,
    source_type: t.source_type,
    storage_path: t.storage_path,
    source_url: t.source_url,
    thumbnail_url: t.thumbnail_url,
    created_at: t.created_at,
    updated_at: t.updated_at,
  })));
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    reorder.mutate(next.map((t) => ({ track_id: t.id })));
  };

  return (
    <div className="space-y-6 pb-32">
      <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/music")}>
        <ArrowLeft size={14} /> Back to library
      </Button>
      <PageHeader title={playlist.data.name} subtitle={playlist.data.description ?? undefined}>
        <Button size="sm" onClick={playAll} disabled={!tracks.length}>
          <Play size={14} /> Play
        </Button>
        <UploadButton />
      </PageHeader>

      <Card>
        {tracks.length ? (
          <ol className="divide-y divide-border/60">
            {tracks.map((track, index) => (
              <li key={track.id} className="flex items-center gap-3 py-2">
                <span className="w-6 text-right text-xs tabular-nums text-text-muted">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{track.title}</p>
                  <p className="truncate text-xs text-text-muted">{track.artist ?? "Unknown artist"}</p>
                </div>
                <Button size="icon" variant="ghost" onClick={() => playAll()} aria-label="Play all from this track">
                  <Play size={14} />
                </Button>
                <Button size="icon" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                  <ChevronUp size={14} />
                </Button>
                <Button size="icon" variant="ghost" disabled={index === tracks.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                  <ChevronDown size={14} />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => removeTrack.mutate(track.id)} aria-label={`Remove ${track.title}`}>
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState icon={<Music2 size={28} />} title="No tracks in this playlist" hint="Upload audio or add an existing track from the library." />
        )}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add track
          </Button>
        </div>
      </Card>

      {adding && (
        <AddTrackDialog
          candidates={(allTracks.data?.items ?? []).filter((t) => !tracks.some((pt) => pt.id === t.id))}
          onClose={() => setAdding(false)}
          onPick={(trackId) => addTrack.mutate(trackId)}
          pending={addTrack.isPending}
        />
      )}
    </div>
  );
}

interface AddTrackDialogProps {
  candidates: Array<{ id: string; title: string; artist: string | null }>;
  onClose: () => void;
  onPick: (id: string) => void;
  pending: boolean;
}

function AddTrackDialog({ candidates, onClose, onPick, pending }: AddTrackDialogProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg-base/70 p-4">
      <Card className="w-full max-w-lg">
        <h3 className="text-sm font-medium">Add track to playlist</h3>
        {candidates.length === 0 ? (
          <p className="mt-3 text-xs text-text-muted">Every track is already in this playlist. Upload more from the library.</p>
        ) : (
          <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
            {candidates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-bg-raised"
                  onClick={() => onPick(t.id)}
                  disabled={pending}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{t.title}</p>
                    <p className="truncate text-xs text-text-muted">{t.artist ?? "Unknown artist"}</p>
                  </div>
                  <Plus size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </Card>
    </div>
  );
}