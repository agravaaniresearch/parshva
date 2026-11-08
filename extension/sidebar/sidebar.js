import { api, getState, save, addUsage } from "../lib/store.js";
import { streamChat, estimateTokens } from "../lib/providers.js";
import { renderMarkdown, setHTML, mdToPlain } from "../lib/markdown.js";

const $ = (id) => document.getElementById(id);
const svg = (inner, size = 18, extra = "") =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${extra ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const SEND_ICON = svg('<path d="M12 19V5M5 12l7-7 7 7"/>');
const STOP_ICON = svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 16, "fill");
const COPY_ICON = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>');
const CHECK_ICON = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const RETRY_ICON = svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>');

const MAX_PAGE_CHARS = 40000;
const MAX_CONVERSATIONS = 100;
const ESTIMATE_HINT =
  "Estimate for the page text plus your standing instructions, at roughly four characters per token. The provider's real token counts appear under each reply.";

let state;
let conv = newConv();
let controller = null;
let streamingBody = null;
let renderQueued = false;

let page = { tabId: null, url: "", title: "", chars: null, tokens: null, error: null };
const convByUrl = new Map(); // in-memory only: restores a page's chat when you return to it
let myWindowId = null;
let estSeq = 0;
let syncTimer = null;
let syncForce = false;

function newConv() {
  return { id: crypto.randomUUID(), title: "New chat", messages: [], updated: Date.now() };
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

const fmt = (n) => Number(n || 0).toLocaleString();
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const isWeb = (u) => /^https?:\/\//i.test(u || "");
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href;
  } catch {
    return u || "";
  }
}

/* ---------- setup ---------- */

async function init() {
  state = await getState();
  const win = await api.windows.getCurrent();
  myWindowId = win.id;
  setHTML($("btn-send"), SEND_ICON);
  setHTML($("btn-copy").querySelector(".ico"), COPY_ICON);
  setHTML($("btn-retry").querySelector(".ico"), RETRY_ICON);
  fillModels();
  syncPageChip();
  renderAll();
  bind();
  consumePending();
  await syncPage(true);

  api.tabs.onActivated.addListener((info) => {
    if (info.windowId === myWindowId) scheduleSync(false);
  });
  api.tabs.onUpdated.addListener((id, change, tab) => {
    if (tab.windowId !== myWindowId || !tab.active) return;
    if (change.url || change.status === "complete" || change.title) scheduleSync(change.status === "complete");
  });
  api.storage.onChanged.addListener((changes) => {
    if (changes.pending?.newValue) consumePending();
    if (changes.providers || changes.active) {
      getState().then((s) => {
        state = s;
        fillModels();
        if (!conv.messages.length) renderAll();
      });
    }
  });
}

function bind() {
  $("btn-new").onclick = () => {
    if (controller) controller.abort();
    conv = newConv();
    convByUrl.delete(page.url);
    hideNotice();
    renderAll();
    $("input").focus();
  };
  $("btn-settings").onclick = () => api.runtime.openOptionsPage();
  $("btn-history").onclick = openHistory;
  $("btn-history-close").onclick = () => ($("history").hidden = true);
  $("btn-send").onclick = () => (controller ? controller.abort() : submit());
  $("btn-page").onclick = togglePage;
  $("btn-copy").onclick = (e) => copyLast(false, e.currentTarget);
  $("btn-plain").onclick = (e) => copyLast(true, e.currentTarget);
  $("btn-retry").onclick = retry;
  $("model-select").onchange = (e) => {
    const [providerId, ...rest] = e.target.value.split("::");
    state.active = { providerId, model: rest.join("::") };
    save({ active: state.active });
  };
  const input = $("input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!controller) submit();
    }
  });
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

