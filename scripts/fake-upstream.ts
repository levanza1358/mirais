// Minimal OpenAI-compatible upstream for smoke testing the proxy path.
// Serves /v1/models and /v1/chat/completions (both SSE and JSON) on :8080.
const server = Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "llama3.1-8b", object: "model", created: 0, owned_by: "fake" }],
      });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as { model?: string; stream?: boolean; messages?: Array<{ content?: string }> };
      const text = `echo: ${body.messages?.[0]?.content ?? ""}`;
      if (body.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            const chunk = (delta: object) =>
              `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
            c.enqueue(enc.encode(chunk({ role: "assistant" })));
            c.enqueue(enc.encode(chunk({ content: text })));
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
              ),
            );
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`fake upstream on :${server.port}`);
