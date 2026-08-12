// Quick test: check if Responses API still works (existing path)
const token = process.argv[2];
if (!token) {
  console.log("Usage: bun run _quick_test.ts <token>");
  process.exit(1);
}

// Test Responses API (existing path)
const body = {
  model: "grok-4.5",
  messages: [{ role: "user", content: "Say hi in one word" }],
  reasoning_effort: "high",
  stream: false,
};

console.log("Testing Responses API...");
try {
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "grok-cli/0.1.202",
      "X-Grok-Client": "grok-cli",
      "X-Grok-Client-Version": "0.1.202",
    },
    body: JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi in one word" }] }], model: "grok-4.5", reasoning: { effort: "high" } }),
  });
  console.log("Responses API status:", res.status);
  const text = await res.text();
  console.log("Response:", text.substring(0, 500));
} catch (e: any) {
  console.log("Error:", e.message);
}