function fillModels() {
  const sel = $("model-select");
  sel.replaceChildren();
  let first = null;
  for (const p of state.providers) {
    const group = el("optgroup", { label: p.name });
    for (const m of p.models || []) {
      group.append(el("option", { value: `${p.id}::${m}`, text: m }));
      first ??= { providerId: p.id, model: m };
    }
    if (group.children.length) sel.append(group);
  }
  if (!first) {
    sel.append(el("option", { value: "", text: "No models yet: open Settings" }));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const a = state.active;
  const valid = a && state.providers.some((p) => p.id === a.providerId && (p.models || []).includes(a.model));
  state.active = valid ? a : first;
  sel.value = `${state.active.providerId}::${state.active.model}`;
}

function syncPageChip() {
  $("btn-page").setAttribute("aria-pressed", String(!!state.settings.includePage));
}

async function togglePage() {
  const turningOn = !state.settings.includePage;
  if (turningOn) {
    const ok = await api.permissions.request({ origins: ["<all_urls>"] });
    if (!ok) return showNotice("Page access was not granted, so the page text cannot be sent.");
  }
  state.settings.includePage = turningOn;
  await save({ settings: state.settings });
  syncPageChip();
  hideNotice();
  renderPageBar();
  refreshEstimate();
}

async function consumePending() {
  const { pending } = await api.storage.local.get("pending");
  if (!pending || Date.now() - pending.ts > 60000) return;
  await api.storage.local.remove("pending");
  const input = $("input");
  input.value = `Regarding this text:\n\n${pending.text}\n\n`;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/* ---------- current page, per-page chats, token estimate ---------- */

function scheduleSync(force) {
  syncForce = syncForce || force;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const f = syncForce;
    syncForce = false;
    syncPage(f);
  }, 250);
}

async function syncPage(force = false) {
  const [t] = await api.tabs.query({ active: true, windowId: myWindowId });
  if (!t) return;
  const url = normUrl(t.url || "");
  const changed = url !== page.url;
  if (changed) switchConversation(url);
  page.tabId = t.id;
  page.url = url;
  page.title = t.title || url;
  if (changed || force) {
    page.chars = null;
    page.tokens = null;
    page.error = null;
    renderPageBar();
    await refreshEstimate();
  } else {
    renderPageBar();
  }
}

// A new page starts a clean chat; coming back to a page restores its chat (kept in memory only).
function switchConversation(url) {
  if (controller) controller.abort();
  if (conv.messages.length) convByUrl.set(page.url, conv);
  conv = convByUrl.get(url) || newConv();
  hideNotice();
  renderAll();
}

async function refreshEstimate() {
  const seq = ++estSeq;
  if (!state.settings.includePage || !isWeb(page.url)) {
    page.chars = null;
    page.tokens = null;
    page.error = null;
    renderPageBar();
    return;
  }
  try {
    const ctx = await getPageContext();
    if (seq !== estSeq) return;
    const text = ctx.text.slice(0, MAX_PAGE_CHARS);
    page.chars = text.length;
    page.tokens = estimateTokens(text) + estimateTokens(state.settings.systemPrompt || "");
    page.error = null;
  } catch (e) {
    if (seq !== estSeq) return;
    page.chars = null;
    page.tokens = null;
    page.error = e.message;
  }
  renderPageBar();
}

function renderPageBar() {
  const bar = $("pagebar");
  bar.replaceChildren();
  if (!page.url) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.title = page.url;
  let right;
  if (!isWeb(page.url)) right = "Cannot read this page";
  else if (!state.settings.includePage) right = "Page text off";
  else if (page.error) right = "Cannot read this page";
  else if (page.chars != null) right = `${fmt(page.chars)} chars · ≈${fmtTok(page.tokens)} tokens`;
  else right = "Reading page…";
  const pc = el("span", { class: "pc", text: right });
  if (page.chars != null) pc.title = ESTIMATE_HINT;
  bar.append(el("span", { class: "pt", text: page.title || page.url }), pc);
}

async function getPageContext() {
  const has = await api.permissions.contains({ origins: ["<all_urls>"] });
  if (!has) throw new Error("Page access is not granted. Turn the Page chip off and on again.");
  const [tab] = await api.tabs.query({ active: true, windowId: myWindowId });
  if (!tab) throw new Error("No active tab.");
  const [res] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const sel = String(getSelection() || "");
      return {
        title: document.title,
        url: location.href,
        text: sel.trim() ? sel : document.body ? document.body.innerText : "",
        selected: !!sel.trim(),
      };
    },
  });
  return res.result;
}

/* ---------- notices ---------- */

function showNotice(text, retryFn) {
  const n = $("notice");
  n.replaceChildren(document.createTextNode(text));
  if (retryFn) n.append(el("button", { text: "Retry", onclick: retryFn }));
  n.hidden = false;
}
function hideNotice() {
  $("notice").hidden = true;
}

/* ---------- rendering ---------- */

function renderAll() {
  const box = $("messages");
  box.replaceChildren();
  streamingBody = null;
  if (!conv.messages.length) {
    box.append(emptyState());
  } else {
    conv.messages.forEach((m, i) => box.append(messageEl(m, i)));
  }
  box.scrollTop = box.scrollHeight;
  updateActionBar();
}

