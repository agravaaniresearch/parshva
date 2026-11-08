import { api, runKeyTest } from "./lib/store.js";
import { testKey, keySig } from "./lib/providers.js";

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: "ask-selection",
    title: "Ask Parshva about “%s”",
    contexts: ["selection"],
  });
});

api.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "ask-selection") return;
  // sidebarAction.open() must run synchronously inside the user gesture.
  api.sidebarAction.open();
  const text = (info.selectionText || "").trim().slice(0, 20000);
  if (text) api.storage.local.set({ pending: { text, ts: Date.now() } });
});

// Key tests run here so the result is stored even if the settings page is closed.
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "test-key" && typeof msg.id === "string") {
    return runKeyTest(msg.id, testKey, keySig).catch((e) => ({ state: "error", message: String(e.message || e) }));
  }
});
