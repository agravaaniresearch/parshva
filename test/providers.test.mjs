import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildChatRequest, parseSSE, extractDelta, streamChat, listModels, originPattern } from "../extension/lib/providers.js";

const openai = { kind: "openai", baseUrl: "http://127.0.0.1:0/v1/", apiKey: "k" };
const claude = { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk" };

function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("openai request shape", () => {
  const r = buildChatRequest(openai, "m", [{ role: "user", content: "hi", page: "x" }], "sys");
  assert.equal(r.url, "http://127.0.0.1:0/v1/chat/completions");
  assert.equal(r.headers.Authorization, "Bearer k");
  assert.deepEqual(r.body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(r.body.stream, true);
});

test("openai without key sends no auth header (local servers)", () => {
  const r = buildChatRequest({ ...openai, apiKey: "" }, "m", [], "");
  assert.equal("Authorization" in r.headers, false);
});

test("anthropic request shape and /v1 normalisation", () => {
  const r = buildChatRequest(claude, "c", [{ role: "user", content: "hi" }], "sys");
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], "sk");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.body.system, "sys");
  assert.ok(r.body.max_tokens > 0);
});

test("origin pattern", () => {
  assert.equal(originPattern("http://localhost:11434/v1"), "http://localhost:11434/*");
  assert.equal(originPattern("https://api.x.ai/v1"), "https://api.x.ai/*");
});

test("SSE parser survives arbitrary chunk boundaries and CRLF", async () => {
  const text = 'data: {"a":1}\r\n\r\nevent: x\r\ndata: l1\r\ndata: l2\r\n\r\n: comment\n\ndata: tail';
  for (let size = 1; size < 12; size++) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const out = [];
    for await (const ev of parseSSE(streamOf(chunks))) out.push(ev);
    assert.deepEqual(out, [
      { event: "message", data: '{"a":1}' },
      { event: "x", data: "l1\nl2" },
      { event: "message", data: "tail" },
    ], `chunk size ${size}`);
  }
});

test("multi-byte characters split across chunks", async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"नमस्ते"}}]}\n\n');
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const out = [];
  for await (const ev of parseSSE(body)) out.push(extractDelta("openai", ev));
  assert.deepEqual(out, ["नमस्ते"]);
});

test("extractDelta: openai, anthropic, errors", () => {
  assert.equal(extractDelta("openai", { data: '{"choices":[{"delta":{"content":"hi"}}]}' }), "hi");
  assert.equal(extractDelta("openai", { data: '{"choices":[{"delta":{"role":"assistant"}}]}' }), null);
  assert.equal(typeof extractDelta("openai", { data: "[DONE]" }), "symbol");
  assert.throws(() => extractDelta("openai", { data: '{"error":{"message":"bad key"}}' }), /bad key/);
  assert.equal(extractDelta("anthropic", { data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"yo"}}' }), "yo");
  assert.equal(extractDelta("anthropic", { data: '{"type":"ping"}' }), null);
  assert.equal(typeof extractDelta("anthropic", { data: '{"type":"message_stop"}' }), "symbol");
  assert.throws(() => extractDelta("anthropic", { data: '{"type":"error","error":{"message":"overloaded"}}' }), /overloaded/);
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("end to end: OpenAI-style stream over real HTTP, split mid-event", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, "Bearer k");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = ["Hel", "lo ", "world"].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      const all = events.join("") + "data: [DONE]\n\n";
      let i = 0;
      const t = setInterval(() => {
        res.write(all.slice(i, i + 17));
        i += 17;
        if (i >= all.length) {
          clearInterval(t);
          res.end();
        }
      }, 2);
    },
    async (base) => {
      let text = "";
      for await (const d of streamChat({ provider: { ...openai, baseUrl: base + "/v1" }, model: "m", messages: [{ role: "user", content: "x" }] })) text += d;
      assert.equal(text, "Hello world");
    }
  );
});

test("end to end: Anthropic-style stream", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/v1/messages");
      assert.equal(req.headers["x-api-key"], "sk");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
      res.write(ev("message_start", { message: {} }));
      res.write(ev("content_block_delta", { delta: { type: "text_delta", text: "Foo" } }));
      res.write(ev("content_block_delta", { delta: { type: "text_delta", text: "Bar" } }));
      res.write(ev("message_stop", {}));
      res.end();
    },
    async (base) => {
      let text = "";
      for await (const d of streamChat({ provider: { ...claude, baseUrl: base }, model: "c", messages: [{ role: "user", content: "x" }] })) text += d;
      assert.equal(text, "FooBar");
    }
  );
});

test("HTTP error surfaces the provider message", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    },
    async (base) => {
      await assert.rejects(async () => {
        for await (const _ of streamChat({ provider: { ...openai, baseUrl: base + "/v1" }, model: "m", messages: [] }));
      }, /401.*Invalid API key/);
    }
  );
});

test("abort stops the stream", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const t = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`), 5);
      res.on("close", () => clearInterval(t));
    },
    async (base) => {
      const ac = new AbortController();
      let n = 0;
      await assert.rejects(async () => {
        for await (const _ of streamChat({ provider: { ...openai, baseUrl: base + "/v1" }, model: "m", messages: [], signal: ac.signal })) {
          if (++n === 3) ac.abort();
        }
      }, (e) => e.name === "AbortError");
    }
  );
});

test("listModels handles OpenAI and Anthropic shapes", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
    },
    async (base) => {
      assert.deepEqual(await listModels({ ...openai, baseUrl: base + "/v1" }), ["a", "b"]);
      assert.deepEqual(await listModels({ ...claude, baseUrl: base }), ["a", "b"]);
    }
  );
});
