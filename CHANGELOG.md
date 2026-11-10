# Changelog

All notable changes to this project are documented here.

## 1.0.0 — 2026-11-10

Initial release.

### Added

- **BellBridge** Chrome MV3 extension: 16 browser tools, English UI, fixed extension ID via the
  manifest `key`, zero dependencies and zero build.
- Standalone bridge (`scripts/bridge_server.py`): WebSocket protocol, HTTP API, loopback only,
  token-guarded calls.
- CLI entry `scripts/browserctl.py`: `status`, `start`, `stop`, `tools`, `tab-list`, `tab-open`,
  `tab-activate`, `tab-close`, `snapshot`, `get-text`, `click`, `type`, `press`, `scroll`,
  `navigate`, `back`, `forward`, `reload`, `wait`, `eval`.
- Snapshot engine with element indices, forms and frames sections, plus region and delta modes.
- iframe support through the `--frame` parameter.
- `browser_eval` through CDP `Runtime.evaluate` (`chrome.debugger`).
- Keep-alive alarm so the MV3 service worker reconnects after being suspended.
- Bilingual documentation (English default, Chinese variants).

### Known limitations

- `browser_eval` supports the main frame only.
- Bridge heartbeat keep-alive is not implemented; idle connections reconnect about every
  120 seconds.
