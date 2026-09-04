<p align="center">
  <img src="https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/docs/assets/rolepod-uiproof-banner.png" alt="Rolepod uiproof — Browser Verification" width="100%" />
</p>

# rolepod-uiproof

**rolepod-uiproof gives Claude Code, Cursor, Codex CLI, Gemini CLI, and Antigravity (CLI + IDE) a real browser/mobile driver — so the AI can actually click through your UI, audit accessibility, measure Core Web Vitals, check console errors, inspect network requests, diff screenshots, audit on-page SEO, and scaffold e2e tests instead of guessing.**

One MCP server, one tool surface, nine skills you invoke from chat. Web is production-ready via Playwright; iOS and Android use Appium (same client as alumnium — needs a local Appium daemon + simulator/emulator, or a real device). No internal LLM — your Lead agent drives every action.

**v0.8 sharpens `visual_diff` for animated UIs** — `settle` (default on) scrolls + freezes the page so scroll-reveal / lazy content is captured instead of baselined blank; `selector` scopes a diff to one element; dimension mismatches degrade gracefully; plus a new `extract_computed_style` tool that reads an element's computed CSS for pixel-faithful redesign. 31 tools total (22 atomic + 9 composite). v0.7 added the measurement surface — Core Web Vitals, page-weight budgets, and on-page SEO. New in v0.7: `/measure-cwv` (LCP/INP/CLS via PerformanceObserver), `/audit-page-budget` (HAR-classified byte budget with third-party tagging), `/audit-seo` (DOM-based on-page SEO: title, meta, h1, lang, viewport, canonical, robots, OG/Twitter Cards, JSON-LD, hreflang, favicon). v0.5 had completed the UI verification surface (interaction + capture).

## What it helps with

- **Verify a UI change in seconds.** `/verify-ui` opens a real browser, runs your steps, checks your assertions, saves a screenshot + replay bundle (optionally HAR + video + trace + console logs).
- **Gate merges on "no regressions during this flow".** `/check-errors` runs a flow with strict `no_console_errors` + `no_failed_requests` assertions baked in. PR-gate or post-merge smoke check.
- **Catch a11y regressions before merge.** `/audit-a11y` runs axe-core against WCAG-A / AA / AAA and returns issues grouped by severity, with WCAG references and fix links.
- **Lock down the visual contract.** `/visual-diff` captures a screenshot and compares against a named baseline under `./.rolepod-uiproof/baselines/`. First call seeds; subsequent calls diff. By default it settles the page first (scrolls to trigger reveal/lazy content + freezes animations) so reveal-heavy pages are captured fully-rendered; pass `selector` to diff a single element.
- **Turn an interactive verify run into a real test file.** `/scaffold-e2e` transcribes a replay bundle into Playwright Test, Vitest+Playwright, or pytest+selenium — with first-class codegen for every step + expect kind. Mobile targets get Maestro YAML flows (`framework: "maestro"`) with TC-ID traceability in filenames, headers, and tags.
- **Reproduce + minimize a bug deterministically.** `/verify-ui` with `mode: "reproduce"` runs ddmin step-elimination to find the shortest still-reproducing sequence.
- **Discover flows on an app you have no source for.** `/discover-flows` crawls a running app read-only (same-origin, hard budget caps), maps pages/links/forms, and proposes a TC-ID/P1-P2 test-case table whose step sequences feed `/verify-ui` unchanged. Destructive-looking actions are flagged, never executed.

## The nine skills

