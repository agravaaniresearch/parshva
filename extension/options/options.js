import { api, getState, save, newProvider, PRESETS, applyTheme, patchSettings } from "../lib/store.js";
import { DEFAULT_PROMPTS, systemFor, TRIGGER } from "../lib/prompts.js";
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

let toastTimer = null;
// Large, colour-coded notification. kind: ok | warn | bad
function notify(kind, title, msg) {
  const t = $("toast");
  const icon = { ok: "\u2713", warn: "!", bad: "\u2717" }[kind] || "i";
  t.className = "toast " + kind;
  t.replaceChildren(
    el("div", { class: "ticon", text: icon }),
    el("div", { class: "tbody" }, el("strong", { text: title }), el("div", { text: msg || "" })),
    el("button", { class: "tclose", type: "button", "aria-label": "Dismiss", text: "\u00D7", onclick: () => (t.hidden = true) })
  );
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "ok" ? 6000 : 12000);
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
      if (!ok) {
        notify("bad", "Permission declined", `Parshva needs permission to reach ${p.name} before it can fetch models.`);
        return say("Permission to reach this server was declined.", true);
      }
      say("Fetching...");
      try {
        const ids = await listModels(p);
        const fresh = ids.filter((id) => !catalog.has(id)).length;
        ids.forEach((id) => catalog.add(id));
        drawList();
        say(`${ids.length} fetched, ${fresh} new. Tick the ones to show in the sidebar, then Save.`);
        notify("ok", `${p.name}: ${ids.length} models fetched`, `${fresh} new. Tick the ones to show in the sidebar, then press Save.`);
      } catch (e) {
        say(e.message, true);
        notify("bad", `${p.name}: could not fetch models`, e.message);
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
      if (!ok) {
        notify("bad", "Permission declined", `Parshva needs permission to reach ${p.name} before it can test the key.`);
        return say("Permission to reach this server was declined.", true);
      }
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
      const st = p.keyStatus || { state: "error", message: "No result." };
      say(st.message || "", st.state === "invalid");
      const kinds = { ok: ["ok", "Key works"], unverified: ["warn", "Key could not be verified"], invalid: ["bad", "Invalid key"], network: ["warn", "Network error"], error: ["warn", "Test failed"] };
      const [kind, label] = kinds[st.state] || ["warn", "Test failed"];
      notify(kind, `${p.name}: ${label}`, st.message || "");
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
      notify("ok", `${p.name} saved`, p.keyStatus ? `${p.models.length} model${p.models.length === 1 ? "" : "s"} shown in the sidebar.` : "Press Test key to check that the key works.");
    },
  });

  const collapseBtn = el("button", { class: "secondary", type: "button", text: "Collapse", onclick: () => (d.open = false) });
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
    el("summary", {}, el("span", { class: "chev", text: "\u25B8" }), dot, el("span", { text: p.name }), el("span", { class: "sub", text: p.baseUrl }), badge),
    el(
      "div",
      { class: "card-body" },
      field("Name", name),
      field("API type", kind, "Use OpenAI-compatible for almost everything, including Grok, Qwen, OpenRouter and local servers."),
      field("Base URL", url),
      field("API key", keyRow, mask()),
      field("Models", models, "Fetching adds to this list and never removes anything. Tick the models you want in the sidebar picker, such as a stronger one for technical work."),
      el("div", { class: "row" }, testBtn, fetchBtn, saveBtn, status, collapseBtn, del)
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
  for (const k of ["summary", "context", "ask"]) $("p-" + k).value = state.settings.prompts[k];
  const drawPreview = (k) => {
    const sys = systemFor({ prompts: { [k]: $("p-" + k).value }, format: state.settings.format }, k);
    const user = k === "ask" ? "(your typed question)" : TRIGGER;
    $("pv-" + k).textContent = `SYSTEM:\n${sys}\n\n[the page title, URL and page text are added here when Page is on]\n\nUSER:\n${user}`;
  };
  window.__drawPreviews = () => ["summary", "context", "ask"].forEach(drawPreview);
  for (const k of ["summary", "context", "ask"]) {
    $("p-" + k).addEventListener("input", () => drawPreview(k));
    drawPreview(k);
  }
  for (const b of document.querySelectorAll("[data-reset]")) {
    b.onclick = (e) => {
      e.preventDefault();
      $("p-" + b.dataset.reset).value = DEFAULT_PROMPTS[b.dataset.reset];
      $("p-" + b.dataset.reset).dispatchEvent(new Event("input"));
    };
  }
  for (const r of document.querySelectorAll('input[name="format"]')) {
    r.checked = r.value === state.settings.format;
    r.onchange = async () => {
      state.settings.format = r.value;
      await patchSettings({ format: r.value });
      window.__drawPreviews();
      notify("ok", `Answer format: ${r.value === "list" ? "List" : "Paragraph"}`, "Used for new answers and shown for all answers in the sidebar.");
    };
  }
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
    const prompts = {};
    for (const k of ["summary", "context", "ask"]) prompts[k] = $("p-" + k).value.trim() || DEFAULT_PROMPTS[k];
    state.settings.prompts = prompts;
    await patchSettings({ prompts });
    $("settings-status").textContent = "Saved.";
    notify("ok", "Prompts saved", "They are used from your next Summarise, Context or typed question.");
  };
  applyTheme(state.settings.theme);
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === (state.settings.theme || "auto");
    r.onchange = async () => {
      state.settings.theme = r.value;
      applyTheme(r.value);
      await patchSettings({ theme: r.value });
      notify("ok", `Theme: ${r.value === "auto" ? "Auto" : r.value === "light" ? "Light" : "Dark"}`, r.value === "auto" ? "Following your system setting." : "Applied to Settings and the sidebar.");
    };
  }
  $("collapse-all").onclick = () => document.querySelectorAll("details.card").forEach((d) => (d.open = false));
  $("expand-all").onclick = () => document.querySelectorAll("details.card").forEach((d) => (d.open = true));
  render();
  renderUsage();
  $("reset-usage").onclick = async () => {
    await api.storage.local.set({ usage: {}, usageDaily: {} });
    renderUsage();
  };
  api.storage.onChanged.addListener((c) => {
    if (c.usage || c.usageDaily) renderUsage();
    if (c.settings?.newValue) {
      const n = c.settings.newValue;
      for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === (n.theme || "auto");
      for (const r of document.querySelectorAll('input[name="format"]')) r.checked = r.value === (n.format || "list");
      state.settings.format = n.format || "list";
      window.__drawPreviews();
      applyTheme(n.theme || "auto");
    }
  });
}

