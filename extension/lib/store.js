export const api = globalThis.browser ?? globalThis.chrome;

export const DEFAULT_SYSTEM =
  "You are a helpful assistant inside a browser sidebar. Answer directly and concisely.";

// Base URLs are provider defaults; verify against the provider's docs if one stops working.
export const PRESETS = [
  { name: "Grok (xAI)", kind: "openai", baseUrl: "https://api.x.ai/v1" },
  { name: "Claude (Anthropic)", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { name: "Qwen (DashScope Intl)", kind: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com" },
  { name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1" },
  { name: "Custom", kind: "openai", baseUrl: "" },
];

export async function getState() {
  const s = await api.storage.local.get({
    providers: [],
    active: null,
    settings: {},
    conversations: [],
  });
  s.settings = { systemPrompt: DEFAULT_SYSTEM, includePage: false, ...s.settings };
  return s;
}

export const save = (obj) => api.storage.local.set(obj);

// Running totals of provider-reported token usage, per provider and model.
export async function addUsage(providerName, model, input, output) {
  const { usage = {} } = await api.storage.local.get("usage");
  const key = `${providerName}::${model}`;
  const u = usage[key] || { requests: 0, input: 0, output: 0 };
  u.requests += 1;
  u.input += input || 0;
  u.output += output || 0;
  u.first = u.first || Date.now();
  u.last = Date.now();
  usage[key] = u;
  await api.storage.local.set({ usage });
}

export function newProvider(preset) {
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    apiKey: "",
    models: [],
  };
}

// Run a key test for one provider and store the result on it. Used by the background page.
export async function runKeyTest(id, tester, sigFn) {
  const { providers = [] } = await api.storage.local.get("providers");
  const p = providers.find((x) => x.id === id);
  if (!p) return null;
  const r = await tester(p);
  const status = { state: r.state, message: r.message, at: Date.now(), sig: sigFn(p) };
  const fresh = (await api.storage.local.get("providers")).providers || [];
  const target = fresh.find((x) => x.id === id);
  if (target && sigFn(target) === status.sig) {
    target.keyStatus = status;
    await api.storage.local.set({ providers: fresh });
  }
  return status;
}
