# Parshva

An AI chat sidebar for Firefox. Bring your own keys; requests go straight from your browser to the provider you configure.

- Any OpenAI-compatible provider (Grok, Qwen via DashScope, OpenRouter, DeepSeek, Groq, Mistral, OpenAI, Ollama, LM Studio) plus Claude through Anthropic's native API
- Streaming replies with Markdown, tables and copyable code blocks
- Optional page context: sends the current page text (or your selection) with your message
- Right-click selected text, then "Ask Parshva", to start a chat about it
- Chat history stored locally in the browser
- No telemetry and no accounts

## One-time setup for automatic XPI builds

1. Push this repository to GitHub.
2. Create Mozilla API keys at <https://addons.mozilla.org/developers/addon/api/key/> (a free developer account is enough).
3. In the repository go to Settings, Secrets and variables, Actions, and add two repository secrets:
   - `AMO_JWT_ISSUER` (the "JWT issuer" value)
   - `AMO_JWT_SECRET` (the "JWT secret" value)
4. Push to `main`. The workflow runs the tests and the linter, bumps the version, signs the add-on on Mozilla's unlisted channel (automatic, usually a few minutes, no human review) and publishes `parshva.xpi` as a GitHub Release.

From then on every push that touches `extension/` produces a new signed XPI.

## Installing

Download `parshva.xpi` from the latest release. In Firefox open `about:addons`, click the gear icon, choose "Install Add-on From File" and select it. Open the sidebar with the toolbar sidebar button or `Alt+Shift+P`, then add a provider under Settings.

## Local development

```
npm install
npm test          # parser and Markdown tests
npm run lint      # web-ext lint
npm run build     # unsigned zip in dist/
npx web-ext run --source-dir extension   # launches Firefox with the extension loaded
```

## Layout

- `extension/lib/providers.js`: request building, SSE parsing and model listing for both API types
- `extension/lib/markdown.js`: dependency-free Markdown renderer (escapes everything, allows only http, https and mailto links)
- `extension/sidebar/`: the chat UI
- `extension/options/`: provider and prompt settings
- `.github/workflows/release.yml`: build, version, sign, release

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
