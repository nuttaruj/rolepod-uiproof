# Plan — Edge-case hardening & standalone fixes (rolepod-uiproof)

**Date:** 2026-07-07 · **Baseline:** 0.10.0 (npm) / 0.12.0 (plugin manifests) · **Target release:** 0.13.0 (reconciled)
**Source:** 72 verified findings from the edge-case audit (artifact `af18c633`). Every task below cites the confirming file:line.

## Goal

Close all 72 confirmed findings + 2 standalone caveats. Priority = the **false-PASS class** (a verification tool must never return PASS when it should FAIL) and the **security** items, then leaks, boot/standalone, mobile, audits, distribution, tests.

## Non-goals

- No new tools or features. No rewrite of the engine architecture.
- No change to the passing 131 tests except where a test asserts buggy behaviour (none found).
- Mobile (Appium) fixes land but are not gated on a live device — unit-test the pure logic (locator string, XML normalize) offline; device E2E deferred.

## Approach & sequencing decision

**Sequential, PR-per-concern** (finish-work P-gate = one concern per PR). 8 PRs, ordered by risk. Rationale: PRs 4/6 both edit `PlaywrightEngine.ts` heavily and PRs 4/5 both edit `schema/tools.ts` + composites — parallel agents would collide on shared files. Simplest viable = one owner, sequential.

**Parallelizable subset** (disjoint files, if the user later wants agents): PR1 (`scaffold_e2e.ts` + `ArtifactStore.writeReport`), PR3 (manifests/README/`.mcp.json`/`package.json`), PR7 (`AppiumEngine.ts` + a11y normalizers), PR8 (`tests/` only) touch no files that PRs 2/4/5/6 touch — those four could run concurrently once PR4's `schema/tools.ts` change lands. Default recommendation: sequential.

## File map (touched)

| File | PRs |
|---|---|
| `src/tools/composite/scaffold_e2e.ts` | 1 |
| `src/artifact/ArtifactStore.ts` | 1, 2 |
| `src/util/rolepodProtocol.ts` | 2 |
| `src/server.ts` · `src/bin`/entry | 2 |
| `src/cli/doctor.ts` | 2 |
| `README.md` · `.mcp.json` · `.claude-plugin/` · `.codex-plugin/` · `.cursor-plugin/` · `.agents/` · `gemini-extension.json` · `plugins/rolepod-uiproof/**` · `package.json` · `CHANGELOG.md` | 3 |
| `src/schema/tools.ts` | 4, 5 |
| `src/engine/cwv.ts` | 4 |
| `src/engine/PlaywrightEngine.ts` | 4, 6 |
| `src/tools/composite/visual_diff.ts` · `verify_ui_flow.ts` | 4, 6 |
| `src/tools/composite/audit_seo.ts` · `audit_page_budget.ts` · `src/engine/harClassifier.ts` | 5 |
| `src/engine/AppiumEngine.ts` · `a11y/xcuitest.ts` · `a11y/uiautomator2.ts` · `a11y/normalize.ts` | 7 |
| `tests/**` | every PR (co-located) + 8 |

Test infra already exists (vitest, 131 passing). No bootstrap needed. Offline-deterministic logic → `tests/unit/`; browser-needing → `tests/smoke/`.

---

## PR1 — Security (path traversal + codegen injection)

### Task 1.1 — Block path traversal in `writeReport`/`writeBytes`
- [x] `src/artifact/ArtifactStore.ts:174-184` — `writeReport`/`writeBytes` do `resolve(runDir, name)`; an absolute or `../` `name` escapes `runDir`. Add a guard: reject when `name` is absolute (`isAbsolute(name)`) or when `resolve(runDir, name)` does not start with `resolve(runDir) + sep`. Throw `RolepodMcpError("invalid_input", ...)`.
- [x] Also sanitise at the callsite `src/tools/composite/scaffold_e2e.ts:50,58,66,78` — reject/normalise `args.filename` to a basename before passing down (defense in depth).
- **Test:** `tests/unit/artifact_path_safety.test.ts` — assert `writeReport(runDir, "../evil.txt", ...)` and `writeReport(runDir, "/tmp/evil.txt", ...)` both reject; a plain `"a.spec.ts"` still writes inside runDir.
- **Command:** `npx vitest run tests/unit/artifact_path_safety.test.ts`

