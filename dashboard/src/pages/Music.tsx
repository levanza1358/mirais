import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search, Trash2, Play, Music2, Disc3 as DiscIcon, ListMusic, Youtube } from "lucide-react";
import { music, type MusicPlaylist, type MusicTrack } from "../api";
import { Button, Card, ConfirmModal, EmptyState, Input, Modal, Skeleton, toast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { UploadButton } from "../components/music/UploadButton";
import { AddFromYouTubeDialog } from "../components/music/AddFromYouTubeDialog";
import { usePlayer } from "../components/music/usePlayer";

export default function Music() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [removingPlaylist, setRemovingPlaylist] = useState<MusicPlaylist | null>(null);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const setQueue = usePlayer((s) => s.setQueue);

  const tracks = useQuery({
    queryKey: ["music-tracks", search],
    queryFn: () => music.listTracks({ q: search.trim() || undefined, limit: 200 }),
  });
  const playlists = useQuery({ queryKey: ["music-playlists"], queryFn: music.listPlaylists });

  const createPlaylist = useMutation({
    mutationFn: () => music.createPlaylist({ name: newPlaylistName.trim(), tracks: [] }),
    onSuccess: (playlist) => {
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      setCreating(false);
      setNewPlaylistName("");
      toast(`Playlist "${playlist.name}" created`);
      navigate(`/dashboard/music/playlists/${playlist.id}`);
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const deletePlaylist = useMutation({
    mutationFn: (id: string) => music.deletePlaylist(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      setRemovingPlaylist(null);
      toast("Playlist deleted");
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const deleteTrack = useMutation({
    mutationFn: (id: string) => music.deleteTrack(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["music-tracks"] }),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const totalDuration = useMemo(() => {
    const seconds = (tracks.data?.items ?? []).reduce((acc, t) => acc + (t.duration_sec ?? 0), 0);
    return seconds;
  }, [tracks.data]);

  return (
    <div className="space-y-6 pb-32">
      <PageHeader title="Music library">
        <Button size="sm" variant="outline" onClick={() => setYoutubeOpen(true)} title="Search and import from YouTube">
          <Youtube size={14} /> From YouTube
        </Button>
        <UploadButton />
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium"><ListMusic size={14} /> Playlists</h3>
            <Button size="icon" variant="ghost" onClick={() => setCreating(true)} aria-label="New playlist">
              <Plus size={14} />
            </Button>
          </div>
          <ul className="mt-3 space-y-1">
            {playlists.isLoading ? (
              <Skeleton className="h-5 w-full" />
            ) : !playlists.data?.length ? (
              <li className="text-xs text-text-muted">No playlists yet.</li>
            ) : (
              playlists.data.map((p) => (
                <li key={p.id} className="group flex items-center gap-1">
                  <Link
                    to={`/dashboard/music/playlists/${p.id}`}
                    className="flex-1 truncate rounded-md px-2 py-1 text-sm text-text-primary hover:bg-bg-raised"
                  >
                    {p.name}
                  </Link>
                  <Button size="icon" variant="ghost" onClick={() => setRemovingPlaylist(p)} aria-label={`Delete ${p.name}`}>
                    <Trash2 size={12} />
                  </Button>
                </li>
              ))
            )}
          </ul>
        </Card>

        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative flex-1">
              <Search size={14} className="absolute left-3 top-2.5 text-text-muted" />
              <Input
                className="pl-9"
                placeholder="Search tracks"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="text-xs text-text-muted">
              {tracks.data?.items.length ?? 0} tracks · {formatTotal(totalDuration)}
            </div>
          </div>
          {tracks.isLoading ? (
            <Skeleton className="mt-3 h-32 w-full" />
          ) : !tracks.data?.items.length ? (
            <EmptyState
              icon={<DiscIcon size={28} />}
              title="No tracks yet"
              hint="Drop in an MP3, M4A, OGG, WAV, or FLAC. Mirais reads its title and length from the file."
              action={<UploadButton />}
            />
          ) : (
            <div className="mt-4 divide-y divide-border/60">
              {tracks.data.items.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  onPlay={(t) => setQueue(tracks.data!.items, tracks.data!.items.findIndex((x) => x.id === t.id))}
                  onDelete={(t) => deleteTrack.mutate(t.id)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create playlist">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (newPlaylistName.trim()) createPlaylist.mutate();
          }}
        >
          <label className="block text-xs text-text-muted">
            Name
            <Input className="mt-1" autoFocus required value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} placeholder="my-mix" />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" loading={createPlaylist.isPending}>Create</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={!!removingPlaylist}
        onClose={() => setRemovingPlaylist(null)}
        onConfirm={() => removingPlaylist && deletePlaylist.mutate(removingPlaylist.id)}
        title="Delete playlist"
        message={`Delete "${removingPlaylist?.name ?? ""}"? Tracks are kept; only the playlist is removed.`}
        loading={deletePlaylist.isPending}
        danger
      />

      <AddFromYouTubeDialog open={youtubeOpen} onClose={() => setYoutubeOpen(false)} />
    </div>
  );
}

interface TrackRowProps {
  track: MusicTrack;
  onPlay: (track: MusicTrack) => void;
  onDelete: (track: MusicTrack) => void;
}

function TrackRow({ track, onPlay, onDelete }: TrackRowProps) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-raised text-text-muted">
        {track.thumbnail_url ? (
          <img src={track.thumbnail_url} alt="" className="h-9 w-9 rounded-md object-cover" />
        ) : (
          <Music2 size={14} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track.title}</p>
        <p className="truncate text-xs text-text-muted">
          {track.artist ?? "Unknown artist"}
          {track.album ? ` · ${track.album}` : ""}
          {track.duration_sec ? ` · ${formatTotal(track.duration_sec)}` : ""}
          {track.source_type === "url" ? " · URL" : ""}
        </p>
      </div>
      <Button size="icon" variant="ghost" onClick={() => onPlay(track)} aria-label={`Play ${track.title}`}>
        <Play size={14} />
      </Button>
      <Button size="icon" variant="ghost" onClick={() => onDelete(track)} aria-label={`Delete ${track.title}`}>
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function formatTotal(seconds: number): string {
  if (!seconds) return "0 min";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h} h ${m} min`;
}