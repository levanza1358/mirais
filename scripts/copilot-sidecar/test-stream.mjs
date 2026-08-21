import http from "node:http";

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
  stream: true
});

const opts = {
  hostname: "127.0.0.1",
  port: 30392,
  path: "/v1/chat/completions",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  }
};

const req = http.request(opts, (res) => {
  console.log("Status:", res.statusCode);
  console.log("Headers:", JSON.stringify(res.headers));
  let data = "";
  res.on("data", (c) => {
    data += c.toString();
    // Print each SSE chunk
    const lines = c.toString().split("\n").filter(l => l.startsWith("data: "));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.choices?.[0]?.delta?.tool_calls) {
          console.log("🔥 TOOL CALL CHUNK:", JSON.stringify(parsed.choices[0].delta.tool_calls));
        }
        if (parsed.choices?.[0]?.finish_reason) {
          console.log("🏁 Finish reason:", parsed.choices[0].finish_reason);
        }
      } catch {}
    }
  });
  res.on("end", () => {
    console.log("\n--- FULL RAW ---");
    console.log(data);
  });
});
req.on("error", (e) => console.error("Error:", e.message));
req.write(body);
req.end();