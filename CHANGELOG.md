# Changelog

All notable changes to this project are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). The schema-stability promise
begins at **v1.0**; until then, breaking changes are possible at any
release.

## [Unreleased]

## [0.12.0] — 2026-06-23

### Changed

- **BREAKING: MCP server key renamed `ui` → `rolepod-uiproof`** (config only — no
  npm code change). v0.10.0 had shortened the `mcpServers` key to `ui` to collapse
  the doubled label segment, but a bare `ui` is unidentifiable in a client's MCP
  server list — it reads as a generic "ui" with no hint of which plugin owns it,
  sitting next to clearly-named entries like `rolepod-wplab`. This release restores
  `rolepod-uiproof` as the key so the server self-identifies and groups with the
  rest of the rolepod family. The tradeoff — a doubled segment in the fully
  qualified tool name (`mcp__plugin_rolepod-uiproof_rolepod-uiproof__browser_open`)
  and identity (`plugin:rolepod-uiproof:rolepod-uiproof`) — is accepted in exchange
  for a legible server list. Standalone `.mcp.json` users get `mcp__rolepod-uiproof__*`.
  Agents that referenced tools by the old `…_ui__*` names must update; permission
  grants keyed on the old names reset. Renamed in all six configs that carry the key
  (`.mcp.json`, `.cursor/mcp.json`, `gemini-extension.json`,
  `.claude-plugin/plugin.json`, and the `plugins/rolepod-uiproof/` mirror of the two
  MCP configs).
- **Distribution versions aligned to `0.12.0` across all clients.** Unlike the
  Claude-only `0.11.0` packaging fix, this key rename touches every client config, so
  the Cursor/Codex/Gemini manifests (still at `0.10.0`) and the Claude manifests (at
  `0.11.0`) are all bumped to `0.12.0`. The npm package is unchanged: `package.json`
  stays `0.10.0`, the `npx` spawn pins stay `@rolepod/uiproof@0.10.0`, and the
  `spawn_version_pin` lockstep test stays green — no republish required.

## [0.11.0] — 2026-06-02

### Changed

- **Lean Claude Code plugin cache (packaging only — no npm code change)** — the
  marketplace plugin `source` moved from `./` (repo root) to
  `./plugins/rolepod-uiproof`, a clean subtree containing only the plugin
  manifest, `.mcp.json`, and `skills/`. Claude Code copies the plugin source
  into its per-version cache and runs `npm install` when it finds a
  `package.json` there; pointing `source` at a `package.json`-free subtree drops
  the per-version cache from ~195 MB (full `node_modules`, mostly devDeps the
  npx-spawned runtime never uses) to well under 1 MB. The runtime is unchanged —
  the MCP server still spawns via `npx -y @rolepod/uiproof@0.10.0`, so the npm
  package is NOT republished and the spawn pins stay at `@0.10.0`. Only the
  plugin **distribution** version bumps to `0.11.0` so Claude Code detects the
  update and reinstalls the lean layout. Other CLIs (Cursor/Codex/Gemini) were
  never affected — they npx-spawn from config and never cached the repo.

## [0.10.0] — 2026-06-01

### Changed

- **BREAKING: tool names dropped the `rolepod_` prefix** — every MCP tool is
  now exposed under its bare name (`browser_open`, `verify_ui_flow`,
  `visual_diff`, …) instead of `rolepod_browser_open` etc. The MCP server
  namespace already scopes the tools, so the prefix was pure redundancy in the
  client display. The five spawn configs also rename the `mcpServers` key from
  `rolepod-uiproof` to `ui`, collapsing the doubled segment in the displayed
  label (`plugin_rolepod-uiproof_rolepod-uiproof: rolepod browser open` →
  `plugin_rolepod-uiproof_ui: browser open`). Agents that referenced tools by
  the old `rolepod_*` names must update; permission grants keyed on the old
  names reset.
- **Spawn configs pin the npm version** — every `npx` spawn config
  (`.mcp.json`, `.cursor/mcp.json`, `gemini-extension.json`,
  `.claude-plugin/plugin.json`, and the `plugins/` mirror) now requests
  `@rolepod/uiproof@<version>` instead of the bare package. The bare spec let
  the npx cache pin a consumer to whatever version was latest at first install
  and never upgrade; pinning makes the cache key version-specific, so updating
  the plugin actually delivers the new tool code. A `spawn_version_pin` test
  enforces that the pins track `package.json`, so a version bump can't ship
  without moving them in lockstep (and publishing the matching npm version).

## [0.9.0] — 2026-05-29

### Added

- **`verify_ui_flow` `scroll` + `settle` steps** — a flow can now trigger
  scroll-reveal content (`opacity:0` / `visibility:hidden` +
  IntersectionObserver) that only appears after a real scroll.
  `{ kind: "scroll", direction, amount? }` scrolls by a delta;
  `{ kind: "settle" }` scrolls the full page to fire every observer + lazy
  load, network-idles, then returns to top (web-only). Closes the gap where a
  reveal-only page could not be driven through a flow without the gated
  `evaluate` step.
