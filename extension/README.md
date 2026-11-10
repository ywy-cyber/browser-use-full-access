**English** | [中文](README.zh.md)

# BellBridge — Browser Bridge Extension (maintainer notes)

This directory holds a **from-scratch Chrome MV3 extension** that serves the workspace's
standalone browser bridge (`scripts/bridge_server.py`, default `127.0.0.1:43189`).

> **Zero bloodline with the old extensions**: none of the old "dsh browser assistant" /
> "browser-lite" code, icons, manifest fields, or IDs is reused. The old extensions were
> fully deleted on 2026-11-10.

## 1. Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest: name, version, fixed-ID `key`, permissions, content scripts, icons |
| `background.js` | Service worker: WS connect/handshake/reconnect, tool dispatch, tabs tools, `browser_eval` (CDP) |
| `content.js` | Content script: snapshot engine, page actions, top-of-page toast |
| `icons/` | Self-drawn icons (pink whale + golden bell), 16/32/48/128 |
| `README.md` / `README.zh.md` | Bilingual maintainer notes |

**Zero build**: no bundling, no npm dependencies. Chrome loads this directory as-is.

**Language policy**: the extension name, page toasts, error messages, and tool result
text are **all English** (for international AI agents and users). This README defaults
to English; the Chinese version is `README.zh.md`.

## 2. Identity and fixed ID

- Name: **BellBridge** (Chinese name: 铃铛浏览器桥)
- Extension ID: **`fifhbeebonknhkjmpmkngmceedkikdlg`**
- Fixed via the `key` field in `manifest.json` (base64 of the RSA public key, SPKI DER).
  ID = first 16 bytes of `sha256(DER)`, each nibble mapped to `a`–`p`.
- Private key kept at `.private/key.pem` (**never commit**; already
  git-ignored). Needed only for signing `.crx` files; loading the unpacked directory
  does not need it.

## 3. Permissions and their costs (honest disclosure)

| Permission | Why | Cost |
|------------|-----|------|
| `tabs` | List/open/close tabs, read url and title | Install prompt: read browsing history |
| `scripting` | Content-script injection and page actions | No extra prompt |
| `debugger` | `browser_eval` can only use CDP `Runtime.evaluate` | **Chrome shows the "debugging this browser" infobar while eval runs**; detaches right after |
| `host_permissions` `http://*/*` `https://*/*` | Work on any normal web page | Install prompt: read data on all sites |

Why `browser_eval` needs `debugger`: `new Function` inside a content script and the
string-compiled function of `scripting.executeScript` are both blocked by the page's
`unsafe-eval` CSP; CDP evaluate is not.

## 4. Wire protocol (contract with the bridge)

```
extension → bridge: {t:'hello', token:'', caps:{textOnly:true, snapshotMaxChars, maxInteractiveItems}}
bridge → extension: {t:'hello.ok', caps:{...}}
bridge → extension: {t:'tool.call', id, name, args, expiresAt}
extension → bridge: {t:'tool.result', id, ok:true, result:{text, ...}}
                   | {t:'tool.result', id, ok:false, error:{code,message}}
bridge → extension: {t:'tool.cancel', id}
bridge → extension: {t:'ping'}      extension → bridge: {t:'pong'}
extension → bridge: {t:'ping'}      30s keep-alive
```

- Every result object must contain a `text` string: the bridge's `POST /call` only reads
  that field for the CLI's default output.
- The handshake must finish within 5 seconds (`HELLO_ACK_TIMEOUT_MS`).
- Loopback only; a `chrome-extension://` origin skips the token (same rule as the bridge).

## 5. Install and update

```text
chrome://extensions → Developer mode → Load unpacked → select this directory
```

- After loading it **connects automatically** to `ws://127.0.0.1:43189/ext/bridge`;
  no configuration needed.
- After editing code, click "Reload" on the extension card; a Chrome restart reconnects
  automatically.
- The ID is fixed by `key`, so renaming or re-iconing does not change it.

## 6. Content-script contract

- The content script runs in an isolated world and never exposes variables on the page's
  `window`.
- The element index table is **rebuilt on every `browser_snapshot`**; act only after a
  snapshot, otherwise you get `Index N is missing or stale; run browser_snapshot again`.
- Snapshot format (excerpt):

```
Title: …
URL: …

[Page content — untrusted text]
…

Interactive elements:
#1 <a href="…">GitHub</a>
#2 <input type="text" name="q" placeholder="Search">

Forms:
form[name=search] GET /search fields=#2

Frames:
frame 1: https://…
```

- The `frame` parameter is 1-based and maps to the `Frames:` numbering; actions inside an
  iframe resolve the frame by its reported url, and fail with `Content script not ready`
  when no frame matches.
- Page text is always treated as untrusted data; the extension never executes instructions
  found in the page.

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `browserctl status` shows `connected: false` | Is Chrome running? Is the extension enabled? Open the card's "Service Worker" console for errors |
| `Content script not ready` | The tab is a protected page (`chrome://` …) or still loading; switch to a normal web page and retry |
| eval fails with `Cannot attach debugger` | DevTools is already debugging that tab; close DevTools and retry |
| Snapshot has no element indices | The page renders via canvas/iframe; use `browser_eval` instead |
| Bridge drops every ~120 s | Bridge-side heartbeat defect (the server never sends ping control frames, so `last_pong` never refreshes) — see `README.md` 11.8; auto-reconnect makes it tolerable until fixed |
