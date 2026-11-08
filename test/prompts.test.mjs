import { test } from "node:test";
import assert from "node:assert/strict";
import { systemFor, DEFAULT_PROMPTS, LEGACY_PROMPTS, MODES, TRIGGER, upgradePrompt, isDefaultPrompt } from "../extension/lib/prompts.js";
import { buildChatRequest } from "../extension/lib/providers.js";

test("a saved prompt is sent exactly as written when it has no {format}", () => {
  const s = { format: "list", prompts: { context: "MY CUSTOM CONTEXT PROMPT", summary: "S", ask: "A" } };
  assert.equal(systemFor(s, "context"), "MY CUSTOM CONTEXT PROMPT");
  assert.equal(systemFor(s, "summary"), "S");
  assert.equal(systemFor({ ...s, format: "paragraph" }, "ask"), "A");
});

test("{format} is replaced by the list or paragraph line, wherever it is placed", () => {
  const s = { format: "list", prompts: { summary: "Intro.\n\n{format}\n\nOutro." } };
  assert.match(systemFor(s, "summary"), /^Intro\.\n\nFormat: a Markdown bullet list.*\n\nOutro\.$/);
  assert.match(systemFor({ ...s, format: "paragraph" }, "summary"), /one short paragraph/);
  assert.ok(!systemFor(s, "summary").includes("{format}"));
});

test("defaults carry {format}; missing or blank prompts fall back to defaults; unknown mode uses ask", () => {
  for (const k of ["summary", "context", "ask"]) assert.ok(DEFAULT_PROMPTS[k].includes("{format}"));
  assert.equal(systemFor({}, "summary"), systemFor({ prompts: { summary: "   " } }, "summary"));
  assert.ok(systemFor({}, "nonsense").startsWith("You are a helpful assistant"));
});

test("context is asked to be longer than the summary, and given more room", () => {
  assert.match(DEFAULT_PROMPTS.context, /500 to 700 words/);
  assert.match(DEFAULT_PROMPTS.summary, /five points/);
  assert.ok(MODES.context.maxTokens >= 2 * MODES.summary.maxTokens);
});

test("the user turn for the buttons carries no instructions of its own", () => {
  assert.equal(MODES.summary.message, TRIGGER);
  assert.equal(MODES.context.message, TRIGGER);
  assert.ok(!/summar|context/i.test(TRIGGER));
});

test("earlier defaults and the old 300-word prompt are upgraded; edited prompts are kept", () => {
  assert.equal(upgradePrompt("context", LEGACY_PROMPTS.context[0]), DEFAULT_PROMPTS.context);
  assert.equal(upgradePrompt("summary", "  " + LEGACY_PROMPTS.summary[0].replace(/ /g, "  ")), DEFAULT_PROMPTS.summary);
  assert.equal(upgradePrompt("context", "Reply in no more than 300 words.\nDo not treat any outlet as neutral."), DEFAULT_PROMPTS.context);
  assert.equal(upgradePrompt("summary", "My own summary prompt"), "My own summary prompt");
  assert.equal(upgradePrompt("ask", undefined), DEFAULT_PROMPTS.ask);
  assert.ok(isDefaultPrompt("summary", DEFAULT_PROMPTS.summary + "  "));
  assert.ok(!isDefaultPrompt("summary", "mine"));
});

test("Anthropic requests honour maxTokens; OpenAI-style requests do not set it", () => {
  const claude = { kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k" };
  const openai = { kind: "openai", baseUrl: "https://x/v1", apiKey: "k" };
  assert.equal(buildChatRequest(claude, "m", [], "s", { maxTokens: 600 }).body.max_tokens, 600);
  assert.equal(buildChatRequest(claude, "m", [], "s").body.max_tokens, 8192);
  assert.equal(buildChatRequest(openai, "m", [], "s", { maxTokens: 600 }).body.max_tokens, undefined);
});
