const api = globalThis.browser ?? globalThis.chrome;

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