- **Evidence dir self-ignores in git** — on its first write `ArtifactStore`
  drops a `.gitignore` containing `*` at the evidence/artifacts root
  (`./.rolepod-uiproof/artifacts/` standalone, `<git-root>/.rolepod/evidence/`
  with-parent), so a consumer's `git add -A` no longer sweeps transient
  screenshots + manifests into a commit. Baselines live elsewhere and stay
  commit-able; in with-parent mode the parent's own `.rolepod/` files are
  untouched.

### Fixed

- **`dist/schemas/tools.json` was empty for every tool** — the build emitted a
  property-less `{$schema}` for all 30 tools because `build:schemas` ran the
  v3-only `zod-to-json-schema` against zod v4 schemas. Switched to zod's native
  `z.toJSONSchema`; the export now carries full per-tool input schemas. Added a
  non-empty guard to `build:schemas` so it fails loudly rather than shipping
  useless schemas again. (Runtime MCP `tools/list` was unaffected — the SDK
  uses its own converter.)

### Removed

- `zod-to-json-schema` build dependency — replaced by native `z.toJSONSchema`.

## [0.8.0] — 2026-05-29

### Added

- **`visual_diff` settle + freeze-motion** — before capture the page is
  scrolled its full height to trigger scroll-reveal (opacity:0 +
  IntersectionObserver) and lazy media, network-idled, then animations are
  frozen via Playwright's native `animations: "disabled"`. Reveal-heavy pages
  are no longer baselined while invisible. New `settle` flag (default **on**).
- **`visual_diff` region scope** — pass `selector` (CSS) to diff a single
  element's bounding box instead of the whole page.
- **`extract_computed_style`** — new read-only tool. Returns the computed CSS
  (typography, color, background/gradient, spacing, border, shadow, layout,
  transform) + bounding box of the first element matching a selector, so a
  redesign can match a reference exactly instead of guessing tokens. 30 tools
  total now (22 atomic + 8 composite).
- **`browser_screenshot` selector + freeze_motion** — the atomic screenshot
  tool can now capture a single element's bounding box (`selector`, web-only)
  and freeze animations (`freeze_motion`), and it reports the capture's
  width/height (previously returned as `undefined`).

### Changed

- **BREAKING (baselines): `visual_diff` `settle` defaults to on.** Captures now
  reflect the fully-rendered, animation-frozen page, so baselines seeded before
  0.8.0 on animated/reveal pages will mismatch on the next diff. **Re-seed
  affected baselines** (delete the PNG under `./.rolepod-uiproof/baselines/`
  and run once). Pass `settle: false` to keep the legacy immediate capture.
- **`visual_diff` dimension mismatch is no longer a hard error** — a
  baseline/current size difference now diffs the overlapping region and reports
  `dimension_mismatch` + width/height deltas (still fails the check) instead of
  throwing `engine_error`.

### Fixed

- Schema export (`dist/schemas/tools.json`) and the public `src/index.ts`
  re-export list were missing newly registered tools. Added a parity guard to
  `export-schemas` — the build now fails if any registered tool lacks an
  exported schema.

## [0.7.1] — 2026-05-28

### Added

- **Gemini CLI support** — `gemini-extension.json` at the repo root.
  Install via `gemini extensions install https://github.com/nuttaruj/rolepod-uiproof`.
  Gemini CLI auto-spawns the MCP server (`npx -y @rolepod/uiproof`) and
  auto-discovers all 8 skills from `skills/<name>/SKILL.md`.
  Manifest schema reference:
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md>.

- **Antigravity (CLI + IDE) install guide** — Antigravity shares the
  `~/.gemini/` namespace with Gemini CLI but reads MCP config from
  `~/.gemini/config/mcp_config.json` and skills from `~/.gemini/skills/`
  (not from inside an extension subdir). README now documents the
  two-step manual wiring: copy/symlink skills + add the mcpServers
  entry. Same 29 tools + 8 skills, same `@rolepod/uiproof` backend.

### Notes

- No code or schema changes — packaging + docs only. The npm package
  contents are functionally identical to 0.7.0. The bump exists so
  marketplaces and plugin caches that key off the version field will
  pick up the new manifest + docs.

## [0.7.0] — 2026-05-28

### Added

- **Measurement surface** — three new composite tools and matching
  skills that turn the live browser into a measurement substrate.
  Complements (does not replace) the existing interaction + capture
  surface shipped in v0.5.

  | Tool | Skill | What it returns |
  |---|---|---|
  | `rolepod_measure_cwv` | `/measure-cwv` | LCP / INP / CLS via PerformanceObserver |
  | `rolepod_audit_page_budget` | `/audit-page-budget` | HAR-classified byte budget per asset category |
  | `rolepod_audit_seo` | `/audit-seo` | On-page SEO findings (title / meta / h1 / lang / OG / JSON-LD / etc.) |

  Tool count 26 → 29. Skill count 5 → 8.

