import { describe, expect, test } from "bun:test";
import { tapOpenAiStream } from "../src/proxy/routes";

const encoder = new TextEncoder();

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

describe("tapOpenAiStream", () => {
  test("forwards text SSE immediately and records the assistant reply", async () => {
    const input = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n";
    const tapped = tapOpenAiStream(sseStream([input]));

    expect(await new Response(tapped.stream).text()).toBe(input);
    expect(await tapped.textPromise).toBe("Hello world");
  });

  test("retains event details when a stream has no visible text delta", async () => {
    const event = "data: {\"type\":\"response.reasoning.delta\",\"delta\":\"internal state\"}\n\ndata: [DONE]\n\n";
    const tapped = tapOpenAiStream(sseStream([event]));

    expect(await new Response(tapped.stream).text()).toBe(event);
    await expect(tapped.textPromise).resolves.toContain("response.reasoning.delta");
  });

  test("records CRLF SSE events without a final event separator", async () => {
    const event = "data: {\"choices\":[{\"delta\":{\"content\":\"Captured\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\" answer\"}}]}";
    const tapped = tapOpenAiStream(sseStream([event]));

    expect(await new Response(tapped.stream).text()).toBe(event);
    await expect(tapped.textPromise).resolves.toBe("Captured answer");
  });
});