| Skill | Wraps | What it does |
|---|---|---|
| `/verify-ui` | `verify_ui_flow` | Drive a session through steps, evaluate assertions (incl. console errors / failed requests / specific request made / response status), save evidence (screenshot / console / HAR / video / trace / a11y_tree) + replay bundle. `mode: assert` or `reproduce` with optional ddmin minimization. |
| `/check-errors` | `verify_ui_flow` | Thin wrapper with strict `no_console_errors` + `no_failed_requests` baked in. Use as PR-gate or post-merge smoke. |
| `/audit-a11y` | `audit_a11y` | axe-core audit at WCAG-A / AA / AAA. `scope: "page"` or `scope: { ref }`. Markdown or JSON report. |
| `/visual-diff` | `visual_diff` | Pixel diff against a named baseline. Auto-seeds on first call. Configurable threshold + pixelmatch sensitivity. `settle` (default on) scrolls + freezes the page so scroll-reveal/lazy content is captured; `selector` scopes the diff to one element; size mismatches degrade gracefully (overlap diff + deltas, not a hard error). |
| `/scaffold-e2e` | `scaffold_e2e` | Generate a runnable test file from a scenario + optional replay bundle. Four target frameworks — three web + Maestro YAML flows for mobile (TC-ID carried in filename/header/tags). v0.5 codegen handles every step + expect kind. |
| `/measure-cwv` | `measure_cwv` | Measure Core Web Vitals (LCP / INP / CLS) on a live page via PerformanceObserver. Verdict per web.dev good / needs-improvement / poor bands. Chromium-only. |
| `/audit-page-budget` | `audit_page_budget` | HAR-classified byte budget per asset category (js/css/image/font) with third-party tagging. Compares against declared budget, returns graduated pass/warn/fail. |
| `/audit-seo` | `audit_seo` | On-page SEO check via DOM inspection: title, meta description, h1, lang, viewport, canonical, robots, OG + Twitter Cards, JSON-LD validity, hreflang, favicon. |
| `/discover-flows` | `discover_flows` | Black-box flow discovery: crawl a running app (GET-only, same-origin, hard budget caps), derive candidate flows + a proposed TC-ID/P1-P2 test-case table. Flow steps are `/verify-ui`-compatible; destructive actions flagged, never executed; GET-form interaction opt-in with dummy data. |