- **CWV injection helper** (`src/engine/cwv.ts`) — `CWV_INJECTION_SCRIPT`
  attaches three PerformanceObservers populating
  `window.__rolepodCwv`. Classification helpers map raw metrics to the
  web.dev good / needs-improvement / poor bands and roll them into an
  overall pass / warn / fail verdict.

- **HAR classifier** (`src/engine/harClassifier.ts`) — pure-utility
  module that reads the HAR file Playwright writes at context shutdown,
  classifies entries by asset category (js / css / image / font /
  other) via MIME-first + URL-extension fallback, detects third-party
  by hostname with an eTLD+1 heuristic and optional allowlist, and
  compares totals to a declared budget.

### Scope rule (locked in v0.7)

uiproof OWNS only what is observable from a running browser. The
following are **explicitly delegated** to the parent rolepod's
`performance-engineer` agent and are not in scope for any uiproof skill:

- Build-time bundle analysis
- Backend p95 / p99 latency
- Synthetic load tests (k6, Locust, Artillery)
- Database query plan / EXPLAIN ANALYZE
- Flame graphs / CPU profiles

SKILL.md frontmatter descriptions for the three new skills are
intentionally free of those terms to avoid prompt-routing collision.
Each skill's body lists them under "When NOT to use" as visible
anti-routing examples.

### Standalone behavior

All three new skills follow the existing `/audit-a11y` pattern —
single-backend (D-024), marker-file aware, manifest emission with
`phase: "verify"`. Standalone runs write to
`./.rolepod-uiproof/artifacts/`; with the parent's marker file
(`<git-root>/.rolepod/parent-active`) they write to
`<git-root>/.rolepod/evidence/<ts>-rolepod-uiproof-<skill>/`.

### Notes

- `measure_cwv` is **chromium-only** — Firefox and WebKit ship partial
  PerformanceObserver coverage for the `largest-contentful-paint`,
  `layout-shift`, and `event` entry types. The tool refuses other
  browsers with the structured error `cwv_unsupported_browser`.
- `measure_cwv` reports INP as `unmeasured` when the call passes no
  `interactions[]` — INP is meaningless without real input and the
  verdict reflects that honestly rather than misreporting a 0.
- `audit_page_budget` requires `close_on_finish: true` (the default) —
  the HAR file is only flushed when the Playwright context closes.

## [0.6.2] — 2026-05-28

### Fixed

- **Plugin MCP server failed to start in fresh sessions** with
  `Failed to reconnect to plugin:rolepod-uiproof:rolepod-uiproof: -32000`.
  Root cause: v0.4.1 changed every `mcpServers` config to invoke
  `npx -y rolepod-uiproof` (unscoped) instead of
  `npx -y @rolepod/uiproof` (scoped). The unscoped name does not
  exist on the npm registry — npx returned `E404` and the spawn
  failed. The earlier "fix" only appeared to work on machines that
  already had `node_modules/.bin/rolepod-uiproof` cached from a
  previous local install; a fresh environment (where Claude Code
  spawns the MCP server in its own subprocess with a clean PATH)
  always 404'd.

  Verified directly: `npx -y rolepod-uiproof` → `npm error code E404`;
  `npx -y @rolepod/uiproof` → MCP server boots, lists 26 tools,
  responds to `initialize`. v0.4.1's premise that npx couldn't
  resolve a scoped package's bin when the bin name didn't match the
  short name was wrong — modern npx exec selects the single
  available bin regardless of naming.

  Reverts the four `mcpServers` invocations + the matching
  documentation:

  - `.mcp.json`
  - `.cursor/mcp.json`
  - `.claude-plugin/plugin.json`
  - `plugins/rolepod-uiproof/.mcp.json`
  - `README.md` (Install snippet)
  - `skills/verify-ui/SKILL.md` + `skills/check-errors/SKILL.md`
    ("If the tool is unavailable" hint)
  - `plugins/rolepod-uiproof/skills/{verify-ui,check-errors}/SKILL.md`
    (mirrors)

  Plugin and standalone consumers must update to v0.6.2 (or override
  the command manually in `.mcp.json`) to get working spawns. The
  package itself was always installable as `@rolepod/uiproof`; only
  the invocation form was broken.

## [0.6.1] — 2026-05-28

### Fixed

- **Extension Protocol v1 detection** swapped from environment variable
  (`ROLEPOD_PARENT=1`) to filesystem marker
  (`<git-root>/.rolepod/parent-active`). The env-var mechanism never
  fired in practice because Claude Code SessionStart hooks cannot
  propagate env to the Bash tool or to the MCP server subprocess
  Claude later spawns. The marker file is what the parent v2.7+ hook
  actually writes — v0.6.1 reads it. **End-to-end combined mode now
  works.**
