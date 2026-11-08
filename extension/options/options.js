import { api, getState, save, newProvider, PRESETS } from "../lib/store.js";
import { listModels, originPattern, keySig } from "../lib/providers.js";

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
  const key = el("input", { type: "password", value: p.apiKey, autocomplete: "off", spellcheck: "false", placeholder: "Leave empty for local servers" });
  const eye = el("button", {
    type: "button",
    class: "secondary eye",
    text: "Show",
    onclick: () => {
      key.type = key.type === "password" ? "text" : "password";
      eye.textContent = key.type === "password" ? "Show" : "Hide";
    },
  });
  const keyRow = el("div", { class: "keyrow" }, key, eye);
  const mask = () => (p.apiKey ? `Saved key: \u2022\u2022\u2022\u2022${p.apiKey.slice(-4)}` : "No key saved.");
  const badge = el("span", { class: "badge" });
  const dot = el("span", { class: "dot" });
  const drawBadge = () => {
    const k = p.keyStatus && p.keyStatus.sig === keySig(p) ? p.keyStatus : null;
    const map = {
      ok: ["ok", "Key works"],
      unverified: ["warn", "Could not verify"],
      invalid: ["bad", "Invalid key"],
      network: ["warn", "Network error"],
      error: ["warn", "Test failed"],
    };
    const [cls, label] = k ? map[k.state] || ["", "Not tested"] : ["", "Not tested"];
    badge.className = "badge " + cls;
    badge.textContent = label;
    badge.title = k ? k.message || "" : "Press Test key to check it.";
    dot.className = "dot " + cls;
  };
  // catalog = every model ever fetched or added (never deleted by Fetch); models = the ticked ones shown in the sidebar picker.
  const catalog = new Set([...(p.catalog || []), ...(p.models || [])]);
  const picked = new Set(p.models || []);
  const filter = el("input", { type: "text", placeholder: "Filter models" });
  const list = el("div", { class: "modellist" });
  const count = el("small", { class: "count" });
  const manual = el("input", { type: "text", placeholder: "Add a model ID manually" });
  const drawList = () => {
    list.replaceChildren();
    const q = filter.value.trim().toLowerCase();
    const ids = [...catalog].sort((a, b) => (picked.has(b) - picked.has(a)) || a.localeCompare(b));
    for (const id of ids) {
      if (q && !id.toLowerCase().includes(q)) continue;
      const cb = el("input", { type: "checkbox" });
      cb.checked = picked.has(id);
      cb.onchange = () => {
        cb.checked ? picked.add(id) : picked.delete(id);
        count.textContent = `${picked.size} of ${catalog.size} shown in the sidebar`;
      };
      list.append(el("label", { class: "mrow" }, cb, el("span", { text: id })));
    }
    if (!list.children.length) list.append(el("p", { class: "status", text: catalog.size ? "No match." : "No models yet. Fetch them or add one below." }));
    count.textContent = `${picked.size} of ${catalog.size} shown in the sidebar`;
  };
  filter.oninput = drawList;
  const addManual = el("button", {
    class: "secondary",
    text: "Add",
    onclick: () => {
      const id = manual.value.trim();
      if (!id) return;
      catalog.add(id);
      picked.add(id);
      manual.value = "";
      filter.value = "";
      drawList();
    },
  });
  drawList();
  drawBadge();
  const models = el("div", { class: "models" }, filter, list, count, el("div", { class: "row" }, manual, addManual));

  const pull = () => {
    const before = keySig(p);
    p.name = name.value.trim() || "Provider";
    p.kind = kind.value;
    p.baseUrl = url.value.trim();
    p.apiKey = key.value.trim();
    if (keySig(p) !== before) p.keyStatus = null;
    p.catalog = [...catalog].sort();
    p.models = [...catalog].filter((id) => picked.has(id));
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
        const fresh = ids.filter((id) => !catalog.has(id)).length;
        ids.forEach((id) => catalog.add(id));
        drawList();
        say(`${ids.length} fetched, ${fresh} new. Tick the ones to show in the sidebar, then Save.`);
      } catch (e) {
        say(e.message, true);
      }
    },
  });

  const testBtn = el("button", {
    class: "secondary",
    text: "Test key",
    onclick: async () => {
      pull();
      if (!validUrl()) return;
      const ok = await api.permissions.request({ origins: [originPattern(p.baseUrl)] });
      if (!ok) return say("Permission to reach this server was declined.", true);
      await save({ providers: state.providers });
      badge.className = "badge";
      badge.textContent = "Testing\u2026";
      testBtn.disabled = true;
      try {
        p.keyStatus = await api.runtime.sendMessage({ type: "test-key", id: p.id });
      } catch (e) {
        p.keyStatus = { state: "error", message: e.message, at: Date.now(), sig: keySig(p) };
      }
      testBtn.disabled = false;
      drawBadge();
      say(p.keyStatus?.message || "", p.keyStatus?.state === "invalid");
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
      drawBadge();
      say("Saved. Press Test key to check it.");
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
    el("summary", {}, dot, el("span", { text: p.name }), el("span", { class: "sub", text: p.baseUrl }), badge),
    el(
      "div",
      { class: "card-body" },
      field("Name", name),
      field("API type", kind, "Use OpenAI-compatible for almost everything, including Grok, Qwen, OpenRouter and local servers."),
      field("Base URL", url),
      field("API key", keyRow, mask()),
      field("Models", models, "Fetching adds to this list and never removes anything. Tick the models you want in the sidebar picker, such as a stronger one for technical work."),
      el("div", { class: "row" }, testBtn, fetchBtn, saveBtn, status, del)
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
  $("usage-since").textContent = "";
  const rows = Object.entries(usage);
  if (!rows.length) return box.append(el("p", { class: "status", text: "No usage recorded yet. It appears here after your next reply." }));
  const n = (v) => Number(v || 0).toLocaleString();
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
  const heads = [["Provider and model", ""], ["Replies", "Number of replies counted"], ["Sent", "Tokens sent to the model"], ["Received", "Tokens in the replies"], ["Total", "Sent plus received"], ["Avg sent", "Average tokens sent per reply"], ["Last used", ""]];
  const table = el("table", { class: "usage-table" }, el("tr", {}, ...heads.map(([t, tip]) => el("th", { text: t, title: tip }))));
  const tot = { requests: 0, input: 0, output: 0 };
  let since = Infinity;
  const byProv = {};
  for (const [k, u] of rows) {
    const [prov, ...m] = k.split("::");
    (byProv[prov] ||= []).push([m.join("::"), u]);
  }
  for (const prov of Object.keys(byProv).sort()) {
    table.append(el("tr", { class: "grp" }, el("td", { text: prov, colspan: "7" })));
    for (const [model, u] of byProv[prov].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))) {
      tot.requests += u.requests; tot.input += u.input; tot.output += u.output;
      since = Math.min(since, u.first || u.last || Infinity);
      const avg = u.requests ? Math.round(u.input / u.requests) : 0;
      table.append(el("tr", {}, el("td", { class: "mdl", text: model }), el("td", { text: n(u.requests) }), el("td", { text: n(u.input) }), el("td", { text: n(u.output) }), el("td", { text: n(u.input + u.output) }), el("td", { text: n(avg) }), el("td", { text: when(u.last) })));
    }
  }
  const avgAll = tot.requests ? Math.round(tot.input / tot.requests) : 0;
  table.append(el("tr", { class: "tot" }, el("td", { text: "All providers" }), el("td", { text: n(tot.requests) }), el("td", { text: n(tot.input) }), el("td", { text: n(tot.output) }), el("td", { text: n(tot.input + tot.output) }), el("td", { text: n(avgAll) }), el("td", { text: "" })));
  box.append(el("div", { class: "tablewrap" }, table));
  if (isFinite(since)) $("usage-since").textContent = `Counting since ${when(since)}.`;
}

init();