Every skill is **single-backend** (D-024) — it calls the rolepod-uiproof server and only the rolepod-uiproof server. If the server is unavailable, the skill fails with a clear diagnostic. Multi-backend routing belongs in the parent [`rolepod`](https://github.com/nuttaruj/rolepod) plugin's phase skills, not here.

## Standalone vs Combined

`rolepod-uiproof` works either as a **standalone** browser MCP for any project, or **combined** with the [`rolepod`](https://github.com/nuttaruj/rolepod) parent plugin (v2.7+) where it becomes the Verify phase provider for UI artifacts.

**Standalone** (default): use the 9 skills directly as atomic browser tools. Evidence saved under `./.rolepod-uiproof/artifacts/<run>/` with a `manifest.json` per Extension Protocol v1.

**Combined with rolepod parent**: when the parent's SessionStart hook drops the marker file `<git-root>/.rolepod/parent-active` (single line of content = the protocol version, e.g. `v1`), uiproof writes evidence to `<git-root>/.rolepod/evidence/<ts>-rolepod-uiproof-<skill>/` instead, where parent's `check-work` skill auto-aggregates manifests into the verify report. The marker is re-detected per run, so a marker the parent writes after this server has already started is still honoured; no env-var, no daemon. To force combined mode without a parent session: `mkdir -p .rolepod && echo v1 > .rolepod/parent-active`. No skill changes — same 31 tools, same 9 skills, smarter routing.

**Offline / registry-blocked machines**: the spawn configs fetch `@rolepod/uiproof` via `npx`, which needs npm-registry access. On an air-gapped or registry-blocked host, install once with `npm i -g @rolepod/uiproof@0.17.1` and set the MCP `command` to the global `rolepod-uiproof` binary (drop the `npx` / `-y` args) so no fetch is required at spawn time.

**First launch after install or update can take minutes and look like a hang.** Every new version is a fresh `npx` cache entry: the cold install pulls the full dependency tree (roughly 280 packages / 270 MB, most of it the optional `webdriverio` mobile backend) and on a slow link exceeds the MCP client's startup timeout. Claude Code then reports `Failed to connect — CONNECTION_CLOSED` and caches that failure for ~15 minutes, so the *next* session fails too even though the install has finished. Warm starts take 2-3 s. To avoid it, pre-warm the cache right after installing or updating, before opening an agent session:

```bash
npx -y @rolepod/uiproof@0.17.1 --help
```

or use the global-binary spawn config above, which never fetches at launch. Running the server from inside a checkout of *this* repo is a separate trap: `npx` sees the local `package.json` with the same name and version, skips the registry, and fails with `rolepod-uiproof: command not found` — use the repo's own `.mcp.json` (`node dist/bin/rolepod-uiproof.js`) there instead.

**Artifacts from authenticated sessions are credentials.** A HAR or Playwright trace recorded while logged in contains the session's auth cookies. uiproof redacts `Cookie`, `Set-Cookie` and `Authorization` headers from `network.har` when the session closes; `trace.zip` is not redacted. Tool results that surface these paths carry a `credentials_note` / `har_note` reminder. Do not attach them to issues, PRs, or shared drives. To start a run already authenticated without burning a login or one-time-link URL each time, pass `storage_state` (absolute path to a Playwright storageState JSON) to `browser_open`.

| Install | Unlocks |
|---|---|
| uiproof alone | Browser test, a11y audit, visual diff, e2e scaffold, error gate |
| uiproof + rolepod parent | + verify-phase aggregation, evidence handoff to `check-work` |

The `manifest.json` is written in BOTH modes, so installing the parent later still lets historic artifacts get picked up. Baselines for `/visual-diff` always live in `./.rolepod-uiproof/baselines/` regardless of mode — they are user-curated configuration, not per-run evidence. The evidence/artifacts root self-ignores in git: on its first write uiproof drops a `.gitignore` (`*`) there, so a `git add -A` in your repo never sweeps transient screenshots + manifests into a commit. Baselines are left out of that ignore — commit them if you want a shared golden set.

## Install

Pick your CLI. All install paths share the same MCP server (`@rolepod/uiproof` on npm) and the same skill set.

### Claude Code (recommended)

```bash
# Install
claude plugin marketplace add nuttaruj/rolepod-uiproof
claude plugin install rolepod-uiproof@rolepod-uiproof

# Update
claude plugin marketplace update rolepod-uiproof
claude plugin install rolepod-uiproof@rolepod-uiproof

# Uninstall
claude plugin uninstall rolepod-uiproof@rolepod-uiproof
claude plugin marketplace remove rolepod-uiproof
```

The plugin auto-registers all nine skills (`/verify-ui`, `/check-errors`, `/audit-a11y`, `/visual-diff`, `/scaffold-e2e`, `/measure-cwv`, `/audit-page-budget`, `/audit-seo`, `/discover-flows`) AND spawns the MCP server (`npx -y @rolepod/uiproof`) on session start.

### Cursor IDE

Cursor's plugin marketplace is enterprise-only (Free / Pro plans cannot install marketplace plugins). For everyone else, drop the workspace MCP config:

```bash
# Per project — copy from this repo, or run:
mkdir -p .cursor
curl -fsSL https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/.cursor/mcp.json -o .cursor/mcp.json

# Or global (across every project)
mkdir -p ~/.cursor
curl -fsSL https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/.cursor/mcp.json -o ~/.cursor/mcp.json
```

Then **fully restart Cursor** — MCP servers load only at startup. Verify under **Settings → MCP**.

Skills are not auto-registered under Cursor (no unified plugin format for skills + MCP in one). The MCP tools are still available; invoke them by name in chat (`Use verify_ui_flow to …`).

> **Teams / Enterprise:** add `https://github.com/nuttaruj/rolepod-uiproof` as a team marketplace under **Settings → Plugins** for one-click install with skills auto-registered.

### Codex CLI

```bash
# Install
codex plugin marketplace add nuttaruj/rolepod-uiproof
codex plugin add rolepod-uiproof@rolepod-uiproof

# Update
codex plugin marketplace upgrade rolepod-uiproof
codex plugin add rolepod-uiproof@rolepod-uiproof
```

Codex reads the plugin from `.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` in this repo. Skills install to `~/.codex/skills/` (Codex's plugin loader handles registration).

### Gemini CLI

Install directly from the GitHub repo:

```bash
# Install
gemini extensions install https://github.com/nuttaruj/rolepod-uiproof

# Update
gemini extensions update rolepod-uiproof

# Disable / re-enable
gemini extensions disable rolepod-uiproof
gemini extensions enable rolepod-uiproof

# Uninstall
gemini extensions uninstall rolepod-uiproof
```

Gemini CLI clones the repo into `~/.gemini/extensions/rolepod-uiproof/`, reads `gemini-extension.json` at the root, spawns the MCP server (`npx -y @rolepod/uiproof`), and auto-discovers all 9 skills from `skills/<name>/SKILL.md`. After install, **restart the CLI session** — Gemini loads extensions on startup, and `gemini extensions install` is not supported in interactive mode.

Verify with `/extensions list` inside the CLI.

### Antigravity (CLI + IDE)

Antigravity reads from `~/.gemini/` but at different sub-paths than Gemini CLI — MCP config and skills must be wired manually.

**Step 1 — Skills:**

```bash
# Copy uiproof skills into Antigravity's shared skills dir
mkdir -p ~/.gemini/skills
git clone --depth 1 https://github.com/nuttaruj/rolepod-uiproof /tmp/rolepod-uiproof
cp -r /tmp/rolepod-uiproof/skills/* ~/.gemini/skills/
rm -rf /tmp/rolepod-uiproof
```

If you already installed via Gemini CLI (`gemini extensions install`), symlink instead:

```bash
ln -s ~/.gemini/extensions/rolepod-uiproof/skills/measure-cwv ~/.gemini/skills/measure-cwv
# repeat for each of the 9 skills, or:
for d in ~/.gemini/extensions/rolepod-uiproof/skills/*/; do
  ln -s "$d" ~/.gemini/skills/$(basename "$d")
done
```

**Step 2 — MCP server:**

Open Antigravity Settings → Customizations → **Open MCP Config** (or edit `~/.gemini/config/mcp_config.json` directly). Add the `rolepod-uiproof` entry to the `mcpServers` map:

```json
{
  "mcpServers": {
    "rolepod-uiproof": {
      "command": "npx",
      "args": ["-y", "@rolepod/uiproof@0.17.1"]
    }
  }
}
```

Restart Antigravity. Verify the MCP server is connected via Settings → Customizations → MCP Servers panel.

**Notes:**
- Antigravity's `mcp_config.json` is shared across all Agy tools (CLI + IDE) — one config, both surfaces.
- Skills are auto-discovered from `~/.gemini/skills/` — no manifest needed.
- The 31 MCP tools surface in chat the same way as in Claude Code / Cursor / Codex.

### Direct npm (any MCP-aware tool)

Use this when your tool reads a standard `mcpServers` config (most non-CLI MCP clients):

```json
{
  "mcpServers": {
    "rolepod-uiproof": {
      "command": "npx",
      "args": ["-y", "@rolepod/uiproof@0.17.1"]
    }
  }
}
```

31 MCP tools (21 `browser_*` atomics + `extract_computed_style` + 9 composites including `verify_ui_flow`, `audit_a11y`, `visual_diff`, `scaffold_e2e`, `extract_ui_state`, `measure_cwv`, `audit_page_budget`, `audit_seo`, `discover_flows`) will appear in your client. Skills are not surfaced via this path — call the tools by name.

## Quick start

After install, in your Claude Code / Cursor / Codex session:

```
/verify-ui https://example.com
  steps: []
  expect: text_visible "Example Domain", text_visible "Learn more"
```

Returns a `run_id`, `passed: true`, and a path under `./.rolepod-uiproof/artifacts/verify_<run_id>/`:

```
.rolepod-uiproof/artifacts/verify_20260524T101512_a1b2c3d4/
├── final.png            screenshot at end of run
└── replay.json          replay bundle — re-runnable via `npx @rolepod/uiproof replay …`
```

Convert that to a Playwright Test file:

```
/scaffold-e2e from .rolepod-uiproof/artifacts/verify_…/replay.json using playwright-test
```

## Verify your setup

```bash
npx @rolepod/uiproof doctor
```

```
✓ Node ≥20                       24.14.0
✓ Playwright Chromium installed  ~/Library/Caches/ms-playwright
✓ webdriverio (mobile client)
✓ Appium (mobile server)         found via path install
✓ Appium drivers                 uiautomator2, xcuitest
• Appium server                  Not running at 127.0.0.1:4723 — auto-started on first mobile session
✓ Xcode (iOS)                    /Applications/Xcode.app
✓ iOS simulators                 4 available
• Android SDK                    Set ANDROID_HOME — needed only for Android
• Android devices (adb)          No emulator/device connected
• SeleniumEngine (roadmap v0.4)  Not implemented — deferred to v0.4
✓ Artifact root writable
```

`✓` = ready · `•` = optional / deferred · `✗` = blocker.

## Mobile (iOS / Android)

Mobile is auto-provisioned the same way browsers are: the first `ios`/`android`
session installs Appium + the platform driver if missing and starts the daemon
for you. Or provision ahead of time:

```bash
npx @rolepod/uiproof install:mobile              # installs Appium + drivers now
npx @rolepod/uiproof install:mobile --checklist  # just print the manual steps
```

Only two things can't be automated and stay manual:

- **iOS** — Xcode + an iOS Simulator (macOS only). Verify: `xcrun simctl list devices`
- **Android** — Android SDK with `ANDROID_HOME` set + a running emulator/device. Verify: `adb devices`

Environment overrides: `APPIUM_HOST` / `APPIUM_PORT` / `APPIUM_BASE_PATH` point at
an existing Appium server (a remote host disables auto-start);
`ROLEPOD_NO_AUTO_APPIUM=1` turns auto-provisioning off entirely.

## What's inside

- **31 MCP tools** — 22 atomic browser/mobile primitives (`browser_open`, `_close`, `_snapshot`, `_click`, `_type`, `_key`, `_scroll`, `_wait_for`, `_screenshot`, `_navigate`, plus v0.5 additions `_hover`, `_drag`, `_fill_form`, `_upload_file`, `_handle_dialog`, `_console`, `_network`, `_set_env`, `_evaluate`, `_pages`, `_switch_page`, and v0.8 `_extract_computed_style`) + 9 composites (`verify_ui_flow`, `audit_a11y`, `visual_diff`, `scaffold_e2e`, `extract_ui_state`, v0.7: `measure_cwv`, `audit_page_budget`, `audit_seo`, and v0.16: `discover_flows`). All prefixed `*` to namespace away from other MCP servers.
- **2 engines behind one interface** — `PlaywrightEngine` for web (Chromium / Firefox / WebKit), `AppiumEngine` for iOS XCUITest + Android UIAutomator2. The Lead sees one unified `A11yNode` shape regardless of platform.
- **Stable refs with explicit invalidation (D-010)** — every state-changing call invalidates prior refs; the engine returns a structured `stale_ref` error if you try to reuse one. No silent locator drift.
- **Replay bundles** — every `/verify-ui` run writes a JSON replay you can re-run later with `npx @rolepod/uiproof replay <bundle.json>`, agent-free.
- **No internal LLM (D-004)** — your Lead agent makes every decision. We don't double-bill you for inference.

## Use with parent rolepod

If you also use [`rolepod`](https://github.com/nuttaruj/rolepod) (the markdown plugin), its `check-work`, `debug-issue`, and `review-code` skills auto-route to `/verify-ui`, `/audit-a11y`, and `/visual-diff` when the rolepod-uiproof server is present. Nothing breaks if it isn't — parent falls back to Playwright MCP / Chrome DevTools MCP / manual verification.

The two are **independent**: install rolepod-uiproof standalone and get a complete experience via slash commands, or install both together and let parent's phase router pick the right backend automatically.

## Docs

- [docs/sessions.md](docs/sessions.md) — session lifecycle, stale-ref semantics, multi-session
- [docs/artifacts.md](docs/artifacts.md) — `.rolepod-uiproof/` layout, run_id convention, replay bundle format
- [docs/recipes/](docs/recipes/) — `verify-a-checkout-flow`, `audit-a11y-during-review`, `visual-baseline-workflow`
- [CHANGELOG.md](CHANGELOG.md) — release history with per-version "Not yet verified" notes mapped to milestones
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

MIT licensed — see [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md). Mobile AT normalizers are alumnium-inspired ([UPSTREAM_TRACKING.md](UPSTREAM_TRACKING.md)). Feedback + runtime reports for Cursor / Codex / Gemini install paths especially welcome via [issues](https://github.com/nuttaruj/rolepod-uiproof/issues).
