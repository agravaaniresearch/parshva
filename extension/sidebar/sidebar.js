import { api, getState, save, addUsage, applyTheme } from "../lib/store.js";
import { streamChat, estimateTokens, isUsable, keySig, originPattern } from "../lib/providers.js";
import { renderMarkdown, setHTML, mdToPlain, toListFormat } from "../lib/markdown.js";

const $ = (id) => document.getElementById(id);
const svg = (inner, size = 18, extra = "") =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${extra ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const SEND_ICON = svg('<path d="M12 19V5M5 12l7-7 7 7"/>');
const STOP_ICON = svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 16, "fill");
const COPY_ICON = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>');
const CHECK_ICON = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const THEME_ICONS = {
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
};
const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
const THEME_LABEL = { auto: "Auto (follows your system)", light: "Light", dark: "Dark" };
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
  applyTheme(state.settings.theme);
  drawTheme();
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
  backgroundTests();
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
    if (changes.settings?.newValue && changes.settings.newValue.theme !== state.settings.theme) {
      state.settings.theme = changes.settings.newValue.theme || "auto";
      applyTheme(state.settings.theme);
      drawTheme();
    }
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
  $("btn-new").onclick = newChat;
  $("btn-theme").onclick = async () => {
    state.settings.theme = THEME_NEXT[state.settings.theme || "auto"];
    applyTheme(state.settings.theme);
    drawTheme();
    await save({ settings: state.settings });
    toast(`Theme: ${THEME_LABEL[state.settings.theme]}`);
  };
  $("btn-list").onclick = toggleList;
  $("btn-clear").onclick = clearSummary;
  $("history-search").addEventListener("input", renderHistory);
  $("btn-settings").onclick = () => api.runtime.openOptionsPage();
  $("btn-history").onclick = openHistory;
  $("btn-history-close").onclick = () => ($("history").hidden = true);
  $("btn-send").onclick = () => (controller ? controller.abort() : submit());
  $("btn-page").onclick = togglePage;
  $("btn-copy").onclick = (e) => copyLast(false, e.currentTarget);
  $("btn-plain").onclick = (e) => copyLast(true, e.currentTarget);
  $("btn-retry").onclick = retry;
  $("model-btn").onclick = (e) => {
    e.stopPropagation();
    $("model-menu").hidden ? openMenu() : closeMenu();
  };
  document.addEventListener("click", (e) => {
    if (!$("model-menu").hidden && !e.target.closest(".modelpick")) closeMenu();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  const input = $("input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!controller) submit();
    }
  });
}

function drawTheme() {
  const t = state.settings.theme || "auto";
  const b = $("btn-theme");
  setHTML(b, THEME_ICONS[t]);
  b.title = `Theme: ${THEME_LABEL[t]}. Click to change.`;
  b.setAttribute("aria-label", b.title);
}