function updateActionBar() {
  const last = conv.messages.at(-1);
  $("actionbar").hidden = !(last && last.role === "assistant" && !controller);
}

function setSendState(streaming) {
  setHTML($("btn-send"), streaming ? STOP_ICON : SEND_ICON);
  $("btn-send").title = streaming ? "Stop" : "Send";
  updateActionBar();
}

function emptyState() {
  const hasModels = !$("model-select").disabled;
  if (!hasModels) {
    return el(
      "div",
      { class: "empty" },
      el("h2", { text: "Parshva" }),
      el("p", { text: "Add a provider and a model to begin." }),
      el("button", { class: "primary", text: "Open settings", onclick: () => api.runtime.openOptionsPage() })
    );
  }
  const ask = (prompt) => async () => {
    if (!state.settings.includePage) await togglePage();
    if (state.settings.includePage) submit(prompt);
  };
  return el(
    "div",
    { class: "empty" },
    el("h2", { text: "Parshva" }),
    el("p", { text: "Ask about this page, or anything else." }),
    el(
      "div",
      { class: "starters" },
      el("button", { text: "Summarise this page", onclick: ask("Summarise this page in a few sentences.") }),
      el("button", { text: "List the key points", onclick: ask("List the key points of this page as short bullets.") })
    )
  );
}

function sourceEl(s) {
  const title = s.title || s.url;
  const head = isWeb(s.url)
    ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", text: title })
    : el("span", { class: "src-title", text: title });
  return el(
    "div",
    { class: "source" },
    el("span", { class: "src-label", text: s.selection ? "Selection from" : "Source" }),
    head,
    el("div", { class: "src-url", text: s.url })
  );
}

function usageText(u) {
  return `${fmt(u.input)} in · ${fmt(u.output)} out tokens`;
}

function messageEl(m, index) {
  if (m.role === "user") {
    const wrap = el("div", { class: "msg user" });
    if (m.page) wrap.append(el("div", { class: "pagetag", text: `Page: ${m.page}` }));
    wrap.append(el("div", { class: "bubble", text: m.content }));
    return wrap;
  }
  const wrap = el("div", { class: "msg assistant" });
  if (m.source) wrap.append(sourceEl(m.source));
  const body = el("div", { class: "md" });
  setHTML(body, renderMarkdown(m.content));
  decorateCode(body);
  wrap.append(body);
  const isLast = index === conv.messages.length - 1;
  if (isLast && controller) {
    body.classList.add("cursor");
    streamingBody = body;
  } else {
    if (m.usage) wrap.append(el("div", { class: "usage", text: usageText(m.usage) }));
    if (!isLast) {
      wrap.append(
        el("div", { class: "actions" }, el("button", { text: "Copy", onclick: (e) => copy(buildCopy(m, false), e.currentTarget) }))
      );
    }
  }
  return wrap;
}

function decorateCode(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const btn = el("button", { class: "copy-code", text: "Copy" });
    btn.onclick = () => copy(pre.querySelector("code").textContent, btn);
    pre.append(btn);
  }
}

// What gets copied: the source title and address first, then the answer.
export function buildCopy(m, plain) {
  const head = m.source ? `Source: ${m.source.title}\n${m.source.url}\n\n` : "";
  return head + (plain ? mdToPlain(m.content) : m.content);
}

async function copy(text, btn) {
  const lbl = btn.querySelector?.(".lbl") || btn;
  const ico = btn.querySelector?.(".ico");
  try {
    await navigator.clipboard.writeText(text);
    const old = lbl.textContent;
    lbl.textContent = "Copied";
    if (ico && btn.id === "btn-copy") setHTML(ico, CHECK_ICON);
    setTimeout(() => {
      lbl.textContent = old;
      if (ico && btn.id === "btn-copy") setHTML(ico, COPY_ICON);
    }, 1400);
  } catch {
    showNotice("Could not access the clipboard.");
  }
}

function copyLast(plain, btn) {
  const m = conv.messages.at(-1);
  if (m && m.role === "assistant") copy(buildCopy(m, plain), btn);
}

function scheduleStreamRender(msg) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!streamingBody) return;
    const box = $("messages");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    setHTML(streamingBody, renderMarkdown(msg.content));
    decorateCode(streamingBody);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

/* ---------- history ---------- */

