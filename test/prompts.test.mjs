import { test } from "node:test";
import assert from "node:assert/strict";
import { systemFor, DEFAULT_PROMPTS, MODES } from "../extension/lib/prompts.js";
import { buildChatRequest } from "../extension/lib/providers.js";

test("systemFor uses the saved prompt text verbatim, plus the format line", () => {
  const s = { format: "list", prompts: { context: "MY CUSTOM CONTEXT PROMPT", summary: "S", ask: "A" } };
  const out = systemFor(s, "context");
  assert.ok(out.startsWith("MY CUSTOM CONTEXT PROMPT"));
  assert.match(out, /bullet list/i);
  assert.match(systemFor({ ...s, format: "paragraph" }, "context"), /paragraphs/i);
  assert.ok(systemFor(s, "summary").startsWith("S"));
  assert.ok(systemFor(s, "ask").startsWith("A"));
});

test("systemFor falls back to defaults for missing or blank prompts, and unknown modes use ask", () => {
  assert.ok(systemFor({}, "summary").startsWith(DEFAULT_PROMPTS.summary));
  assert.ok(systemFor({ prompts: { summary: "   " } }, "summary").startsWith(DEFAULT_PROMPTS.summary));
  assert.ok(systemFor({}, "nonsense").startsWith(DEFAULT_PROMPTS.ask));
});

test("summary mode is capped tighter than context mode", () => {
  assert.ok(MODES.summary.maxTokens < MODES.context.maxTokens);
  assert.match(DEFAULT_PROMPTS.summary, /five points/);
});

test("Anthropic requests honour maxTokens; OpenAI-style requests do not set it", () => {
  const claude = { kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k" };
  const openai = { kind: "openai", baseUrl: "https://x/v1", apiKey: "k" };
  assert.equal(buildChatRequest(claude, "m", [], "s", { maxTokens: 600 }).body.max_tokens, 600);
  assert.equal(buildChatRequest(claude, "m", [], "s").body.max_tokens, 8192);
  assert.equal(buildChatRequest(openai, "m", [], "s", { maxTokens: 600 }).body.max_tokens, undefined);
});
