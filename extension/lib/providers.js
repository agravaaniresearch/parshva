// Provider adapters. Two wire formats cover everything:
//   "openai"    : any OpenAI-compatible /chat/completions endpoint
//   "anthropic" : Anthropic's native /v1/messages endpoint

const ANTHROPIC_VERSION = "2023-06-01";
const DONE = Symbol("done");

export function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.host}/*`;
}

function anthropicBase(baseUrl) {
  return trimSlash(baseUrl).replace(/\/v1$/, "");
}

function authHeaders(provider) {
  if (provider.kind === "anthropic") {
    return {
      "x-api-key": provider.apiKey || "",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
}

export function buildChatRequest(provider, model, messages, system, { includeUsage = true } = {}) {
  const clean = messages.map((m) => ({ role: m.role, content: m.content }));
  if (provider.kind === "anthropic") {
    const body = { model, max_tokens: 8192, stream: true, messages: clean };
    if (system) body.system = system;
    return {
      url: `${anthropicBase(provider.baseUrl)}/v1/messages`,
      headers: { ...authHeaders(provider), "content-type": "application/json" },
      body,
    };
  }
  const msgs = system ? [{ role: "system", content: system }, ...clean] : clean;
  return {
    url: `${trimSlash(provider.baseUrl)}/chat/completions`,
    headers: { ...authHeaders(provider), "content-type": "application/json" },
    body: {
      model,
      messages: msgs,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    },
  };
}

// Rough local estimate: about 4 characters per token for Latin text, about 1.5 for other scripts.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text || "")) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

// Token counts reported by the provider, when present: { input?, output? } or null.
export function extractUsage(kind, ev) {
  let j;
  try {
    j = JSON.parse(ev.data);
  } catch {
    return null;
  }
  if (kind === "anthropic") {
    if (j.type === "message_start" && j.message?.usage) {
      const u = j.message.usage;
      const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      return { input, output: u.output_tokens || 0 };
    }
    if (j.type === "message_delta" && j.usage && j.usage.output_tokens != null) {
      return { output: j.usage.output_tokens };
    }
    return null;
  }
  const u = j.usage;
  if (u && (u.prompt_tokens != null || u.completion_tokens != null)) {
    return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
  }
  return null;
}

// Server-sent events parser. Yields { event, data } objects.
export async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let raw = ""; // holds a trailing "\r" until we know whether "\n" follows in the next chunk
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const cut = raw.endsWith("\r") ? raw.length - 1 : raw.length;
      buf += raw.slice(0, cut).replace(/\r\n?/g, "\n");
      raw = raw.slice(cut);
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseEvent(raw);
        if (ev) yield ev;
      }
    }
    buf += (raw + decoder.decode()).replace(/\r\n?/g, "\n");
    let j;
    while ((j = buf.indexOf("\n\n")) !== -1) {
      const ev = parseEvent(buf.slice(0, j));
      buf = buf.slice(j + 2);
      if (ev) yield ev;
    }
    if (buf.trim()) {
      const ev = parseEvent(buf);
      if (ev) yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function parseEvent(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let val = c === -1 ? "" : line.slice(c + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") data.push(val);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

// Returns a text delta, null (ignore), or DONE. Throws on provider-reported errors.
export function extractDelta(kind, ev) {
  if (kind === "openai" && ev.data.trim() === "[DONE]") return DONE;
  let j;
  try {
    j = JSON.parse(ev.data);
  } catch {
    return null;
  }
  if (kind === "anthropic") {
    if (j.type === "error") throw new Error(j.error?.message || "Provider error");
    if (j.type === "message_stop") return DONE;
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta") return j.delta.text;
    return null;
  }
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const c = j.choices?.[0]?.delta?.content;
  return typeof c === "string" && c ? c : null;
}

async function describeError(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.message || (typeof j.error === "string" ? j.error : text);
  } catch {
    /* not JSON */
  }
  msg = String(msg || "").slice(0, 300);
  return `${res.status} ${res.statusText}${msg ? `: ${msg}` : ""}`;
}

export async function* streamChat({ provider, model, messages, system, signal, onUsage, fetchImpl = fetch }) {
  const post = (includeUsage) => {
    const req = buildChatRequest(provider, model, messages, system, { includeUsage });
    return fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
  };
  let res = await post(true);
  // A few strict OpenAI-compatible servers reject stream_options; retry once without it.
  if (!res.ok && provider.kind === "openai" && res.status === 400) {
    const text = await res.clone().text().catch(() => "");
    if (/stream_options|include_usage/i.test(text)) res = await post(false);
  }
  if (!res.ok) throw new Error(await describeError(res));

  const usage = { input: 0, output: 0 };
  for await (const ev of parseSSE(res.body)) {
    const u = extractUsage(provider.kind, ev);
    if (u) {
      if (u.input != null) usage.input = u.input;
      if (u.output != null) usage.output = u.output;
      if (onUsage) onUsage({ ...usage });
    }
    const d = extractDelta(provider.kind, ev);
    if (d === DONE) return;
    if (d) yield d;
  }
}

export async function listModels(provider, fetchImpl = fetch) {
  const url =
    provider.kind === "anthropic"
      ? `${anthropicBase(provider.baseUrl)}/v1/models?limit=100`
      : `${trimSlash(provider.baseUrl)}/models`;
  const res = await fetchImpl(url, { headers: authHeaders(provider) });
  if (!res.ok) throw new Error(await describeError(res));
  const j = await res.json();
  const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return list
    .map((m) => (typeof m === "string" ? m : m.id || m.name))
    .filter(Boolean)
    .sort();
}

// Fingerprint of the settings a key test applies to, so editing the key or URL marks the result stale.
export function keySig(provider) {
  const str = `${provider.kind}|${trimSlash(provider.baseUrl || "")}|${provider.apiKey || ""}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// Calls the provider's model-list endpoint. Returns { state, message } where state is
// ok | invalid | unverified | network | error.
export async function testKey(provider, fetchImpl = fetch) {
  const url =
    provider.kind === "anthropic"
      ? `${anthropicBase(provider.baseUrl)}/v1/models?limit=1`
      : `${trimSlash(provider.baseUrl)}/models`;
  let res;
  try {
    res = await fetchImpl(url, { headers: authHeaders(provider) });
  } catch (e) {
    return { state: "network", message: "Could not reach the server. Check the base URL and your connection." };
  }
  if (res.ok) return { state: "ok", message: "Key accepted." };
  const detail = await describeError(res);
  if (res.status === 401 || res.status === 403) return { state: "invalid", message: `Key rejected (${detail})` };
  if (res.status === 404 || res.status === 405) return { state: "unverified", message: "This server has no model-list endpoint, so the key could not be checked." };
  if (res.status === 429) return { state: "ok", message: "Key accepted, but the provider is rate limiting right now." };
  return { state: "error", message: detail };
}

// Providers shown in the sidebar picker: key tested OK (or unverifiable) with the current settings.
export function isUsable(p) {
  const k = p.keyStatus;
  return !!k && (k.state === "ok" || k.state === "unverified") && k.sig === keySig(p);
}
