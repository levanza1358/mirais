import { NowPlaying } from "../components/music/NowPlaying";
import { PageHeader } from "../components/Layout";

export default function MusicNowPlaying() {
  return (
    <div className="pb-32">
      <PageHeader title="Now playing" />
      <NowPlaying />
    </div>
  );
}