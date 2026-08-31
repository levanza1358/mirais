import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, ToolSet, BuiltInTools } from "@github/copilot-sdk";

const port = Number(process.env.PORT ?? 4141);
const home = process.env.COPILOT_HOME;
if (!home) throw new Error("COPILOT_HOME is required");

const tokenFile = join(home, "token.txt");
const gitHubToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() : undefined;
const client = new CopilotClient({ baseDirectory: home, mode: "empty", logLevel: "error", useLoggedInUser: !gitHubToken, ...(gitHubToken ? { gitHubToken } : {}) });
let started = false;

async function start() {
  if (!started) {
    await client.start();
    started = true;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function messagesToPrompt(messages) {
  return messages.map((message) => {
    if (message.role === "assistant" && message.tool_calls) {
      const calls = message.tool_calls.map((tc) => `tool_call: ${tc.function.name}(${tc.function.arguments})`).join("\n");
      return `assistant: ${message.content ?? ""}\n${calls}`;
    }
    if (message.role === "tool") {
      return `tool_result (${message.tool_call_id}): ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`;
    }
    const content = typeof message.content === "string" ? message.content : "";
    return `${message.role}: ${content}`;
  }).join("\n\n");
}

async function chat(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (!body.model || !Array.isArray(body.messages)) return json(res, 400, { error: { message: "model and messages are required", type: "invalid_request_error" } });
  await start();
  const id = `chatcmpl-${randomUUID()}`;
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    skipPermission: true
  })) : [];
  const availableTools = new ToolSet();
  availableTools.addBuiltIn(BuiltInTools.Isolated);
  if (tools.length) availableTools.addCustom("*");
  const session = await client.createSession({ model: body.model, tools, availableTools, streaming: true, includeSubAgentStreamingEvents: false, enableSessionStore: false });
  let text = "";
  let toolCalls = [];
  const addToolCall = (id, name, args) => {
    if (!toolCalls.some((call) => call.id === id)) toolCalls.push({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.disconnect().catch(() => undefined);
  };
  req.on("close", () => { void session.abort().catch(() => undefined).finally(close); });
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant" });
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      offMsg();
      offTool();
      if (toolCalls.length) send({ content: null, tool_calls: toolCalls }, "tool_calls");
      else send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      await close();
    };
    const offTool = session.on("external_tool.requested", async (event) => {
      const data = event.data;
      addToolCall(data.toolCallId, data.toolName, data.arguments);
      await finish();
    });
    const offMsg = session.on("assistant.message", (event) => {
      const data = event.data;
      if (data.content) { text += data.content; send({ content: data.content }); }
      if (data.toolRequests?.length) {
        for (const tr of data.toolRequests) {
          addToolCall(tr.toolCallId, tr.name, tr.arguments);
        }
      }
    });
    session.on("session.idle", finish);
    session.on("session.error", async (event) => {
      if (finished) return;
      finished = true;
      offMsg();
      offTool();
      res.write(`data: ${JSON.stringify({ error: { message: event.data.message, type: "server_error" } })}\n\n`);
      res.end();
      await close();
    });
    await session.send({ prompt: messagesToPrompt(body.messages) });
    return;
  }
  const toolRequest = new Promise((resolve) => {
    session.on("external_tool.requested", (event) => resolve(event.data));
  });
  const result = await Promise.race([
    session.sendAndWait({ prompt: messagesToPrompt(body.messages) }, 120_000),
    toolRequest.then(async (data) => {
      await session.abort().catch(() => undefined);
      return { data: { toolRequests: [{ name: data.toolName, toolCallId: data.toolCallId, arguments: data.arguments }] } };
    })
  ]);
  await close();
  const msgData = result?.data;
  text = msgData?.content ?? "";
  toolCalls = (msgData?.toolRequests ?? []).map((tr) => ({ id: tr.toolCallId, type: "function", function: { name: tr.name, arguments: typeof tr.arguments === "string" ? tr.arguments : JSON.stringify(tr.arguments ?? {}) } }));
  const msg = { role: "assistant", content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  json(res, 200, {
    id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: msgData?.outputTokens ?? 0, total_tokens: 0 }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      await start();
      const auth = await client.getAuthStatus();
      return json(res, auth.isAuthenticated ? 200 : 503, { ok: auth.isAuthenticated, login: auth.login ?? null, message: auth.statusMessage ?? null });
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      await start();
      const listed = await client.listModels();
      const models = listed.length === 1 && listed[0].id === "auto"
        ? [{ id: "auto" }, ...(await client.rpc.models.getBuiltInCatalog({})).models]
        : listed;
      const ids = [...new Set(models.map((model) => model.id))];
      return json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "github-copilot" })) });
    }
    if (req.method === "GET" && req.url === "/v1/quota") {
      await start();
      return json(res, 200, await client.rpc.account.getQuota({}));
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/endpoint")) {
      await start();
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const modelId = url.searchParams.get("model") || undefined;
      const session = await client.createSession({ model: modelId ?? "gpt-4o", streaming: false, enableSessionStore: false });
      try {
        const ep = await session.rpc.provider.getEndpoint({ modelId });
        await session.disconnect();
        return json(res, 200, { baseUrl: ep.baseUrl, apiKey: ep.apiKey ?? null, headers: ep.headers, sessionToken: ep.sessionToken ?? null });
      } catch (err) {
        await session.disconnect().catch(() => undefined);
        throw err;
      }
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") return await chat(req, res);
    json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    json(res, 502, { error: { message: error instanceof Error ? error.message : "Copilot sidecar failed", type: "server_error" } });
  }
});

server.listen(port, "127.0.0.1");