const nf = (v) => Number(v || 0).toLocaleString();
const compact = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k" : String(v));

// Bar charts built from plain elements: tokens per day (last 14 days) and sent vs received per model.
function renderCharts(usage, daily) {
  const box = $("usage-charts");
  box.replaceChildren();
  if (!Object.keys(usage).length) return;
  const legend = el("div", { class: "legend2" }, el("span", { class: "sw sent" }), "Sent", el("span", { class: "sw recv" }), "Received");

  // per day
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    days.push({ key, d, v: daily[key] || { input: 0, output: 0 } });
  }
  const dmax = Math.max(1, ...days.map((x) => x.v.input + x.v.output));
  const cols = el("div", { class: "cols" });
  for (const x of days) {
    const tot = x.v.input + x.v.output;
    const stack = el("div", { class: "stack", title: `${x.d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}: ${nf(x.v.input)} sent, ${nf(x.v.output)} received` });
    stack.append(el("div", { class: "seg-recv", style: `height:${(x.v.output / dmax) * 100}%` }), el("div", { class: "seg-sent", style: `height:${(x.v.input / dmax) * 100}%` }));
    cols.append(el("div", { class: "col" }, el("div", { class: "cval", text: tot ? compact(tot) : "" }), stack, el("div", { class: "clab", text: String(x.d.getDate()) })));
  }
  const hasDaily = days.some((x) => x.v.input || x.v.output);
  box.append(
    el("div", { class: "chart" }, el("div", { class: "chead" }, el("strong", { text: "Tokens per day, last 14 days" }), legend),
      hasDaily ? cols : el("p", { class: "status", text: "Daily bars start filling from your next reply." }))
  );

  // per model
  const rows = Object.entries(usage).map(([k, u]) => ({ k: k.replace("::", " / "), i: u.input || 0, o: u.output || 0 })).sort((a, b) => b.i + b.o - (a.i + a.o)).slice(0, 8);
  const mmax = Math.max(1, ...rows.map((r) => r.i + r.o));
  const bars = el("div", { class: "hbars" });
  for (const r of rows) {
    bars.append(
      el("div", { class: "hrow" },
        el("div", { class: "hlab", text: r.k, title: r.k }),
        el("div", { class: "htrack", title: `${nf(r.i)} sent, ${nf(r.o)} received` },
          el("div", { class: "seg-sent", style: `width:${(r.i / mmax) * 100}%` }),
          el("div", { class: "seg-recv", style: `width:${(r.o / mmax) * 100}%` })),
        el("div", { class: "hval", text: compact(r.i + r.o) }))
    );
  }
  box.append(el("div", { class: "chart" }, el("div", { class: "chead" }, el("strong", { text: "Tokens by model" }), legend.cloneNode(true)), bars));
}

async function renderUsage() {
  const { usage, usageDaily } = await api.storage.local.get({ usage: {}, usageDaily: {} });
  renderCharts(usage, usageDaily);
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
