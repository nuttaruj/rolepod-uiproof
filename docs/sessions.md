# Sessions

Every interaction with rolepod-uiproof happens inside a **session** — an
opaque handle returned by `browser_open` that ties together a
real browser context (web) or mobile driver (iOS / Android) with the
ref index of its most recent accessibility snapshot.

## Lifecycle

```
browser_open   →  session_id
       │
       ├─ browser_snapshot   (assigns refs e1, e2, …)
       ├─ browser_find       (query → ranked refs, no tree; also re-issues refs)
       ├─ browser_wait_for   (ref_exists → returns matched refs)
       │
       ├─ browser_click(ref) │
       ├─ browser_type(...)  │  ← state-changing calls invalidate refs
       ├─ browser_key(...)   │
       ├─ browser_scroll(..) │
       ├─ browser_navigate   │
       │
       └─ browser_close      (or: composite with close_on_finish: true,
                              or:  idle timeout, or: server shutdown)
```

Every state-changing call **invalidates** every ref from the prior
snapshot. The next call that consumes a ref must be preceded by a fresh
`browser_snapshot`, a `browser_find` / `browser_wait_for { ref_exists }`
(both snapshot internally and hand back only the matching refs — the
cheap path on large pages), or a composite tool that snapshots
internally. Using a stale ref returns a structured error:

```json
{
  "code": "stale_ref",
  "message": "Ref \"e7\" is stale — re-snapshot before retrying.",
  "detail": {
    "session_id": "…",
    "ref": "e7",
    "last_valid_snapshot_at": "2026-05-24T18:00:00Z"
  }
}
```

This is the most common Lead-side bug pattern (calling `click` after
`type` without re-snapshotting). Plan it out of your flow rather than
catching it.

## Multiple sessions per server

One `rolepod-uiproof` process can hold many concurrent sessions — open a
browser session AND an Android emulator session in parallel, route
tool calls by `session_id`. Sessions are serialized per-id (two clicks
on the same session don't fire simultaneously) but parallel across
ids.

## Idle timeout

Default: **5 minutes** of inactivity → the session is closed and
cleaned up automatically (configurable via the `idleTimeoutMs` option
to `buildServer`, env var `ROLEPOD_MCP_IDLE_MS` once exposed).

If the Lead intends to leave a session open across a long
deliberation, periodically call `browser_snapshot` (which counts as
activity) or just plan to re-`browser_open` afterwards. Re-opening is
cheap (~500ms for Chromium).

## Closing rules

A session is closed by any of:

- Explicit `browser_close({ session_id })`.
- A composite tool with `close_on_finish: true` (the default for
  `verify_ui_flow`, `audit_a11y`, `visual_diff`).
- The idle timeout.
- Server shutdown (every open session is closed gracefully on SIGINT
  / SIGTERM).

## Cross-platform consistency

`session.platform` is one of `'web' | 'ios' | 'android'`. The
operations on every session are the **same** — the Lead sees one
schema regardless of platform:

| Op | Web (Playwright) | iOS (Appium / XCUITest) | Android (Appium / UIAutomator2) |
|---|---|---|---|
| `snapshot` | `page.ariaSnapshot({mode:'ai'})` | `driver.getPageSource()` → XCUITest XML | `driver.getPageSource()` → UIAutomator2 XML |
| `click(ref)` | `aria-ref=eN` locator | accessibility-id / class-chain | `~accessibility-id` / `resource-id` / `text` |
| `type(ref, text)` | `locator.fill(text)` | `element.setValue(text)` | `element.setValue(text)` |
| `key(name)` | `page.keyboard.press(name)` | (limited; v0.3+ partial) | `pressKeyCode(code)` |

When in doubt about a behavioural detail, the engine source
(`src/engine/Engine.ts` + `src/engine/PlaywrightEngine.ts` +
`src/engine/AppiumEngine.ts`) is the contract.
