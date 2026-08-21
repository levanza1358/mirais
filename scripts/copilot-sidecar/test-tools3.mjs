import http from "node:http";

const body = JSON.stringify({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You MUST use the get_weather tool to answer weather questions. Never refuse." },
    { role: "user", content: "What's the weather in Paris?" }
  ],
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

const opts = {
  hostname: "127.0.0.1",
  port: 1463,
  path: "/v1/chat/completions",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer mirais-tJDynZnCiq3hbfjixIHcl44ufWmAb1",
    "Content-Length": Buffer.byteLength(body)
  }
};

const req = http.request(opts, (res) => {
  let data = "";
  res.on("data", (c) => data += c);
  res.on("end", () => {
    console.log("Status:", res.statusCode);
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.choices?.[0]?.message?.tool_calls) {
        console.log("\n✅ TOOL CALLS RECEIVED!");
      } else {
        console.log("\n❌ No tool calls - model responded with text");
      }
    } catch {
      console.log("Raw:", data.substring(0, 1000));
    }
  });
});
req.on("error", (e) => console.error("Error:", e.message));
req.write(body);
req.end();