import { api, getState, save } from "../lib/store.js";
import { streamChat } from "../lib/providers.js";
import { renderMarkdown, setHTML } from "../lib/markdown.js";

const $ = (id) => document.getElementById(id);
const SEND_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const MAX_PAGE_CHARS = 40000;
const MAX_CONVERSATIONS = 100;

let state;
let conv = newConv();
let controller = null;
let streamingBody = null;
let renderQueued = false;

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

/* ---------- setup ---------- */

async function init() {
  state = await getState();
  setHTML($("btn-send"), SEND_ICON);
  fillModels();
  syncPageChip();
  renderAll();
  bind();
  consumePending();
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
    hideNotice();
    renderAll();
    $("input").focus();
  };
  $("btn-settings").onclick = () => api.runtime.openOptionsPage();
  $("btn-history").onclick = openHistory;
  $("btn-history-close").onclick = () => ($("history").hidden = true);
  $("btn-send").onclick = () => (controller ? controller.abort() : submit());
  $("btn-page").onclick = togglePage;
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
  const on = !!state.settings.includePage;
  $("btn-page").setAttribute("aria-pressed", String(on));
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

/* ---------- notices ---------- */

function showNotice(text, retry) {
  const n = $("notice");
  n.replaceChildren(document.createTextNode(text));
  if (retry) n.append(el("button", { text: "Retry", onclick: retry }));
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

function messageEl(m, index) {
  if (m.role === "user") {
    const wrap = el("div", { class: "msg user" });
    if (m.page) wrap.append(el("div", { class: "pagetag", text: `Page: ${m.page}` }));
    wrap.append(el("div", { class: "bubble", text: m.content }));
    return wrap;
  }
  const body = el("div", { class: "md" });
  setHTML(body, renderMarkdown(m.content));
  decorateCode(body);
  const isLast = index === conv.messages.length - 1;
  const wrap = el("div", { class: "msg assistant" }, body);
  if (isLast && controller) {
    body.classList.add("cursor");
    streamingBody = body;
  } else {
    const actions = el(
      "div",
      { class: "actions" },
      el("button", { text: "Copy", onclick: (e) => copy(m.content, e.target) })
    );
    if (isLast) actions.append(el("button", { text: "Retry", onclick: retry }));
    wrap.append(actions);
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

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    showNotice("Could not access the clipboard.");
  }
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

async function persist() {
  if (!conv.messages.length) return;
  conv.updated = Date.now();
  const first = conv.messages.find((m) => m.role === "user");
  conv.title = (first?.content || "New chat").replace(/\s+/g, " ").trim().slice(0, 60);
  const others = state.conversations.filter((c) => c.id !== conv.id);
  state.conversations = [structuredClone(conv), ...others].slice(0, MAX_CONVERSATIONS);
  await save({ conversations: state.conversations });
}

/* ---------- sending ---------- */

async function getPageContext() {
  const has = await api.permissions.contains({ origins: ["<all_urls>"] });
  if (!has) throw new Error("Page access is not granted. Turn the Page chip off and on again.");
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
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

async function submit(preset) {
  const input = $("input");
  const text = (preset ?? input.value).trim();
  if (!text || controller) return;
  if (!state.active) return showNotice("Add a provider and model in Settings first.");
  const provider = state.providers.find((p) => p.id === state.active.providerId);
  if (!provider) return showNotice("The selected provider no longer exists.");

  hideNotice();
  let system = state.settings.systemPrompt || "";
  let pageTitle = null;
  if (state.settings.includePage) {
    try {
      const ctx = await getPageContext();
      pageTitle = ctx.selected ? `${ctx.title} (selection)` : ctx.title || ctx.url;
      const body = ctx.text.length > MAX_PAGE_CHARS ? ctx.text.slice(0, MAX_PAGE_CHARS) + "\n[truncated]" : ctx.text;
      system += `\n\nThe user is viewing a web page. Title: ${ctx.title}\nURL: ${ctx.url}\nContent of ${ctx.selected ? "their selection" : "the page"}:\n<page>\n${body}\n</page>`;
    } catch (e) {
      showNotice(`Could not read the page (${e.message}). Sending without it.`);
    }
  }

  conv.messages.push({ role: "user", content: text, page: pageTitle });
  if (preset === undefined) {
    input.value = "";
    autosize();
  }
  await run(provider, system);
}

async function run(provider, system) {
  const reply = { role: "assistant", content: "" };
  conv.messages.push(reply);
  controller = new AbortController();
  setHTML($("btn-send"), STOP_ICON);
  $("btn-send").title = "Stop";
  renderAll();

  const history = conv.messages.slice(0, -1);
  let failed = null;
  try {
    for await (const delta of streamChat({
      provider,
      model: state.active.model,
      messages: history,
      system,
      signal: controller.signal,
    })) {
      reply.content += delta;
      scheduleStreamRender(reply);
    }
  } catch (e) {
    if (e.name !== "AbortError") failed = e;
  } finally {
    controller = null;
    setHTML($("btn-send"), SEND_ICON);
    $("btn-send").title = "Send";
    if (!reply.content) conv.messages.pop();
    renderAll();
    await persist();
  }
  if (failed) {
    showNotice(failed.message || "Request failed.", () => {
      hideNotice();
      retry();
    });
  }
}

async function retry() {
  if (controller) return;
  while (conv.messages.length && conv.messages.at(-1).role === "assistant") conv.messages.pop();
  if (!conv.messages.length) return;
  const provider = state.providers.find((p) => p.id === state.active?.providerId);
  if (!provider) return showNotice("Pick a model first.");
  let system = state.settings.systemPrompt || "";
  if (state.settings.includePage) {
    try {
      const ctx = await getPageContext();
      const body = ctx.text.slice(0, MAX_PAGE_CHARS);
      system += `\n\nThe user is viewing a web page. Title: ${ctx.title}\nURL: ${ctx.url}\n<page>\n${body}\n</page>`;
    } catch {
      /* retry without page */
    }
  }
  await run(provider, system);
}

init();
