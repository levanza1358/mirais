import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { extractVideoId, isValidVideoId, pickAudioUrl, toSearchResult, importFromVideoId, type InvidiousVideo } from "../src/utils/invidious";
import { config } from "../src/config";

function restoreFetch(original: typeof fetch) {
  globalThis.fetch = original;
}

describe("isValidVideoId", () => {
  test("accepts 11-char YouTube ids", () => {
    expect(isValidVideoId("dQw4w9WgXcQ")).toBe(true);
  });
  test("rejects malformed ids", () => {
    expect(isValidVideoId("")).toBe(false);
    expect(isValidVideoId("short")).toBe(false);
    expect(isValidVideoId("with spaces!!")).toBe(false);
    expect(isValidVideoId(null)).toBe(false);
  });
});

describe("extractVideoId", () => {
  test("passes bare ids through", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  test("parses youtu.be", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  test("parses youtube.com/watch?v=", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  test("parses youtube.com/shorts/", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  test("returns null for garbage", () => {
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("https://example.com/")).toBeNull();
  });
});

describe("pickAudioUrl", () => {
  test("chooses the highest bitrate audio-only format", () => {
    const video: InvidiousVideo = {
      adaptiveFormats: [
        { type: "video/mp4", url: "https://x/video.mp4", bitrate: 1_000_000 },
        { type: "audio/webm; codecs=\"opus\"", url: "https://x/audio.webm", bitrate: 160_000 },
        { type: "audio/mp4; codecs=\"mp4a.40.2\"", url: "https://x/audio.mp4", bitrate: 128_000 },
      ],
    };
    const pick = pickAudioUrl(video);
    expect(pick?.mime).toBe("audio/webm; codecs=\"opus\"");
    expect(pick?.bitrate).toBe(160_000);
  });

  test("falls back to lowest available when all bitrates exceed cap", () => {
    const video: InvidiousVideo = {
      adaptiveFormats: [
        { type: "audio/webm", url: "https://x/a.webm", bitrate: 320_000 },
      ],
    };
    const pick = pickAudioUrl(video);
    expect(pick?.bitrate).toBe(320_000);
  });

  test("returns null when no audio formats exist", () => {
    expect(pickAudioUrl({ adaptiveFormats: [{ type: "video/mp4", url: "x" }] })).toBeNull();
  });
});

describe("toSearchResult", () => {
  test("extracts compact search shape", () => {
    const video: InvidiousVideo = {
      videoId: "dQw4w9WgXcQ",
      title: "Sample",
      author: "Anthropic",
      lengthSeconds: 213,
      videoThumbnails: [{ quality: "maxresdefault", url: "https://x/thumb.jpg" }],
    };
    const result = toSearchResult(video);
    expect(result).toEqual({
      id: "dQw4w9WgXcQ",
      title: "Sample",
      author: "Anthropic",
      duration_sec: 213,
      thumbnail_url: "https://x/thumb.jpg",
    });
  });

  test("returns null when id missing", () => {
    expect(toSearchResult({ title: "no id" })).toBeNull();
  });
});

describe("importFromVideoId", () => {
  const original = globalThis.fetch;

  beforeEach(() => {
    // Force a single dummy instance for deterministic routing.
    (config as unknown as { invidiousInstances: string[] }).invidiousInstances = ["https://inv.test"];
  });

  afterEach(() => restoreFetch(original));

  test("builds the import shape from a video response", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/api/v1/videos/")) {
        return new Response(JSON.stringify({
          videoId: "dQw4w9WgXcQ",
          title: "Hello",
          author: "Channel",
          lengthSeconds: 200,
          videoThumbnails: [{ quality: "maxresdefault", url: "https://x/t.jpg" }],
          adaptiveFormats: [
            { type: "audio/mp4; codecs=\"mp4a.40.2\"", url: "https://x/a.mp4", bitrate: 128_000 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const imported = await importFromVideoId("dQw4w9WgXcQ");
    expect(imported).toEqual({
      id: "dQw4w9WgXcQ",
      title: "Hello",
      artist: "Channel",
      duration_sec: 200,
      source_url: "https://x/a.mp4",
      mime_type: "audio/mp4; codecs=\"mp4a.40.2\"",
      thumbnail_url: "https://x/t.jpg",
      size_bytes: null,
    });
  });

  test("returns null when no audio format exposed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ videoId: "dQw4w9WgXcQ", title: "no-audio", adaptiveFormats: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await importFromVideoId("dQw4w9WgXcQ")).toBeNull();
  });
});