### Task 1.2 — Escape interpolated values in pytest+selenium codegen
- [x] `src/tools/composite/scaffold_e2e.ts:~322` — generated Python interpolates selectors/text/URLs into f-strings and XPath without escaping → quotes/braces produce `SyntaxError` or an XPath that never matches (audit obs 16801). Route every interpolated literal through a Python-string escaper (escape `\`, `'`, `"`, `{`→`{{`, `}`→`}}` for f-strings; use `repr()`-style quoting). Same audit pass for the other framework branches (playwright-ts / cypress) where user strings are embedded.
- **Test:** `tests/unit/v05_scaffold_codegen.test.ts` (extend) — scaffold a scenario whose selector/text contains `' " { } \` and assert the emitted body contains the escaped forms and no raw unescaped brace; for python, assert it parses (spawn `python3 -c "import ast; ast.parse(open(f).read())"` if `python3` present, else regex-assert balanced quotes).
- **Command:** `npx vitest run tests/unit/v05_scaffold_codegen.test.ts`

### Task 1.3 — PR1 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR2 — Boot & standalone hardening

### Task 2.1 — Guard `readFileSync` of the parent marker
- [x] `src/util/rolepodProtocol.ts:52-57` — `existsSync` guards existence only; `readFileSync` at :56 throws `EISDIR` (marker is a directory — the documented override at :65 invites the `mkdir -p .rolepod/parent-active` typo) or `EACCES` (unreadable) → propagates through `checkProtocolCompat`→`buildServer`→entry `main().catch`→`exit(1)`, killing all 30 tools with a raw fs stack (audit obs 16691, reproduced live). Wrap :56 in try/catch: on error, log a clear warning (`.rolepod/parent-active is present but unreadable (<code>); treating as standalone`) and return `{ active: false, protocol: null, gitRoot }`.
- **Test:** `tests/unit/parent_marker.test.ts` — point `detectRolepodParent` at a tmp gitRoot where `.rolepod/parent-active` is a **directory**; assert it returns `active:false` and does not throw. Second case: a normal `v1` file returns `active:true, protocol:"v1"`.
- **Command:** `npx vitest run tests/unit/parent_marker.test.ts`

### Task 2.2 — Add uuid suffix to with-parent run dirs
- [x] `src/artifact/ArtifactStore.ts:112-118` — with-parent `runId = ${ts}-rolepod-uiproof-${skill}` has no uniqueness suffix; same-second same-skill runs clobber each other's evidence (the code comment promises a uuid "when two runs could collide" but never appends one). Append `-${randomUUID().slice(0,6)}` to the with-parent branch too (keep it sortable: `${ts}-rolepod-uiproof-${skill}-${short}`). Confirm the parent's evidence-aggregation (check-work) globs by prefix, not exact name — grep `plugins/rolepod/skills/*/` if reachable; otherwise the sortable prefix keeps ordering intact.
- **Test:** `tests/unit/artifact_gitignore.test.ts` (extend) or new `tests/unit/artifact_runid.test.ts` — force `mode:"with-parent"`, call `startRun` twice with the same skill + a stubbed identical timestamp, assert the two `runDir`s differ.
- **Command:** `npx vitest run tests/unit/artifact_runid.test.ts`

### Task 2.3 — Re-detect mode per run instead of freezing at boot
- [x] `src/artifact/ArtifactStore.ts:77` (+ construction path) — `mode` is captured once at server spawn, racing the parent's SessionStart hook that writes the marker (audit obs 16768). Re-evaluate `detectRolepodParent()` at `startRun` time (cheap: one `existsSync`), so a marker written after boot is honoured. Keep the boot value as a default; recompute per run.
- **Test:** `tests/unit/artifact_mode_race.test.ts` — construct store with no marker (standalone), then create the marker file, then `startRun`, assert the run resolves to `with-parent` root.
- **Command:** `npx vitest run tests/unit/artifact_mode_race.test.ts`

### Task 2.4 — Default to headless off-CI; make headed opt-in
- [x] `src/engine/PlaywrightEngine.ts:~205` — headed launch is the default when not on CI → fails on display-less hosts (headless servers, containers). Flip default to `headless:true`; honour an explicit `ROLEPOD_HEADED=1` / capture opt for headed. Verify the launch-options construction site and any test that asserts headed.
- **Test:** `tests/smoke/example_com.test.ts` already exercises a real launch; add an assertion path or a unit on the launch-options builder (extract if needed) asserting `headless===true` absent the env flag.
- **Command:** `npx vitest run tests/smoke/example_com.test.ts`

### Task 2.5 — Doctor: verify Playwright browsers are actually runnable
- [x] `src/cli/doctor.ts:~65` — checks only that a Chromium cache dir exists → false OK after a partial/other-browser install, false FAIL on Windows and under `PLAYWRIGHT_BROWSERS_PATH=0`. Replace the dir-exists heuristic with `chromium.executablePath()` existence (Playwright API) or a guarded `launch()+close()` probe; downgrade to warn on `PLAYWRIGHT_BROWSERS_PATH=0` (bundled-browser mode).
- **Test:** `tests/unit/cli.test.ts` (extend) — invoke doctor's Playwright check with a stubbed `executablePath`; assert OK when it resolves, warn/FAIL with actionable text when it doesn't.
- **Command:** `npx vitest run tests/unit/cli.test.ts`

### Task 2.6 — PR2 gate
- **Command:** `npm run typecheck && npm run build && npm test && npm run smoke:mcp`

---

## PR3 — Distribution, naming, version reconcile

### Task 3.1 — Fix unscoped `npx rolepod-uiproof` → `@rolepod/uiproof`
- [x] `README.md:205,217` (and any runtime error string) instruct `npx rolepod-uiproof …` — an **unscoped** name that 404s on npm and is squattable. Replace all user-facing invocations with `npx @rolepod/uiproof@<version> …`. Grep the whole tree for the bare form and fix each: `grep -rn "npx rolepod-uiproof" . -g '!node_modules'`. Also fix any thrown message that suggests it (e.g. the mobile-install hint).
- **Test:** `tests/lint/skills.test.ts` (extend) or new `tests/lint/npx_name.test.ts` — assert no tracked file (excluding node_modules/lock) contains `npx rolepod-uiproof` without the `@rolepod/` scope.
- **Command:** `npx vitest run tests/lint/npx_name.test.ts`

### Task 3.2 — Pin the README manual-config snippets
- [x] `README.md:160,182` ship `["-y","@rolepod/uiproof"]` unpinned — the repo's own `tests/unit/spawn_version_pin.test.ts` bans unpinned specs in configs. Pin to `@rolepod/uiproof@0.13.0` to match the release.
- **Test:** extend `tests/unit/spawn_version_pin.test.ts` to also scan README fenced json blocks (or add README to its file list).
- **Command:** `npx vitest run tests/unit/spawn_version_pin.test.ts`

### Task 3.3 — Reconcile version to 0.13.0 across every manifest + spawn pin
- [x] Split confirmed: `package.json:3` = 0.10.0; all 5 plugin manifests = 0.12.0; spawn pins = `@rolepod/uiproof@0.10.0`; git tags stop at v0.7.1 (0.10–0.12 never tagged/published past 0.10.0). Set **one** version 0.13.0 in: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.agents/*`, `gemini-extension.json`, `plugins/rolepod-uiproof/.claude-plugin/plugin.json`; update every `@rolepod/uiproof@…` spawn pin to `@0.13.0` (`.mcp.json` + all manifests); add `dist/schemas` version if emitted. Add CHANGELOG `[0.13.0]` entry summarising this hardening release.
- **Test:** new `tests/unit/version_lockstep.test.ts` — read every manifest + package.json, assert all equal `0.13.0`; assert every spawn pin equals `@rolepod/uiproof@0.13.0`.
- **Command:** `npx vitest run tests/unit/version_lockstep.test.ts`

### Task 3.4 — Offline fallback note for npx-only spawn
- [x] `.mcp.json:4` (+ README) — every spawn requires an npx registry fetch; offline/registry-blocked machines get no server. Simplest viable = document a local-install fallback (`npm i -g @rolepod/uiproof@0.13.0` then spawn `rolepod-uiproof`) in README's standalone section; no code change. (Deeper: a `prefer-offline` note.)
- **Test:** `tests/lint/skills.test.ts` (extend) — assert README standalone section contains an offline-fallback anchor string.
- **Command:** `npx vitest run tests/lint/skills.test.ts`

### Task 3.5 — PR3 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR4 — False-PASS: core web verdict correctness (highest priority)

### Task 4.1 — Reject unknown top-level params (strict schemas) so typos can't strip to a free PASS
- [~] SUPERSEDED by 4.2: MCP SDK consumes a raw ZodRawShape and builds a non-strict object itself (schema/tools.ts:61-64 comment), so `.strict()` is not cleanly reachable. 4.2 (empty-expect in assert mode -> fail) removes the actual false-PASS danger the typo caused. Original note:
- [ ] `src/schema/tools.ts` — tool-input objects use zod default strip mode; a misspelled key is dropped silently and, combined with `expect: z.array(...).default([])` (:486), yields an unconditional `passed=true` (audit infra finding). Make the **top-level** tool-input objects `.strict()` (reject unknown keys) OR pass through a pre-validation that errors on unknown top-level keys with a helpful message. Keep nested `.default()`s. Verify no legitimate caller passes extra keys (grep tool handlers).
- **Test:** `tests/unit/schema_strict.test.ts` — parse a `verify_ui_flow` input with `expct:[…]` (typo) and assert it **throws/rejects** rather than defaulting to `passed=true`.
- **Command:** `npx vitest run tests/unit/schema_strict.test.ts`

### Task 4.2 — `verify_ui_flow` must FAIL (not silently pass) on an empty `expect`
- [x] `src/tools/composite/verify_ui_flow.ts` + `src/schema/tools.ts:486` — an empty expectation list must not report `passed=true` as if verified. Simplest viable: when `expect` is empty **and** `mode==="assert"`, return a `passed=false` / `status:"inconclusive"` with message "no expectations declared — nothing was verified". (Keep `reproduce` mode allowed to have no expectations.)
- **Test:** `tests/smoke/v02_surface.test.ts` (extend) or unit on the verdict reducer — assert empty-expect assert-mode → not `passed:true`.
- **Command:** `npx vitest run tests/smoke/v02_surface.test.ts`

### Task 4.3 — CWV: return `unmeasured` (not `good`) when a metric never fired
- [x] `src/engine/cwv.ts:89-101` — `classifyMetric` returns `good` for `value<=t`, so an unmeasured LCP (`value===0`/undefined) classifies as `good`→pass (audit obs 16754). Thread a `measured` flag (like the existing `hadInteraction` for INP at :95) for LCP/CLS; return `"unmeasured"` when the metric never produced a value; ensure `computeOverallVerdict` treats all-unmeasured as `warn`/`fail`, never `pass`. Fix the collection site in `measure_cwv` to distinguish "0" from "never observed".
- **Test:** `tests/unit/v07_measurement.test.ts` (extend) — `classifyMetric("lcp", 0, thresholds, /*measured*/ false)` → `"unmeasured"`; overall verdict with unmeasured LCP is not `"pass"`.
- **Command:** `npx vitest run tests/unit/v07_measurement.test.ts`

### Task 4.4 — `wait_for ref_exists` must match the actual element, not hardcoded `role="button"`
- [x] `src/engine/PlaywrightEngine.ts:408-412` — `ref_exists` does `getByRole("button",{name:query})`, so waiting on any non-button (link/input/heading/text) falsely times out (3 dims). Replace with a role-agnostic locator: resolve `query` the same way the click/act path resolves refs (by ref id if it looks like a ref, else `getByText`/`getByRole` union or `page.locator` on the snapshot), matching how `verify_ui_flow` resolves queries. Rename the condition's intent in code comments to match.
- **Test:** `tests/smoke/verify_scroll_settle.test.ts` or `example_com.test.ts` — `wait_for ref_exists` on a **link** (`example.com` "More information" anchor) resolves without timeout.
- **Command:** `npx vitest run tests/smoke/example_com.test.ts`

### Task 4.5 — `verify_ui_flow` query ambiguity must be reported, not silently first-match
- [x] `src/tools/composite/verify_ui_flow.ts:~637` — an ambiguous substring query silently resolves to the first depth-first match with no role filter → acts on the wrong element and returns a wrong verdict. When >1 element matches, return an `ambiguous_query` failure listing the top candidates (text + role) instead of guessing.
- **Test:** `tests/smoke/scope_ref.test.ts` (extend) — a page with two "Submit" targets → assert the tool returns an ambiguity error, not a silent success.
- **Command:** `npx vitest run tests/smoke/scope_ref.test.ts`

### Task 4.6 — `visual_diff`: fail on missing/broken baseline seed; tighten default threshold
- [x] `src/tools/composite/visual_diff.ts:~70` — first-run seeds a baseline from whatever rendered, including a 404/blank page, then reports `passed=true` and poisons all future diffs. On seed, require the page load succeeded (HTTP < 400 — see Task 5.1's status helper) and the screenshot is non-blank (dimensions > 0, not all-one-color); on seed, return `status:"baseline_created"` (not `passed:true`).
- [ ] `src/schema/tools.ts:533` — `threshold_pct` default `0.1` = 10% of pixels may change and still PASS. Lower default to a defensible value (`0.01` = 1%, or express as ratio consistent with pixelmatch output) and document the unit clearly in the schema description.
- **Test:** `tests/smoke/visual_diff_settle.test.ts` (extend) — (a) seeding returns `baseline_created` not `passed:true`; (b) a diff exceeding 1% fails at the new default.
- **Command:** `npx vitest run tests/smoke/visual_diff_settle.test.ts`

### Task 4.7 — `no_console_errors`/`no_failed_requests` must not silently PASS on mobile sessions
- [x] `src/tools/composite/verify_ui_flow.ts:~551` — these expectations are web-only; on an Appium session they can't be evaluated but currently pass. Return `status:"unsupported"`/`passed:false` with "console/network assertions require a web session" when the active engine is Appium.
- **Test:** `tests/unit` with a stubbed mobile engine, or assert the branch via the verdict reducer — mobile + `no_console_errors` → not `passed:true`.
- **Command:** `npx vitest run tests/unit/v06_protocol_detection.test.ts`

### Task 4.8 — PR4 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR5 — Audit correctness (SEO + page budget)

### Task 5.1 — Add an HTTP-status/redirect helper; SEO audit must not audit error pages as success
- [x] `src/tools/composite/audit_seo.ts:88` — status/redirects never checked; a 404/500 body or a canonical redirect is audited as if it were the requested page. Capture the main navigation `Response` (status, `url()` after redirects) in `open`/audit; when status >= 400, return a top-level FAIL ("requested URL returned <status>") instead of scanning the error page. Surface the final (redirected) URL in the report + manifest.
- [ ] Reuse this status helper in `navigate`/`open` (audit `atomic-observe` finding: navigate/open swallow 4xx/5xx) and in `visual_diff` seed guard (Task 4.6).
- **Test:** `tests/smoke/` new `audit_seo_status.test.ts` — point at `https://example.com/nonexistent-<rand>` (or a local 404) → assert audit reports the status FAIL, not "missing title".
- **Command:** `npx vitest run tests/smoke/audit_seo_status.test.ts`