let toastTimer = null;
function toast(text, action) {
  const t = $("toast");
  t.replaceChildren(el("span", { text }));
  if (action) t.append(el("button", { type: "button", text: action.label, onclick: () => { hideToast(); action.fn(); } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : 3500);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

function newChat() {
  if (controller) controller.abort();
  const hadChat = conv.messages.length > 0;
  conv = newConv();
  convByUrl.delete(page.url);
  hideNotice();
  renderAll();
  $("input").focus();
  toast(hadChat ? "New chat started. The previous chat is saved in History." : "This is already a new, empty chat.");
}

function lastExchange() {
  const msgs = conv.messages;
  if (!msgs.length || msgs.at(-1).role !== "assistant") return null;
  let i = msgs.length - 1;
  while (i > 0 && msgs[i - 1].role === "user") i--;
  return i; // index where the removable exchange starts (last user messages plus the answer)
}

async function clearSummary() {
  if (controller) return;
  const start = lastExchange();
  if (start == null) return;
  const removed = conv.messages.splice(start);
  const target = conv;
  if (!target.messages.length) {
    state.conversations = state.conversations.filter((x) => x.id !== target.id);
    await save({ conversations: state.conversations });
  } else await persist(target);
  renderAll();
  toast("Summary cleared.", {
    label: "Undo",
    fn: async () => {
      if (conv !== target) return;
      target.messages.push(...removed);
      await persist(target);
      renderAll();
    },
  });
  $("input").focus();
}

async function toggleList() {
  const m = conv.messages.at(-1);
  if (!m || m.role !== "assistant" || controller) return;
  m.view = m.view === "list" ? null : "list";
  await persist(conv, false);
  renderAll();
}

function shownContent(m) {
  return m.view === "list" ? toListFormat(m.content) : m.content;
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

let shown = []; // [{provider, models}] currently offered in the picker
let untested = false;

function fillModels() {
  const withModels = state.providers.filter((p) => (p.models || []).length);
  const ok = withModels.filter(isUsable);
  untested = !ok.length && withModels.length > 0;
  shown = (untested ? withModels : ok).map((p) => ({ provider: p, models: p.models }));
  const btn = $("model-btn");
  if (!shown.length) {
    btn.disabled = true;
    btn.querySelector(".mprov").textContent = "";
    btn.querySelector(".mname").textContent = withModels.length ? "No tested keys: open Settings" : "No models yet: open Settings";
    state.active = null;
    return;
  }
  btn.disabled = false;
  const a = state.active;
  const valid = a && shown.some((g) => g.provider.id === a.providerId && g.models.includes(a.model));
  if (!valid) state.active = { providerId: shown[0].provider.id, model: shown[0].models[0] };
  drawModelBtn();
}

function drawModelBtn() {
  const p = state.providers.find((x) => x.id === state.active?.providerId);
  $("model-btn").querySelector(".mprov").textContent = p ? p.name : "";
  $("model-btn").querySelector(".mname").textContent = state.active?.model || "";
}

function closeMenu() {
  $("model-menu").hidden = true;
  $("model-btn").setAttribute("aria-expanded", "false");
}

function openMenu() {
  const menu = $("model-menu");
  menu.replaceChildren();
  const total = shown.reduce((n, g) => n + g.models.length, 0);
  const list = el("div");
  const draw = () => {
    list.replaceChildren();
    const q = (menu.querySelector(".mfilter")?.value || "").trim().toLowerCase();
    for (const g of shown) {
      const ms = g.models.filter((m) => !q || m.toLowerCase().includes(q) || g.provider.name.toLowerCase().includes(q));
      if (!ms.length) continue;
      list.append(el("div", { class: "mgroup", text: g.provider.name }));
      for (const m of ms) {
        const sel = state.active?.providerId === g.provider.id && state.active?.model === m;
        list.append(
          el(
            "button",
            {
              class: "mitem",
              type: "button",
              role: "option",
              "aria-selected": String(sel),
              onclick: () => {
                state.active = { providerId: g.provider.id, model: m };
                save({ active: state.active });
                drawModelBtn();
                closeMenu();
              },
            },
            el("span", { class: "tick", text: sel ? "\u2713" : "" }),
            el("span", { class: "mid", text: m })
          )
        );
      }
    }
  };
  if (total > 8) {
    const f = el("input", { class: "mfilter", type: "text", placeholder: "Filter models" });
    f.addEventListener("input", draw);
    menu.append(f);
  }
  if (untested) menu.append(el("div", { class: "mnote", text: "Keys not tested yet, so every provider is listed. Test them in Settings to keep only working ones." }));
  menu.append(list, el("button", { class: "mmanage", type: "button", text: "Manage providers and models", onclick: () => api.runtime.openOptionsPage() }));
  draw();
  menu.hidden = false;
  $("model-btn").setAttribute("aria-expanded", "true");
  menu.querySelector(".mfilter")?.focus();
}

// Quietly test any provider whose key has not been checked with its current settings.
async function backgroundTests() {
  for (const p of state.providers) {
    if (isUsable(p) || (p.keyStatus && p.keyStatus.sig === keySig(p))) continue;
    try {
      if (!p.baseUrl || !(await api.permissions.contains({ origins: [originPattern(p.baseUrl)] }))) continue;
      await api.runtime.sendMessage({ type: "test-key", id: p.id });
    } catch {
      /* the next settings change or visit retries */
    }
  }
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
  $("btn-list").querySelector(".lbl").textContent = last?.view === "list" ? "Paragraphs" : "List format";
}

function setSendState(streaming) {
  setHTML($("btn-send"), streaming ? STOP_ICON : SEND_ICON);
  $("btn-send").title = streaming ? "Stop" : "Send";
  updateActionBar();
}

function emptyState() {
  const hasModels = !$("model-btn").disabled;
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
  setHTML(body, renderMarkdown(shownContent(m)));
  decorateCode(body);
  wrap.append(body);
  const isLast = index === conv.messages.length - 1;
  if (isLast && controller) {
    body.classList.add("cursor");
    streamingBody = body;
  } else {
    if (m.usage) wrap.append(el("div", { class: "usage", text: usageText(m.usage), title: "Reported by the provider. Sent covers your question, the chat so far, your standing instructions and the page text. Received is the reply." }));
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
  const body = m.view === "list" ? toListFormat(m.content) : m.content;
  return head + (plain ? mdToPlain(body) : body);
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

function convSources(c) {
  const seen = new Map();
  for (const m of c.messages) if (m.source?.url && !seen.has(m.source.url)) seen.set(m.source.url, m.source.title || m.source.url);
  return [...seen].map(([url, title]) => ({ url, title }));
}

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function openHistory() {
  $("history-search").value = "";
  $("history").hidden = false;
  renderHistory();
  $("history-search").focus();
}

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  const q = $("history-search").value.trim().toLowerCase();
  const convs = [...state.conversations].sort((a, b) => b.updated - a.updated).filter((c) => {
    if (!q) return true;
    const hay = [c.title, ...convSources(c).flatMap((s) => [s.title, s.url]), ...c.messages.map((m) => m.content)].join("\n").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
  if (!convs.length) {
    list.append(el("li", { class: "none", text: q ? "Nothing matches that search." : "No saved chats yet." }));
    return;
  }
  let group = "";
  for (const c of convs) {
    const g = dayLabel(c.updated);
    if (g !== group) {
      group = g;
      list.append(el("li", { class: "hgroup", text: g }));
    }
    const srcs = convSources(c);
    const urls = el("div", { class: "urls" });
    for (const s of srcs.slice(0, 2)) urls.append(isWeb(s.url) ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", title: s.url, text: s.url }) : el("span", { class: "more", text: s.url }));
    if (srcs.length > 2) urls.append(el("div", { class: "more", text: `+${srcs.length - 2} more page${srcs.length - 2 > 1 ? "s" : ""}` }));
    list.append(
      el(
        "li",
        { class: "hitem" },
        el(
          "div",
          { class: "hmain" },
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
            el("span", { class: "d", text: new Date(c.updated).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + (srcs.length ? "" : "  \u00B7  no page attached") })
          ),
          urls
        ),
        el("button", {
          class: "icon",
          title: "Delete this chat from History",
          "aria-label": "Delete chat",
          text: "\u00D7",
          onclick: async () => {
            state.conversations = state.conversations.filter((x) => x.id !== c.id);
            await save({ conversations: state.conversations });
            if (conv.id === c.id) conv = newConv();
            renderAll();
            renderHistory();
          },
        })
      )
    );
  }
}

async function persist(c, touch = true) {
  if (!c.messages.length) return;
  if (touch) c.updated = Date.now();
  const src = c.messages.find((m) => m.source)?.source;
  const first = c.messages.find((m) => m.role === "user");
  c.title = ((src && src.title) || first?.content || "New chat").replace(/\s+/g, " ").trim().slice(0, 80);
  const others = state.conversations.filter((x) => x.id !== c.id);
  const merged = [structuredClone(c), ...others].sort((a, b) => b.updated - a.updated);
  state.conversations = merged.slice(0, MAX_CONVERSATIONS);
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
