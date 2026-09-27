import { useRef, useState } from "react";
import { parseBlob } from "music-metadata-browser";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { music, uploadMusicFile } from "../../api";
import { Button, toast } from "../ui";

interface UploadButtonProps {
  /** Optional callback after a track has been created and its file uploaded. */
  onUploaded?: (trackId: string) => void;
}

/**
 * File-picker + drag-and-drop dropzone. Picks up the title/artist/album/duration
 * via `music-metadata-browser` (runs in the browser — see R1.13: no native
 * modules on the backend), creates the track row via `music.createTrack`,
 * then streams the file to the backend with `uploadMusicFile`.
 */
export function UploadButton({ onUploaded }: UploadButtonProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const qc = useQueryClient();

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const file = files[0]!;
    if (!file.type.startsWith("audio/")) {
      toast("Only audio files are supported", "error");
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const meta = await parseBlob(file).catch(() => null);
      const title = (meta?.common.title && meta.common.title.trim()) || file.name.replace(/\.[^.]+$/, "");
      const artist = meta?.common.artist?.trim() || null;
      const album = meta?.common.album?.trim() || null;
      const durationSec = meta?.format.duration ? Math.round(meta.format.duration) : null;
      const track = await music.createTrack({
        title,
        artist,
        album,
        duration_sec: durationSec,
        mime_type: file.type || null,
        size_bytes: file.size,
        source_type: "file",
      });
      await uploadMusicFile(track.id, file, (pct) => setProgress(pct));
      qc.invalidateQueries({ queryKey: ["music-tracks"] });
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      toast(`Uploaded "${track.title}"`);
      onUploaded?.(track.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
      setProgress(0);
      if (ref.current) ref.current.value = "";
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => { void handleFiles(event.target.files); }}
      />
      <Button
        size="sm"
        onClick={() => ref.current?.click()}
        loading={busy}
        title="Upload an audio file"
      >
        <Upload size={14} />
        {busy ? `Uploading… ${progress}%` : "Upload track"}
      </Button>
    </div>
  );
}