### Task 5.2 — SEO audit must read DOM after client render, not at `domcontentloaded`
- [x] `src/tools/composite/audit_seo.ts:90` — reads title/meta at `domcontentloaded`, so CSR/SPA (React/Vue/Next) report false-critical missing title/meta. Wait for `load` + a short settle (reuse the `settle` step's networkidle-or-timeout), or wait for `<title>` non-empty with a bounded timeout, before snapshotting head/meta. Document that fully client-blank pages still legitimately fail.
- **Test:** `tests/smoke/audit_seo_status.test.ts` (extend) with a data: URL or local page that sets `document.title` via script → assert the title is detected.
- **Command:** `npx vitest run tests/smoke/audit_seo_status.test.ts`

### Task 5.3 — SEO: detect robots `none`; accept JSON-LD `@graph` and array forms
- [x] `src/tools/composite/audit_seo.ts:346-349` — robots check misses `none` (= `noindex,nofollow`); treat `none` as noindex+nofollow. `:385-391` — JSON-LD validity flags valid `@graph` and top-level-array documents as "missing @type" (common Yoast/Schema.org output). Walk `@graph[]` and top-level arrays, validating `@type` per node, not on the root object.
- **Test:** `tests/unit/audit_seo_parse.test.ts` — feed (a) `<meta name=robots content=none>` → flagged noindex; (b) a `@graph` JSON-LD with valid per-node `@type` → **no** "missing @type"; (c) a top-level array → same.
- **Command:** `npx vitest run tests/unit/audit_seo_parse.test.ts`

### Task 5.4 — Page budget: compare transfer size, not decoded size; fix third-party host match; don't swallow the idle timeout
- [x] `src/engine/harClassifier.ts:~179` — budget compares `content.size` (uncompressed) → wrong FAIL on any gzip/brotli site (audit obs 16800). Use HAR `response._transferSize` (or `response.bodySize` + headers) for the transfer total; keep decoded size only where explicitly labelled.
- [ ] `src/engine/harClassifier.ts:~122` — third-party heuristic misclassifies sibling subdomains (`www.` page + `cdn.`/`static.` assets flagged third_party). Compare **registrable domain** (eTLD+1) not full hostname; treat same-eTLD+1 as first-party.
- [ ] `src/tools/composite/audit_page_budget.ts:~63` — `networkidle` timeout is swallowed → a still-loading page gets a silent "pass" on a partial measurement. On idle-timeout, mark the measurement `partial:true` and either FAIL or clearly flag it (never silent pass).
- **Test:** `tests/unit/harClassifier.test.ts` (new) — (a) an entry with decoded 100KB / transfer 20KB → budget uses 20KB; (b) `www.site.com` page + `cdn.site.com` asset → first-party; (c) partial flag set when idle not reached (stub).
- **Command:** `npx vitest run tests/unit/harClassifier.test.ts`

### Task 5.5 — PR5 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR6 — Resource leaks, zombie sessions, dialog ordering

### Task 6.1 — Close the browser when `open()`'s initial `goto` throws
- [ ] `src/engine/PlaywrightEngine.ts:273-277` — `goto` at :274 runs before `sessions.set` at :277; if it throws (dead URL, down localhost, redirect loop) the launched browser/context is never stored and never closed → leak (2 dims). Wrap the goto (and the setup between launch and `sessions.set`) in try/catch that closes context/browser before rethrowing as a structured error. Prefer: register the session first, then goto, so `close()` can reclaim it; or a local `try { … } catch { await context.close(); await browser.close(); throw }`.
- **Test:** `tests/smoke/example_com.test.ts` (extend) — `open({url:"http://127.0.0.1:1/"})` (closed port) rejects with a structured error AND leaves no live browser (assert via a follow-up that process count / a tracked handle is released; or assert the catch path calls close via a spy in a unit around the setup helper).
- **Command:** `npx vitest run tests/smoke/example_com.test.ts`

### Task 6.2 — Prune closed pages; recover `activePageIndex`
- [ ] `src/engine/PlaywrightEngine.ts:256-271,911-945` — pages pushed on `context.on("page")` are never removed on `page.on("close")`; `listPages` reports dead pages, `switchPage` can select a closed one, and `activePageIndex` can dangle. Attach a `page.on("close")` in `attachPageListeners` that removes the page from `s.pages` and, if it was active, resets `activePageIndex` to a live page (0 or mainPage). `activePage()` already falls back to `mainPage` — keep that as the floor.
- **Test:** `tests/smoke/` new `page_lifecycle.test.ts` — open, trigger a popup, close it, assert `listPages` no longer lists it and `activePage` is valid; `switchPage` to a stale index errors cleanly.
- **Command:** `npx vitest run tests/smoke/page_lifecycle.test.ts`

### Task 6.3 — `verify_ui_flow` minimize must not leak a browser per ddmin attempt
- [ ] `src/tools/composite/verify_ui_flow.ts:~343` — with `close_on_finish:false`, each ddmin attempt opens a session that is never closed (2 dims). Ensure the minimize loop always closes the per-attempt session (try/finally), independent of the top-level `close_on_finish` (that flag governs the final reproduction session, not the throwaway minimization runs).
- **Test:** `tests/smoke/` extend `replay_cli.test.ts` or a minimize test — run minimize with `close_on_finish:false` over a 2-step flow and assert the session registry count returns to baseline after.
- **Command:** `npx vitest run tests/smoke/replay_cli.test.ts`

### Task 6.4 — Make `handle_dialog` arm-and-return so sequential MCP clients can trigger the dialog
- [ ] `src/engine/PlaywrightEngine.ts:700-733` + `src/tools/atomic/browser_handle_dialog.ts` — the call blocks until a dialog fires, but a sequential MCP client can only issue the triggering action *after* this call returns → an armed `accept` never gets to run and the safety net dismisses it. Add a `wait` param (default `false`): when `false`, store the arming and return `{armed:true}` immediately; the existing `page.on("dialog")` consumer handles the next dialog and the outcome is surfaced on the subsequent action/snapshot result (add `last_dialog` to session state + result metadata). Keep `wait:true` for the current blocking behaviour. Document the ordering in the tool description.
- **Test:** `tests/smoke/` new `dialog_arming.test.ts` — arm accept (non-wait) → returns immediately with `armed:true`; then a click that triggers a `confirm()` → assert it was accepted (page reflects the accepted branch) and `last_dialog` records it.
- **Command:** `npx vitest run tests/smoke/dialog_arming.test.ts`

### Task 6.5 — (minor) network/cpu throttle persistence + inflight map
- [ ] `src/engine/PlaywrightEngine.ts:870-886` — CDP session is `detach()`ed in `finally` right after applying emulation; verify emulation survives detach (Playwright keeps CDP emulation session-scoped — if it reverts, keep the CDP session on the SessionInternals and detach only on `close`). `:962-968` — `networkInflight` grows and is never pruned/read; prune entries on `requestfinished`/`requestfailed` (the response listener) or drop the map if genuinely unused.
- **Test:** `tests/smoke/` assert `set_env({networkThrottle:"Slow 3G"})` then a navigation shows throttled timing (bounded, flaky-tolerant), or unit that the inflight map shrinks after a completed request.
- **Command:** `npx vitest run tests/smoke/v02_surface.test.ts`

### Task 6.6 — PR6 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR7 — Mobile engine (Appium) correctness

### Task 7.1 — Fix wrong-element locator fallbacks (sibling index used as global index)
- [ ] `src/engine/AppiumEngine.ts:366-380` (`toSelector`) — iOS class-chain fallback `**/${type}[${classChainIndex}]` and Android `UiSelector().className(cls).instance(${classIndex})` pass a **sibling-scoped** index into a **global** search → resolve the wrong element (2 dims). Also `:362-368` collapses duplicate accessibility-ids/text onto the first match. Fix the index derivation: compute a document-global index when building `MobileRefMeta` (or switch the fallback to a stable predicate — accessibility-id + type + text — rather than positional index), and when a ref is genuinely ambiguous, throw `ambiguous_ref` rather than silently taking `[0]`.
- **Test:** `tests/unit/` new `appium_selector.test.ts` — build `MobileRefMeta` for the 2nd of two same-class siblings and assert `toSelector` yields a selector that targets the global 2nd (not sibling index applied globally); duplicate a11y-id → `ambiguous_ref`.
- **Command:** `npx vitest run tests/unit/appium_selector.test.ts`

### Task 7.2 — `wait_for` on mobile must not re-snapshot pre-wait refs; `ref_exists` must not be a substring text search
- [ ] `src/engine/AppiumEngine.ts:220-237` — `wait_for` invalidates/re-snapshots internally so a pre-wait ref resolves against a new tree; and `ref_exists` (:227) is implemented as a substring text search → false positives + guaranteed false timeouts. Implement `ref_exists` as a real presence check for the resolved element/predicate; don't invalidate refs the caller is waiting on until the wait resolves.
- **Test:** `tests/unit/appium_selector.test.ts` (extend) or a normalizer-level test — `ref_exists` for a present ref returns true without a text match; absent ref → false, not a substring coincidence.
- **Command:** `npx vitest run tests/unit/appium_selector.test.ts`

### Task 7.3 — `fillForm` (2+ fields) must survive per-field ref invalidation
- [ ] `src/engine/AppiumEngine.ts:270-289` — `type()` invalidates refs after each field (:165 etc.), so field 2 throws `stale_ref` and multi-field fills always fail. Re-resolve each field by its predicate/selector at fill time (not by a pre-captured ref), or suppress invalidation within the fillForm batch and invalidate once at the end.
- **Test:** `tests/unit/` — stub the driver, call `fillForm` with two fields, assert both are typed and no `stale_ref` is thrown.
- **Command:** `npx vitest run tests/unit/appium_selector.test.ts`

### Task 7.4 — `scroll` must report real failure, not swallow it as success
- [ ] `src/engine/AppiumEngine.ts:185-220` — scroll failures are swallowed and reported success; Android gesture rect is hardcoded and iOS "scroll" is actually a swipe. Propagate driver gesture errors as `engine_error`; compute the gesture rect from the element/viewport bounds; document the iOS swipe semantics or implement a real scroll-to-element (`mobile: scroll` with predicate) where available.
- **Test:** `tests/unit/` — stubbed driver whose gesture rejects → `scroll` throws `engine_error` (not `{scrolled:true}`).
- **Command:** `npx vitest run tests/unit/appium_selector.test.ts`

### Task 7.5 — a11y snapshots: parse failure must FAIL, not return an empty success; keep `checked`/`visible`
- [ ] `src/engine/a11y/normalize.ts:133` (web YAML), `xcuitest.ts:47` + `uiautomator2.ts:47` (mobile XML) — a parse failure falls back to `[]` and reports a successful-but-empty tree, so tree-scanning assertions false-pass. On parse error, throw a structured `snapshot_parse_error` (or mark the snapshot `degraded:true`) instead of silently returning `[]`.
- [ ] `src/engine/a11y/uiautomator2.ts:~79` — Android normalizer drops `checked`; carry it through so checkbox/switch/toggle state is verifiable. `src/engine/a11y/xcuitest.ts:~81` — iOS normalizer ignores `visible="false"`; carry visibility so `text_visible`/snapshots don't treat off-screen elements as visible.
- **Test:** `tests/unit/a11y_uiautomator2.test.ts` + `a11y_xcuitest.test.ts` (extend) — (a) malformed XML → throws/degraded, not empty-success; (b) a `checked="true"` node surfaces `checked`; (c) a `visible="false"` node is marked not-visible.
- **Command:** `npx vitest run tests/unit/a11y_uiautomator2.test.ts tests/unit/a11y_xcuitest.test.ts`

### Task 7.6 — (minor) actionable error when Appium/device is unavailable
- [ ] `src/engine/AppiumEngine.ts:~92` — Appium-down/device-not-found surfaces a raw webdriverio error; wrap `remote()` rejection with `engine_error` + guidance ("Appium server unreachable at <url>; start it with `appium` / check device").
- **Test:** `tests/unit/` — stub `remote` to reject `ECONNREFUSED` → `open` throws `engine_error` with guidance text.
- **Command:** `npx vitest run tests/unit/appium_selector.test.ts`

### Task 7.7 — PR7 gate
- **Command:** `npm run typecheck && npm run build && npm test`

---

## PR8 — Test coverage backfill (regression floor)

### Task 8.1 — Fix the handshake expected-tool list (29 → 30)
- [ ] `tests/smoke/mcp_handshake.mjs:~54` — expected-tool list omits `extract_computed_style` (29 vs 30 registered). Add it so the smoke asserts the full surface.
- **Command:** `npm run smoke:mcp`

### Task 8.2 — Offline-skip for network-dependent smoke suites
- [ ] `tests/smoke/example_com.test.ts:11` (+ 3 other suites hard-depending on `https://example.com`) — add a reachability pre-check that `skip`s (not fails) when offline/example.com unreachable, so CI/offline runs don't false-red. Keep them running when online.
- **Command:** `npx vitest run tests/smoke`

### Task 8.3 — Direct unit for the MCP error contract
- [ ] `src/tools/result.ts:20` + `src/util/errors.ts` — no direct test for `failure()`/`safeHandler` mapping. Add `tests/unit/error_contract.test.ts` asserting: a thrown `RolepodMcpError` keeps its code; a plain `Error` degrades to `engine_error`; the result shape is `{isError:true, code, message}`.
- **Command:** `npx vitest run tests/unit/error_contract.test.ts`

### Task 8.4 — Handler-level smoke for the untested composites + SessionRegistry lifecycle
- [ ] Add handler-execution coverage (not just helpers) for `measure_cwv`, `audit_page_budget`, `audit_seo` (0 runtime coverage today), and a `SessionRegistry` lifecycle test (idle sweep, close-then-reuse, concurrent sessions) — `src/session/SessionRegistry.ts:93`. Many of these are satisfied by tests written in PRs 4/5/7; this task closes whatever remains.
- **Command:** `npx vitest run tests/unit tests/smoke`

### Task 8.5 — Extension-Protocol manifest emission test
- [ ] `src/util/manifest.ts:54` — parent `check-work` parses this shape; add `tests/unit/manifest_shape.test.ts` asserting a composite run emits a manifest with the v1 fields (`skill, phase, status, artifacts[]`).
- **Command:** `npx vitest run tests/unit/manifest_shape.test.ts`

### Task 8.6 — PR8 gate + full suite
- **Command:** `npm run typecheck && npm run build && npm test && npm run smoke:mcp`

---

## Failure policy

- Any task's **Command** fails → fix within that task before advancing; do not proceed to the PR gate with a red command.
- A fix reveals the audit finding was mis-scoped (like the 4 refuted) → stop, note it in the PR description, skip the task, do not force a change.
- A browser/network smoke flakes (offline) → after Task 8.2, it should `skip`; before that, re-run once, then treat persistent failure as environmental and note it — do not mark the task done on a skipped assertion.
- Third consecutive failed attempt on the same task → stop and escalate to the user (rolepod hard-stop).
- Each PR ends at its gate (`typecheck && build && test`), then `review-code` (self + adversarial for PR1 security, PR4 verdict logic), then `finish-work` presents the 4-option menu. Lead commits; no sub-agent commits.

## Risks & watch-items

- **PR4.1 strict schemas** could break a legitimate caller that passes extra keys — grep all tool handlers + skills for extra-key usage before flipping `.strict()`; if any exist, use a top-level unknown-key *warning+error* on tool inputs only, not nested.
- **PR4.4 ref_exists rewrite** shares the resolver with click/act — reuse the existing resolver, don't fork logic, or the two paths drift.
- **PR6.4 handle_dialog** is a behaviour change; default `wait:false` may surprise existing callers — keep `wait:true` available and document in CHANGELOG as a behaviour note.
- **PR7 mobile** fixes are unit-verified offline; a real iOS/Android E2E pass is deferred — flag in the release notes that mobile changes are logic-verified, not device-verified.
- **PR3 version bump to 0.13.0** must be the LAST thing before publish, and publish/tag is a Ship-phase action requiring user approval (finish-work) — do not `npm publish` or `git tag` autonomously.

## Spec-coverage trace (finding-class → PR)

| Finding class (count) | PR |
|---|---|
| Security: path traversal, codegen injection (2) | PR1 |
| Boot/standalone: readFileSync, runId, mode race, headless, doctor (5) | PR2 |
| Distribution: npx name, unpinned, version split, offline (4) | PR3 |
| False-PASS web: schema strip, empty-expect, cwv, ref_exists, ambiguity, visual_diff×2, mobile-assert (8) | PR4 |
| Audit correctness: seo status/render/robots/jsonld, budget size/thirdparty/idle (7) | PR5 |
| Leaks/zombie/dialog: open leak, page prune, minimize leak, dialog, throttle/inflight (6) | PR6 |
| Mobile: locator×3, wait_for, fillForm, scroll, a11y empty/checked/visible, appium-error (9) | PR7 |
| Test gaps: handshake, offline-skip, error-contract, composite handlers, registry, manifest (10 minor) | PR8 |

All 72 confirmed + 2 caveats mapped. Minor items folded into their nearest PR.
