import { DEFAULT_PROMPTS } from "./prompts.js";

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
  const raw = s.settings || {};
  const old = raw.systemPrompt && raw.systemPrompt !== DEFAULT_SYSTEM ? raw.systemPrompt : null;
  s.settings = { includePage: false, theme: "auto", format: "list", ...raw };
  // Earlier versions stored one prompt; it becomes the Context prompt.
  s.settings.prompts = {
    context: raw.prompts?.context ?? old ?? DEFAULT_PROMPTS.context,
    summary: raw.prompts?.summary ?? DEFAULT_PROMPTS.summary,
    ask: raw.prompts?.ask ?? DEFAULT_PROMPTS.ask,
  };
  return s;
}

export const save = (obj) => api.storage.local.set(obj);

// Changes only the given settings keys, merged into what is stored right now. Writing a whole in-memory
// settings object from a page that has been open a while would overwrite changes made elsewhere.
export async function patchSettings(patch) {
  const { settings = {} } = await api.storage.local.get("settings");
  const next = { ...settings, ...patch };
  await api.storage.local.set({ settings: next });
  return patch;
}

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
  // Per-day totals (last 60 days) for the usage chart.
  const { usageDaily = {} } = await api.storage.local.get("usageDaily");
  const day = new Date().toISOString().slice(0, 10);
  const d = usageDaily[day] || { input: 0, output: 0 };
  d.input += input || 0;
  d.output += output || 0;
  usageDaily[day] = d;
  for (const k of Object.keys(usageDaily).sort().slice(0, -60)) delete usageDaily[k];
  await api.storage.local.set({ usage, usageDaily });
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

// theme: "auto" | "light" | "dark". Cached in localStorage so theme-init.js can apply it before paint.
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  try {
    localStorage.setItem("parshva-theme", theme === "light" || theme === "dark" ? theme : "auto");
  } catch {
    /* storage unavailable */
  }
}