- Same swap for the protocol-version compatibility warning. Previously
  read `process.env.ROLEPOD_PROTOCOL`; now reads the first trimmed
  line of the marker file content.

### Added

- `src/util/rolepodProtocol.ts` — shared `detectRolepodParent()`
  helper returning `{ active, protocol, gitRoot }`. ArtifactStore and
  the server both call it.

### Changed

- With-parent runs anchor at **git root** (resolved via
  `git rev-parse --show-toplevel`), not at `process.cwd()`. A uiproof
  skill invoked from a subdirectory now lands its evidence under the
  worktree root where parent's `check-work` skill looks — previously
  it would have landed at `<cwd>/.rolepod/evidence/` and been
  invisible to the aggregator.
- Standalone path is unchanged — still anchored at `process.cwd()`.
- All 5 SKILL.md files (+ mirrors under `plugins/`) updated to
  describe the marker mechanism instead of the env var.
- README "Standalone vs Combined" section updated with the marker
  language and the `touch .rolepod/parent-active` force-on hint.

### Removed

- All reads of `process.env.ROLEPOD_PARENT` and
  `process.env.ROLEPOD_PROTOCOL` from runtime code. Only historical
  references remain in JSDoc that explains why the mechanism changed.

### Migration from 0.6.0

No API change. Standalone users see no difference (same evidence
path, same tool output, same `manifest.json`). Combined-mode users
gain working evidence routing — provided the parent plugin actually
writes the marker (parent v2.7+ does).

To force combined mode without a real parent session:

```bash
mkdir -p .rolepod && echo v1 > .rolepod/parent-active
```

To force standalone:

```bash
rm -f .rolepod/parent-active
```

## [0.6.0] — 2026-05-27

**Extension Protocol v1 — `uiproof` becomes parent-aware. Standalone
behavior unchanged.**

When the parent `rolepod` plugin (v2.7+) sets `ROLEPOD_PARENT=1` via
its SessionStart hook, uiproof routes evidence to the shared
`.rolepod/evidence/` tree and emits a `manifest.json` per spec so the
parent's `check-work` skill can aggregate UI verify results into its
phase report. With no parent installed the v0.5 behavior is preserved
exactly — same artifact path, same tool output, plus a `manifest.json`
in each run dir as a bonus.

### Added

- **Env-aware evidence path** in `ArtifactStore`. Detected at
  construction from `process.env.ROLEPOD_PARENT === "1"`.
  - standalone: `.rolepod-uiproof/artifacts/{prefix}_{ts}_{uuid}/`
  - with-parent: `.rolepod/evidence/{ts}-rolepod-uiproof-{skill}/`
- **`manifest.json`** written by every composite that starts a run
  (`verify_ui_flow`, `audit_a11y`, `visual_diff`, `scaffold_e2e`).
  Schema follows Extension Protocol v1: `protocol`, `plugin`, `skill`,
  `phase`, `status`, `summary`, `started_at`, `finished_at`,
  `artifacts: [{type, path}]`, `metadata`. Best-effort: any IO failure
  is logged but never thrown.
- **Graduated a11y status**. `audit_a11y` manifest carries `status`:
  `critical/serious > 0 → fail`, `moderate/minor > 0 → warn`, no
  issues → `pass`. Keeps the `warn` signal a strict pass/fail would
  discard.
- **Protocol version check**. When `ROLEPOD_PROTOCOL` is set but
  does not equal `v1`, `buildServer()` logs a one-shot warning. Does
  not block; manifest is still written in v1 shape.
- **`/check-errors` evidence routing doc** alongside the other 4
  skills.

### Changed

- `ArtifactStore.startRun(prefix, opts?)` — `opts.skill` is new and
  optional. Provides the canonical skill name for both the
  with-parent dirname and the manifest's `skill` field. Return shape
  extended with `skill` and `mode` (back-compat: existing destructuring
  of `{ runId, runDir }` keeps working).
- `buildServer()` log line surfaces `protocol: "v1"` and
  `mode: "standalone" | "with-parent"` alongside the existing version
  + tools list.
- All 5 shipped skills' SKILL.md gained an "Evidence routing" section
  between "Process" / "Outputs" and "If the tool is unavailable".
  Mirrored to `plugins/rolepod-uiproof/skills/`.
- README "Standalone vs Combined" section added explaining the two
  modes.

### Behavior

- **Standalone:** unchanged. Evidence still written to
  `.rolepod-uiproof/artifacts/`. New: a `manifest.json` appears in each
  run dir. Tool return values gain an optional `manifest: "<path>"`
  field; everything else is byte-for-byte identical.
- **With rolepod parent:** evidence written to
  `.rolepod/evidence/<ts>-rolepod-uiproof-<skill>/` with `manifest.json`
  per protocol spec. Visual baselines stay in
  `.rolepod-uiproof/baselines/` regardless of mode.

