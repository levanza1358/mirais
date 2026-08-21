import http from "node:http";

// Test directly against the sidecar (not the gateway)
// First find which port the sidecar is on
import { execSync } from "node:child_process";

const body = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"]
      }
    }
  }],
  stream: false
});

// Try common sidecar ports
const ports = [31241, 30392, 31242];
let tested = false;

async function tryPort(port) {
  return new Promise((resolve) => {
    const opts = {
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        resolve({ port, status: res.statusCode, data });
      });
    });
    req.on("error", (e) => resolve({ port, error: e.message }));
    req.write(body);
    req.end();
  });
}

for (const port of ports) {
  const result = await tryPort(port);
  console.log(`Port ${port}: status=${result.status}`, result.error || "");
  if (result.data) {
    try {
      const parsed = JSON.parse(result.data);
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.choices?.[0]?.message?.tool_calls) {
        console.log("\n✅ TOOL CALLS!");
      }
    } catch {
      console.log("Raw:", result.data.substring(0, 500));
    }
  }
}