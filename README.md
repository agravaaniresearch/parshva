<p align="center">
  <img src="extension/icons/icon-128.png" width="96" alt="Parshva icon">
</p>

<h1 align="center">Parshva</h1>

<p align="center"><em>A Firefox sidebar that gives you the context around a page, not just a summary of it.</em></p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Parshva in light and dark themes, showing a Context answer beside a web page" width="760">
</p>

**Parshva** (Sanskrit for "side") is an AI sidebar for Firefox. It reads the page you are on and answers using a provider you choose, with your own API keys. There is no server, no account and no telemetry. Requests go straight from your browser to the provider you configured.

## Why it exists

Most page summarisers compress an article into fewer words. That is useful for speed, but it hides the thing a careful reader actually needs: who is speaking, what situation the page belongs to, what it assumes you already know, and what it leaves out. Parshva has two buttons for two different jobs.

- **Summarise** gives at most five short points. It is deliberately cheap.
- **Context** gives the situation behind the page in eight fixed labels: Source, Situation, Background, Actors, Framing, Evidence, Omitted and Verify. The labels are identical every time, so answers from different pages can be compared side by side.

The default Context prompt asks the model to start from the page, to mark any background it adds with "(outside the page)", to say so when something is unclear instead of guessing, and not to treat any outlet, institution or country as a neutral default.

## Screenshots

The screenshots below are the shipped interface, captured in a headless browser. The model replies and the news page are invented sample content, so no real provider was called and no real article is quoted.

| Context | Summarise | Model picker |
|---|---|---|
| <img src="docs/screenshots/sidebar-context-light.png" width="260" alt="Context answer in the light theme"> | <img src="docs/screenshots/sidebar-summary-light.png" width="260" alt="Five-point summary in the light theme"> | <img src="docs/screenshots/sidebar-model-picker.png" width="260" alt="Provider and model picker"> |

| Dark theme | History | Ready state |
|---|---|---|
| <img src="docs/screenshots/sidebar-context-dark.png" width="260" alt="Context answer in the dark theme"> | <img src="docs/screenshots/sidebar-history.png" width="260" alt="Searchable history grouped by day"> | <img src="docs/screenshots/sidebar-empty-light.png" width="260" alt="The sidebar before any answer"> |

**Settings** hold providers, editable prompts and a usage dashboard.

<img src="docs/screenshots/settings-providers.png" width="720" alt="Settings page listing providers with key status">

<img src="docs/screenshots/settings-prompts.png" width="720" alt="Editable Summarise, Context and Ask prompts">

<img src="docs/screenshots/settings-usage.png" width="720" alt="Token usage charts and table by provider and model">

## Philosophy

These principles are written into the build specification and shape every feature.

1. **Your prompt is the whole instruction.** The code never appends hidden text. What you save in Settings is exactly what is sent, and "Show exactly what is sent" displays it. The only substitution is the `{format}` placeholder.
2. **Credit-sensitive.** Summarise and Context send only their own instruction, never the earlier chat. Reply length is capped where the API allows it. The page bar shows an estimated token count before you send, and each reply shows the provider's real counts.
3. **Honest output.** Every answer records its source (page title and address), and the Copy button puts that source first, so a pasted answer never loses its origin.
4. **Bring your own key, keep it local.** Keys live in the browser profile and are sent only to the provider they belong to. The manifest declares that no data is collected.
5. **Small and auditable.** Plain JavaScript modules with no runtime dependencies and no build step for the extension itself. The whole code base is under three thousand lines.
6. **A calm identity.** Warm saffron on cream in light mode, warm charcoal in dark mode, and no blue anywhere.

## Features

- Any OpenAI-compatible provider (Grok, Qwen via DashScope, OpenRouter, DeepSeek, Groq, Mistral, OpenAI, Ollama, LM Studio, or a custom address) plus Claude through Anthropic's native API.
- Streaming replies with Markdown, tables and copyable code blocks. The renderer escapes everything and allows only http, https and mailto links.
- **Page** chip: sends the current page text (or your selection) with your message. Page access is requested only when you turn it on.
- Right-click selected text, then "Ask Parshva", to start a chat about it.
- Paragraph or List format, remembered and applied to every answer.
- Copy, Plain text (Markdown stripped), Retry and Clear summary buttons on each answer.
- Searchable history grouped by day, kept locally in the browser.
- Key testing with a status badge, and a model picker that lists only providers whose key passed.
- Usage dashboard: tokens per day for 14 days, sent versus received by model, and a table per provider.
- Light, Dark or Auto theme.

## Install