### Non-goals (kept out of v0.6)

- Dynamic capabilities registry (`.claude-plugin/capabilities.json`)
- Protocol version negotiation beyond a single warn
- Cross-child coordination (uiproof ↔ wplab handoff inside one run)
- Mobile platform support stays at the v0.5 partial level

## [0.5.0] — 2026-05-27

**Complete UI verification surface — one MCP replaces chrome-devtools-mcp
and playwright-mcp for UI testing use cases.**

Tool count: 15 → 26 (atomic 10 → 21, composite 5 unchanged). The five
"out of scope for `uiproof`" families (Lighthouse, performance traces,
heap snapshots, extensions, third-party page tools) are intentionally
**not** added — those belong to future `rolepod-perfproof` and
`rolepod-secproof` MCPs.

### Added — 11 new atomic tools

Cross-platform (work on chromium/firefox/webkit; mobile stubs throw
`engine_error` until gestures land):

- `rolepod_browser_hover` — `locator.hover()`; refs stay valid
- `rolepod_browser_drag` — `locator.dragTo()`
- `rolepod_browser_fill_form` — batch input/select/checkbox/radio
- `rolepod_browser_upload_file` — `locator.setInputFiles()`, abs path required

Web-only (cast to `PlaywrightEngine`):

- `rolepod_browser_handle_dialog` — pre-arm one-shot accept/dismiss
- `rolepod_browser_console` — list/filter/clear ring-buffered console
  messages (1000-entry cap, errors+warnings default)
- `rolepod_browser_network` — list/filter network requests, optional HAR export
- `rolepod_browser_set_env` — runtime viewport / offline / geolocation /
  color_scheme / reduced_motion / extra_headers / network_throttle (CDP) /
  cpu_throttle (CDP)
- `rolepod_browser_evaluate` — arbitrary JS in page context.
  **Disabled by default** — opt in via `ROLEPOD_ALLOW_EVAL=1` env var
- `rolepod_browser_pages` — list pages in active context (popups,
  target=_blank, OAuth windows)
- `rolepod_browser_switch_page` — set active page index

### Added — verify_ui_flow capture lifecycle (impl)

The `capture` array has accepted these values since v0.1, but only
`screenshot` was wired. v0.5 fills in the rest:

- `console` → `{runDir}/console.json`
- `har` → `{runDir}/network.har`
- `video` → `{runDir}/videos/*.webm`
- `trace` → `{runDir}/trace.zip` (view with `npx playwright show-trace`)
- `a11y_tree` → `{runDir}/a11y_tree.json`

### Added — 8 new verify_ui_flow step kinds

`hover`, `drag`, `fill_form`, `upload`, `dialog`, `set_env`,
`switch_page`, `evaluate`. All get first-class codegen in
`scaffold_e2e` for playwright-test and pytest+selenium.

### Added — 4 new verify_ui_flow expect kinds

- `no_console_errors` — filter level=error, drop excludes, count must be 0
- `no_failed_requests` — filter `failure || status>=400` (or `>=500`
  when `allow_4xx`), drop excludes, count must be 0
- `request_made` — URL regex + optional method must match `min_count`
  (default 1) times
- `response_status` — URL regex + exact status code must match

### Added — multi-page support

A session is now a `context` (was a single page). Popups and
`target="_blank"` links are auto-tracked. Use `browser_pages` to list,
`browser_switch_page` to activate. Default active = page 0.

### Added — new skill `/check-errors`

Thin wrapper over `rolepod_verify_ui_flow` with strict assertions baked
in. Use case: PR-gate or post-merge smoke.

### Changed — `/verify-ui` and `/scaffold-e2e` skills

Documented every new step / expect / capture kind. Default suggestion
in `/verify-ui`: include `no_console_errors` and `no_failed_requests`
in `expect` for any user-visible flow.

### Changed — Engine interface

Adds four cross-platform input methods: `hover`, `drag`, `fillForm`,
`uploadFile`. `OpenOptions.capture` accepts `{ har, video, trace }`.
`WebSession.page` renamed to `mainPage`; internal call sites go through
`activePage(s)`.

### Non-changes (intentional)

- `screencast_*` not added — Playwright `trace.zip` is strictly better.
- `click_at` not added — use refs from `snapshot`.
- Lighthouse not added — axe-core covers a11y.
- Performance traces / heap snapshots not added — `rolepod-perfproof` scope.
- Extension management not added — out of scope.

### Migration from 0.4

Pure additions; no behavioral changes on existing tools or
step/expect/capture kinds. Existing replay bundles play back unchanged.

## [0.4.1] — 2026-05-27

### Fixed

