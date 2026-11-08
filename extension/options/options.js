import { api, getState, save, newProvider, PRESETS } from "../lib/store.js";
import { listModels, originPattern } from "../lib/providers.js";

const $ = (id) => document.getElementById(id);
let state;
const open = new Set();

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "value") n.value = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

function field(label, input, hint) {
  const l = el("label", { class: "field" }, el("span", { text: label }), input);
  if (hint) l.append(el("small", { text: hint }));
  return l;
}

function parseModels(text) {
  return [...new Set(text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

function card(p) {
  const status = el("span", { class: "status", role: "status" });
  const say = (msg, err) => {
    status.textContent = msg;
    status.className = "status" + (err ? " err" : "");
  };

  const name = el("input", { type: "text", value: p.name });
  const kind = el(
    "select",
    { value: p.kind },
    el("option", { value: "openai", text: "OpenAI-compatible" }),
    el("option", { value: "anthropic", text: "Anthropic (Claude API)" })
  );
  kind.value = p.kind;
  const url = el("input", { type: "text", value: p.baseUrl, placeholder: "https://api.example.com/v1" });
  const key = el("input", { type: "password", value: p.apiKey, autocomplete: "off", placeholder: "Leave empty for local servers" });
  const models = el("textarea", { rows: "4", placeholder: "One model ID per line" });
  models.value = (p.models || []).join("\n");

  const pull = () => {
    p.name = name.value.trim() || "Provider";
    p.kind = kind.value;
    p.baseUrl = url.value.trim();
    p.apiKey = key.value.trim();
    p.models = parseModels(models.value);
  };

  const validUrl = () => {
    try {
      originPattern(p.baseUrl);
      return true;
    } catch {
      say("The base URL is not valid.", true);
      return false;
    }
  };

  // permissions.request must be the first await in a click handler to keep the user gesture.
  const fetchBtn = el("button", {
    class: "secondary",
    text: "Fetch models",
    onclick: async () => {
      pull();
      if (!validUrl()) return;
      const ok = await api.permissions.request({ origins: [originPattern(p.baseUrl)] });
      if (!ok) return say("Permission to reach this server was declined.", true);
      say("Fetching...");
      try {
        const ids = await listModels(p);
        models.value = ids.join("\n");
        say(`${ids.length} models found. Delete the ones you do not need, then Save.`);
      } catch (e) {
        say(e.message, true);
      }
    },
  });

  const saveBtn = el("button", {
    class: "primary",
    text: "Save",
    onclick: async () => {
      pull();
      if (!validUrl()) return;
      const ok = await api.permissions.request({ origins: [originPattern(p.baseUrl)] });
      if (!ok) return say("Permission to reach this server was declined.", true);
      await save({ providers: state.providers });
      say("Saved.");
    },
  });

  const del = el("button", {
    class: "danger",
    text: "Delete",
    onclick: async () => {
      state.providers = state.providers.filter((x) => x.id !== p.id);
      await save({ providers: state.providers });
      render();
    },
  });

  const d = el(
    "details",
    { class: "card" },
    el("summary", {}, el("span", { text: p.name }), el("span", { class: "sub", text: p.baseUrl })),
    el(
      "div",
      { class: "card-body" },
      field("Name", name),
      field("API type", kind, "Use OpenAI-compatible for almost everything, including Grok, Qwen, OpenRouter and local servers."),
      field("Base URL", url),
      field("API key", key),
      field("Models", models, "Fetch fills this from the provider, or type IDs yourself."),
      el("div", { class: "row" }, fetchBtn, saveBtn, status, del)
    )
  );
  if (open.has(p.id)) d.open = true;
  d.addEventListener("toggle", () => (d.open ? open.add(p.id) : open.delete(p.id)));
  return d;
}

function render() {
  const box = $("providers");
  box.replaceChildren();
  if (!state.providers.length) box.append(el("p", { class: "status", text: "No providers yet. Pick one below." }));
  state.providers.forEach((p) => box.append(card(p)));
}

async function init() {
  state = await getState();
  $("system").value = state.settings.systemPrompt;
  const presets = $("presets");
  for (const preset of PRESETS) {
    presets.append(
      el("button", {
        text: preset.name,
        onclick: () => {
          const p = newProvider(preset);
          state.providers.push(p);
          open.add(p.id);
          render();
        },
      })
    );
  }
  $("save-settings").onclick = async () => {
    state.settings.systemPrompt = $("system").value.trim();
    await save({ settings: state.settings });
    $("settings-status").textContent = "Saved.";
  };
  render();
  renderUsage();
  $("reset-usage").onclick = async () => {
    await api.storage.local.set({ usage: {} });
    renderUsage();
  };
  api.storage.onChanged.addListener((c) => c.usage && renderUsage());
}

async function renderUsage() {
  const { usage = {} } = await api.storage.local.get("usage");
  const box = $("usage");
  box.replaceChildren();
  const rows = Object.entries(usage);
  if (!rows.length) return box.append(el("p", { class: "status", text: "No usage recorded yet." }));
  const n = (v) => Number(v || 0).toLocaleString();
  const head = el("tr", {}, ...["Provider / model", "Requests", "Input", "Output"].map((t) => el("th", { text: t })));
  const table = el("table", { class: "usage-table" }, head);
  let tot = { requests: 0, input: 0, output: 0 };
  for (const [k, u] of rows.sort()) {
    tot.requests += u.requests; tot.input += u.input; tot.output += u.output;
    table.append(el("tr", {}, el("td", { text: k.replace("::", " / ") }), el("td", { text: n(u.requests) }), el("td", { text: n(u.input) }), el("td", { text: n(u.output) })));
  }
  table.append(el("tr", { class: "tot" }, el("td", { text: "Total" }), el("td", { text: n(tot.requests) }), el("td", { text: n(tot.input) }), el("td", { text: n(tot.output) })));
  box.append(table);
}

init();