Download `parshva.xpi` from the latest [release](../../releases). In Firefox open `about:addons`, click the gear icon, choose "Install Add-on From File" and select the file. Open the sidebar from the toolbar sidebar button or with `Alt+Shift+P`, then add a provider under Settings. Firefox 140 or later is required.

## Privacy

Parshva has no backend. Your key and your chats stay in the browser profile, and a page is sent only to the provider you selected, and only when the Page chip is on or you use the context menu. Providers do not expose credit balances through API keys, so the usage table counts tokens rather than money.

## Build and release

```
npm install
npm test          # provider, prompt and Markdown tests
npm run lint      # web-ext lint
npm run build     # unsigned zip in dist/
npx web-ext run --source-dir extension   # launches Firefox with the extension loaded
```

A GitHub Actions workflow ([`release.yml`](.github/workflows/release.yml)) runs the tests and linter on every push that touches `extension/`, sets the version (the committed major and minor, plus the run number as the patch), signs the add-on on Mozilla's unlisted channel and publishes `parshva.xpi` as a GitHub Release. To enable signing, create Mozilla API keys at <https://addons.mozilla.org/developers/addon/api/key/> and add them as the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Without the secrets the workflow still builds, but the package is unsigned.

## Layout

- `extension/lib/providers.js`: request building, SSE parsing and model listing for both API types
- `extension/lib/prompts.js`: default prompts, modes and the `{format}` placeholder
- `extension/lib/markdown.js`: dependency-free Markdown renderer
- `extension/lib/store.js`: storage, settings migration and usage accounting
- `extension/sidebar/`: the chat UI
- `extension/options/`: provider, prompt and usage settings
- `test/`: unit tests for the pure layers
- `Parshva-Spec.md`: a self-contained specification for rebuilding Parshva in other browsers

## Porting to other browsers

[`Parshva-Spec.md`](Parshva-Spec.md) describes the product, the provider and prompt layers and the Firefox-to-Chromium differences in enough detail for a person or an LLM to rebuild it for Chrome, Edge or another browser.

## Licence

Apache 2.0. See [LICENSE](LICENSE).

---

# Changelog

## v0.2.0

- A new page starts a clean chat; returning to a page restores its chat (kept in memory only).
- Every answer records its source (page title and URL), and the Copy output starts with it.
- Prominent Copy button, plus Plain text (Markdown stripped) and Retry.
- Page bar shows the page size and an estimated token count before you send; each reply shows the provider's real input/output tokens.
- Settings has a Usage table of tokens per provider and model. Providers do not expose credit balances through API keys.

## v0.3.0

- Sidebar model picker shows the active provider and model, grouped by provider, listing only providers whose key passed a test (all providers, with a note, until a test has run).
- Settings: masked keys with Show/Hide, a Test key button and a status badge (works, invalid, network error, could not verify). Tests run in the background page.
- Clearer Usage table: sent vs received, replies, average sent, last used, grouped by provider.

## v1.0.0

- History lists each chat with its page title and source URLs, grouped by day (newest first), with a search over titles, URLs and text.
- Answer buttons: Copy, Plain text, List format (bullets, no extra tokens; click again for Paragraphs), Retry and Clear summary (with Undo).
- A labelled New chat button; the previous chat stays in History.
- More space between the source card and the answer.
- Settings: large colour-coded notifications, collapsible provider cards (plus Collapse all / Expand all).
- Theme: Light, Dark or Auto in Settings; the sidebar header button cycles through them.
- New icon.

## v1.0.1

- Fixed: prompts saved in Settings were not always used. The sidebar kept an old copy of the settings and could overwrite new prompts when you toggled Page or Theme. Settings are now changed key by key and read from storage at every send.
- Summarise and Context buttons at the top, each with its own editable prompt (plus an Ask prompt for typed questions). They send only their own instruction, not the earlier chat, and cap the reply length on Claude.
- Paragraph or List is a remembered setting that applies to every answer and is added to the prompt automatically.
- Usage charts: tokens per day (14 days) and sent vs received by model.

## v1.0.2

- Prompts: what you save in Settings is now the entire system prompt. The code no longer appends hidden format text; the only substitution is the `{format}` placeholder. The user turn sent by Summarise and Context is a neutral line that carries no instructions.
- Settings shows "Show exactly what is sent" under each prompt, and each answer is tagged with the prompt used (default or yours).
- Context default is longer (about 500 to 700 words, larger reply cap); Summarise stays at five short points. Unedited earlier defaults, and the old 300-word prompt, are upgraded automatically; edited prompts are kept.