- **MCP server failed to start via `npx -y @rolepod/uiproof`** — npx
  resolves a scoped package's default executable by the *short* name
  (`uiproof`, after the `/`), but our `bin` field only defined
  `rolepod-uiproof`. The mismatch caused `sh: rolepod-uiproof: command
  not found` and an MCP `-32000` reconnect error in Claude Code,
  Cursor, etc. All `mcpServers` entries (`.mcp.json`, `.cursor/mcp.json`,
  `.claude-plugin/plugin.json`, `plugins/rolepod-uiproof/.mcp.json`)
  now invoke `npx -y rolepod-uiproof`, which npx resolves directly by
  bin name from the registry.

### Added

- Tool `title` and `annotations` (`readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint`) on all 15 tools, per the MCP
  2025-11-25 spec. Clients use these hints to render friendlier names
  in the picker and to auto-approve read-only calls vs. prompting
  harder on destructive ones.

## [0.4.0] — 2026-05-24

**Breaking: project renamed `rolepod-mcp` → `rolepod-uiproof`.**

Reason: `rolepod-mcp` was too generic for the planned ecosystem
(`rolepod-uiproof`, `rolepod-apiproof`, `rolepod-perfproof`,
`rolepod-secproof` — each a focused "proof of X" MCP). Locking the
generic `-mcp` suffix on the UI/mobile project blocked sibling
naming. Done now while public adoption is effectively zero
(<6 hours since first publish).

### Renamed

| Surface | Before | After |
|---|---|---|
| npm package | `@rolepod/mcp` | `@rolepod/uiproof` |
| GitHub repo | `nuttaruj/rolepod-mcp` | `nuttaruj/rolepod-uiproof` |
| Plugin name | `rolepod-mcp` | `rolepod-uiproof` |
| Marketplace name | `rolepod-mcp` | `rolepod-uiproof` |
| Display name | `Rolepod MCP` | `Rolepod UIProof` |
| CLI bin | `rolepod-mcp` | `rolepod-uiproof` |
| Artifact dir | `./.rolepod-mcp/` | `./.rolepod-uiproof/` |
| Server name constant | `rolepod-mcp` | `rolepod-uiproof` |

### Unchanged (deliberate)