function openHistory() {
  const list = $("history-list");
  list.replaceChildren();
  const convs = [...state.conversations].sort((a, b) => b.updated - a.updated);
  if (!convs.length) list.append(el("li", { class: "none", text: "No saved chats yet." }));
  for (const c of convs) {
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          {
            class: "open",
            onclick: () => {
              if (controller) controller.abort();
              conv = structuredClone(c);
              hideNotice();
              renderAll();
              $("history").hidden = true;
            },
          },
          el("span", { class: "t", text: c.title }),
          el("span", { class: "d", text: new Date(c.updated).toLocaleString() })
        ),
        el("button", {
          class: "icon",
          title: "Delete",
          "aria-label": "Delete chat",
          text: "×",
          onclick: async () => {
            state.conversations = state.conversations.filter((x) => x.id !== c.id);
            await save({ conversations: state.conversations });
            if (conv.id === c.id) conv = newConv();
            renderAll();
            openHistory();
          },
        })
      )
    );
  }
  $("history").hidden = false;
}

async function persist(c) {
  if (!c.messages.length) return;
  c.updated = Date.now();
  const first = c.messages.find((m) => m.role === "user");
  c.title = (first?.content || "New chat").replace(/\s+/g, " ").trim().slice(0, 60);
  const others = state.conversations.filter((x) => x.id !== c.id);
  state.conversations = [structuredClone(c), ...others].slice(0, MAX_CONVERSATIONS);
  await save({ conversations: state.conversations });
}

/* ---------- sending ---------- */

// Builds the system prompt (with page text when the Page chip is on) and the source record.
async function withPage() {
  let system = state.settings.systemPrompt || "";
  let source = null;
  if (state.settings.includePage) {
    try {
      const ctx = await getPageContext();
      const body = ctx.text.length > MAX_PAGE_CHARS ? ctx.text.slice(0, MAX_PAGE_CHARS) + "\n[truncated]" : ctx.text;
      system += `\n\nThe user is viewing a web page. Title: ${ctx.title}\nURL: ${ctx.url}\nContent of ${ctx.selected ? "their selection" : "the page"}:\n<page>\n${body}\n</page>`;
      source = { title: ctx.title || ctx.url, url: ctx.url };
      if (ctx.selected) source.selection = true;
    } catch (e) {
      showNotice(`Could not read the page (${e.message}). Sending without it.`);
    }
  }
  return { system, source };
}

async function submit(preset) {
  const input = $("input");
  const text = (preset ?? input.value).trim();
  if (!text || controller) return;
  if (!state.active) return showNotice("Add a provider and model in Settings first.");
  const provider = state.providers.find((p) => p.id === state.active.providerId);
  if (!provider) return showNotice("The selected provider no longer exists.");

  hideNotice();
  const { system, source } = await withPage();
  conv.messages.push({
    role: "user",
    content: text,
    page: source ? (source.selection ? `${source.title} (selection)` : source.title) : null,
  });
  if (preset === undefined) {
    input.value = "";
    autosize();
  }
  await run(provider, system, source);
}

async function run(provider, system, source) {
  const target = conv;
  const model = state.active.model;
  const reply = { role: "assistant", content: "" };
  if (source) reply.source = source;
  target.messages.push(reply);
  const mine = new AbortController();
  controller = mine;
  setSendState(true);
  renderAll();

  const history = target.messages.slice(0, -1);
  let failed = null;
  let usage = null;
  try {
    for await (const delta of streamChat({
      provider,
      model,
      messages: history,
      system,
      signal: mine.signal,
      onUsage: (u) => (usage = u),
    })) {
      reply.content += delta;
      if (conv === target) scheduleStreamRender(reply);
    }
  } catch (e) {
    if (e.name !== "AbortError") failed = e;
  } finally {
    if (controller === mine) {
      controller = null;
      setSendState(false);
    }
    if (!reply.content) {
      const i = target.messages.indexOf(reply);
      if (i >= 0) target.messages.splice(i, 1);
    } else if (usage && (usage.input || usage.output)) {
      reply.usage = usage;
      addUsage(provider.name, model, usage.input, usage.output).catch(() => {});
    }
    if (conv === target) renderAll();
    await persist(target);
  }
  if (failed && conv === target) {
    showNotice(failed.message || "Request failed.", () => {
      hideNotice();
      retry();
    });
  }
}

async function retry() {
  if (controller) return;
  while (conv.messages.length && conv.messages.at(-1).role === "assistant") conv.messages.pop();
  if (!conv.messages.length) return renderAll();
  const provider = state.providers.find((p) => p.id === state.active?.providerId);
  if (!provider) return showNotice("Pick a model first.");
  hideNotice();
  const { system, source } = await withPage();
  await run(provider, system, source);
}

init();