- **MCP tool names stay `rolepod_*`** — these are the org namespace
  (per the project's tool-naming convention), not the project name.
  Sibling MCPs will register their own sub-namespaces (`rolepod_api_*`,
  `rolepod_perf_*`) without collisions.
- The 4 shipped skills' slugs stay `/verify-ui`, `/audit-a11y`,
  `/visual-diff`, `/scaffold-e2e`.
- All input/output schemas unchanged.

### Migration

**npm consumers:**

```bash
npm uninstall @rolepod/mcp
npm install @rolepod/uiproof
```

`@rolepod/mcp@0.3.x` is deprecated on npm with a pointer to
`@rolepod/uiproof`. Existing installs continue to work but will print
a deprecation notice.

**Claude Code marketplace:**

```bash
claude plugin uninstall rolepod-mcp@rolepod-mcp
claude plugin marketplace remove rolepod-mcp
claude plugin marketplace add nuttaruj/rolepod-uiproof
claude plugin install rolepod-uiproof@rolepod-uiproof
```

**Codex CLI:**

```bash
codex plugin remove rolepod-mcp@rolepod-mcp
codex plugin marketplace remove rolepod-mcp
codex plugin marketplace add nuttaruj/rolepod-uiproof
codex plugin add rolepod-uiproof@rolepod-uiproof
```

**Cursor workspace MCP** — re-pull `.cursor/mcp.json`:

```bash
curl -fsSL https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/.cursor/mcp.json -o .cursor/mcp.json
```

**Artifact baselines** — if you have `./.rolepod-mcp/baselines/<id>.png`
files from earlier runs, move them under the new path so visual_diff
finds them:

```bash
mv .rolepod-mcp .rolepod-uiproof
```

**GitHub URLs** — `nuttaruj/rolepod-mcp` returns a permanent 301
redirect to the new URL; existing clones continue to work but should
update their remote:

```bash
git remote set-url origin https://github.com/nuttaruj/rolepod-uiproof.git
```

## [0.3.1] — 2026-05-24

First **live mobile smoke** completed end-to-end against a real iOS
Simulator (iPhone 17, iOS 26.5) via Appium 3.4.2 + xcuitest driver
11.7.1. Settings.app session opened, snapshot parsed to 161-node
A11yNode tree (`application > navigationbar "Settings" > ...`),
session closed cleanly. Doctor reports green for every check that
matters on this host.

### Fixed

- `parseXcuiTestTree` + `parseUiAutomator2Tree`: skip XML declaration
  (`<?xml ... ?>`) and processing instructions when picking the first
  tag. Previously the declaration leaked into the tree as a synthetic
  `?xml` node (e1) alongside the real `AppiumAUT` wrapper.

### Verified live

- `AppiumEngine.open()` against `com.apple.Preferences` on iOS
  Simulator
- `AppiumEngine.snapshot()` → `parseXcuiTestTree()` → 161 typed nodes
- `AppiumEngine.close()` clean teardown

### Notes

- WebDriverAgent first-build takes 3-5 min via xcodebuild; subsequent
  sessions reuse the cached WDA (~5s startup).
- Appium daemon must run with `DEVELOPER_DIR` pointed at the full
  Xcode app (not `/Library/Developer/CommandLineTools`) so the
  iphonesimulator SDK is locatable. `rolepod-mcp install:mobile`
  documents this.
- Android UIAutomator2 smoke still pending — same fix applies to the
  uiautomator2 parser preemptively.

## [0.3.0] — 2026-05-24

Mobile scaffolding + CLI + governance. Web surface unchanged. Mobile
code paths compile and the AT normalizers are unit-tested against
fixture XML; real iOS/Android runs require a local Appium server +
simulator and are gated by `npx rolepod-mcp doctor`.

### Added

- **AppiumEngine** (`src/engine/AppiumEngine.ts`) — full `Engine`
  interface implementation backed by webdriverio + Appium 2.x.
  Routes `platform: 'ios'` to XCUITest, `platform: 'android'` to
  UIAutomator2. webdriverio is lazy-loaded as an
  `optionalDependency`, so web-only installs skip it.
- **Mobile AT normalizers** (`src/engine/a11y/xcuitest.ts`,
  `uiautomator2.ts`) — inspired by alumnium (MIT) per D-005 and
  `UPSTREAM_TRACKING.md`. Original implementations using
  `fast-xml-parser`. Unit tests pass against fixture XML.
- **`audit_a11y` scope={ref}** — tags the resolved element with a
  temporary `data-rolepod-axe-scope` attribute so axe-core can
  include it. Cleans up the tag in `finally`.
- **`rolepod-mcp doctor`** — health check covering Node version,
  Playwright Chromium install, webdriverio availability, Appium
  server reachability, Xcode (macOS), Android SDK, artifact dir.
- **`rolepod-mcp install:mobile`** — prints the iOS + Android setup
  checklist with environment overrides.
- **`rolepod-mcp replay <bundle.json>`** — re-runs a verify_ui_flow
  replay bundle deterministically without an agent in the loop.
  Exit code reflects pass/fail. Brings the v0.4 replay-execution
  feature forward.
- **`ddmin` minimization** (`src/replay/minimize.ts`) — classic
  Zeller-Hildebrandt delta debugging. Replaces the v0.2 linear pass
  inside `verify_ui_flow` reproduce mode.
- **Per-CLI manifests** — `.cursor/mcp.json` (verified against
  [cursor.com/docs/mcp](https://cursor.com/docs/mcp)) and
  `.codex-plugin/plugin.json` (matches parent `rolepod`'s pattern).
  Gemini deferred until the official schema is published.
- **Governance documents** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1, fetched canonically from
  EthicalSource), `SECURITY.md` (responsible disclosure via GitHub
  Security Advisories).
- **`.github/` templates** — bug + feature issue forms (verified
  against the GitHub Issue Forms schema), PR template, CI workflow
  for Node 20/22 × ubuntu/macos/windows running typecheck + tests +
  build + smoke handshake.
- **Public docs** — `docs/sessions.md`, `docs/artifacts.md`, plus
  three recipes in `docs/recipes/`.
- **`UPSTREAM_TRACKING.md`** — records the alumnium commit SHA
  referenced (`94dea1e69…`), the inspired-by vs. literal-fork
  decision, and the quarterly cherry-pick policy.

### Changed

- `SessionRegistry` now tracks `platform` per `session_id`
  authoritatively via `platformOf(sessionId)`. Atomic tools and
  composites consult it instead of hardcoding `'web'`.
- `bin/rolepod-mcp` dispatches subcommands (`serve` default,
  `doctor`, `install:mobile`, `replay`, `--version`, `--help`).
- `factory.ts` splits `createWebEngine` + `createMobileEngine`;
  `createEngine` is kept as a back-compat alias for v0.1 callers.

### Not yet verified — mapped to later milestones

- **Mobile end-to-end runs** — same Appium contract as alumnium;
  needs a local Appium daemon + iOS Simulator (or Android Emulator,
  or real device). `npx rolepod-mcp doctor` reports readiness.
  Code paths compile and AT normalizers are unit-tested against
  fixture XML; live simulator smoke is the v0.3.x test-maturity
  task. Scope: still **v0.3**.
- **SeleniumEngine** — deferred to **v0.4** (legacy Selenium grid
  support, opt-in via `ROLEPOD_MCP_WEB_ENGINE=selenium`). Not
  implemented because verifying it needs a running grid we don't
  have access to in this session.
- **Replay execution beyond what v0.4 specifies** — recording +
  ddmin minimization shipped in v0.3 (the `rolepod-mcp replay`
  CLI re-runs a bundle without an agent in the loop). Full
  replay-determinism guarantees, schema freeze of the bundle
  format, and forward-compat across versions are still **v0.4**
  scope.
- **Docs site, blog post, MCP server directory submission, npm
  publish, GitHub publish** — these are **v0.5** open-source
  launch tasks. They require user action (account ownership,
  registration, narrative writing) and are not in-session
  deliverables.
- **Adoption metrics** (1k weekly downloads, 3+ external
  contributors, third-party integration documented) — **v1.0**
  exit criteria. Time and market dependent; cannot be produced
  inside an implementation session.

## [0.2.0] — 2026-05-24

Web surface complete. Mobile still deferred to v0.3.

### Added

- **Atomic tools (5 new, 10 total):** `rolepod_browser_key`,
  `rolepod_browser_scroll`, `rolepod_browser_wait_for`,
  `rolepod_browser_screenshot`, `rolepod_browser_navigate`.
- **Composite tools (4 new, 5 total):** `rolepod_audit_a11y` (via
  `@axe-core/playwright`), `rolepod_visual_diff` (via `pixelmatch` +
  `pngjs`), `rolepod_scaffold_e2e` (playwright-test / vitest+playwright
  / pytest+selenium codegen), `rolepod_extract_ui_state` (internal
  helper — no LLM).
- **`verify_ui_flow` mode='reproduce'** with linear-pass step
  minimization (D-025).
- **3 new shipped skills:** `/audit-a11y`, `/visual-diff`,
  `/scaffold-e2e`. All single-backend with no fallback (D-024).
- **Schema export:** `npm run build:schemas` emits
  `dist/schemas/tools.json` (JSON-Schema 2019-09) for every
  `rolepod_*` tool.
- **Skill lint:** `tests/lint/skills.test.ts` enforces frontmatter,
  required body sections, single-backend tool reference, and absence of
  fallback markers.

### Changed

- `ArtifactStore` now also writes report files (`.json`/`.md`) and raw
  bytes, and exposes `baselineDir` for `visual_diff`.
- `PlaywrightEngine` exposes `getPageForSession()` as an escape hatch
  for web-only composites that need raw Page APIs.
- `SessionRegistry.open` throws `unsupported_platform` (was
  `unknown_session`) when no engine is registered for the requested
  platform.

### Notes

- `mode='reproduce'` evaluates `expect` exactly the same way as
  `mode='assert'` — the user phrases assertions in terms of the bug
  surfacing. Minimization is a naive linear pass; ddmin is deferred to
  v0.3.
- `audit_a11y` currently supports `scope: 'page'` only;
  `scope: { ref }` is scheduled for v0.3 (returns
  `not_implemented_in_v02`).
- `extract_ui_state` returns the AT subtree and matched refs; the Lead
  interprets the answer. No LLM is invoked inside the MCP server
  (D-004).
- The `alumnium` driver fork (D-005) is still **not** in this release.
  Web continues to rely on Playwright's built-in `ariaSnapshot({mode:
  'ai'})` + `aria-ref` locator. The fork lands with mobile in v0.3.

## [0.1.0] — 2026-05-24

Proof of concept. Single composite, single engine, single platform.

### Added

- Plugin manifest for Claude Code (`.claude-plugin/plugin.json`) with
  `mcpServers` declaration (verified against
  [docs](https://code.claude.com/docs/en/plugins-reference)).
- MCP server skeleton via `@modelcontextprotocol/sdk@1.29.0` with
  stdio transport.
- `Engine` interface (`src/engine/Engine.ts`) and `PlaywrightEngine`
  implementation (web only).
- A11y normalization via Playwright 1.60's
  `page.ariaSnapshot({mode:'ai'})` + `aria-ref=eN` locator. (Note:
  Playwright 1.60 removed `page.accessibility`, hence the migration.)
- 5 atomic MCP tools: `rolepod_browser_open` / `_close` / `_snapshot`
  / `_click` / `_type`.
- 1 composite tool: `rolepod_verify_ui_flow` (mode='assert' only;
  mode='reproduce' deferred to v0.2 per D-025).
- 1 shipped skill: `/verify-ui` (single-backend, no fallback per
  D-024).
- `ArtifactStore` writing under `./.rolepod-mcp/artifacts/{run_id}/`
  per D-026 (renamed from `./.rolepod/`).
- `SessionRegistry` with per-platform engine routing and idle-timeout
  cleanup.
- `bin/rolepod-mcp` stdio entry; `npx rolepod-mcp` launches the
  server.
- Vitest smoke suite (`tests/smoke/example_com.test.ts`) — 6 tests
  against `https://example.com`.
- Manual MCP handshake smoke (`tests/smoke/mcp_handshake.mjs`).
- MIT license; `THIRD_PARTY.md` notes the future alumnium fork plan
  and runtime dependency licenses.

### Known limitations

- Web only. Mobile (iOS / Android via Appium) lands in v0.3.
- `mode='reproduce'` not implemented (handler returns
  `not_implemented_in_v01`).
- No alumnium driver fork yet — see v0.2 notes above.
