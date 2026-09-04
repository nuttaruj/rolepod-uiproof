import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const platformSchema = z.enum(["web", "ios", "android"]);
export const browserSchema = z.enum(["chromium", "firefox", "webkit"]);

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const a11yStateSchema = z.object({
  focused: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** Checkbox/switch/toggle state (mobile). */
  checked: z.boolean().optional(),
  /** On-screen visibility (mobile XCUITest `visible`). */
  visible: z.boolean().optional(),
});

export type A11yNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  state?: z.infer<typeof a11yStateSchema>;
  bbox?: z.infer<typeof bboxSchema>;
  children?: A11yNode[];
};

export const a11yNodeSchema: z.ZodType<A11yNode> = z.lazy(() =>
  z.object({
    ref: z.string(),
    role: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    state: a11yStateSchema.optional(),
    bbox: bboxSchema.optional(),
    children: z.array(a11yNodeSchema).optional(),
  }),
);

export const waitConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_visible"), text: z.string() }),
  z.object({ kind: z.literal("ref_exists"), query: z.string() }),
  z.object({ kind: z.literal("url_matches"), pattern: z.string() }),
  z.object({ kind: z.literal("idle"), ms: z.number().int().positive() }),
]);

// ---------------------------------------------------------------------------
// Atomic tools — input shapes
//
// NOTE: MCP SDK's `registerTool({ inputSchema })` expects a Zod *raw shape*
// (a plain object whose values are Zod schemas), NOT a `z.object(...)`. We
// export both the raw shape (for the SDK) and a derived `z.object` (for
// internal parsing / type inference).
// ---------------------------------------------------------------------------

export const browserOpenShape = {
  platform: platformSchema.default("web"),
  url: z.string().url().optional(),
  browser: browserSchema.optional(),
  viewport: viewportSchema.optional(),
  // mobile fields kept for forward compat; v0.1 only handles platform='web'
  bundle_id: z.string().optional(),
  device: z.string().optional(),
  app_package: z.string().optional(),
  app_activity: z.string().optional(),
  emulator: z.string().optional(),
  headless: z.boolean().optional(),
  user_agent: z.string().optional(),
  locale: z.string().optional(),
  /**
   * Absolute path to a Playwright storageState JSON (cookies + localStorage,
   * as written by `context.storageState({ path })`). Injects an existing
   * authenticated session so the run does not have to navigate a login or
   * one-time-link URL — reusable across runs and restartable after a
   * `browser_close`. Web-only; ignored on mobile.
   */
  storage_state: z.string().min(1).optional(),
} as const;
export const browserOpenSchema = z.object(browserOpenShape);
export type BrowserOpenInput = z.infer<typeof browserOpenSchema>;

export const browserCloseShape = {
  session_id: z.string().min(1),
} as const;
export const browserCloseSchema = z.object(browserCloseShape);
export type BrowserCloseInput = z.infer<typeof browserCloseSchema>;

export const browserSnapshotShape = {
  session_id: z.string().min(1),
  mode: z.enum(["visible", "full"]).optional(),
} as const;
export const browserSnapshotSchema = z.object(browserSnapshotShape);
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotSchema>;

export const browserClickShape = {
  session_id: z.string().min(1),
  ref: z.string().min(1),
  button: z.enum(["left", "right", "middle"]).optional(),
} as const;
export const browserClickSchema = z.object(browserClickShape);
export type BrowserClickInput = z.infer<typeof browserClickSchema>;

export const browserTypeShape = {
  session_id: z.string().min(1),
  ref: z.string().min(1),
  text: z.string(),
  clear_first: z.boolean().optional(),
} as const;
export const browserTypeSchema = z.object(browserTypeShape);
export type BrowserTypeInput = z.infer<typeof browserTypeSchema>;

export const browserKeyShape = {
  session_id: z.string().min(1),
  key: z.string().min(1),
} as const;
export const browserKeySchema = z.object(browserKeyShape);
export type BrowserKeyInput = z.infer<typeof browserKeySchema>;

export const browserScrollShape = {
  session_id: z.string().min(1),
  direction: z.enum(["up", "down", "left", "right"]),
  amount: z.number().int().positive().optional(),
  ref: z.string().min(1).optional(),
} as const;
export const browserScrollSchema = z.object(browserScrollShape);
export type BrowserScrollInput = z.infer<typeof browserScrollSchema>;

export const browserWaitForShape = {
  session_id: z.string().min(1),
  condition: waitConditionSchema,
  timeout_ms: z.number().int().positive().optional(),
} as const;
export const browserWaitForSchema = z.object(browserWaitForShape);
export type BrowserWaitForInput = z.infer<typeof browserWaitForSchema>;

export const browserScreenshotShape = {
  session_id: z.string().min(1),
  full_page: z.boolean().optional(),
  /**
   * CSS selector to capture only that element's bounding box (web-only).
   * Overrides `full_page`.
   */
  selector: z.string().min(1).optional(),
  /**
   * Freeze CSS animations/transitions + hide the text caret for a
   * deterministic capture (Playwright `animations: "disabled"`). Default off.
   */
  freeze_motion: z.boolean().default(false),
} as const;
export const browserScreenshotSchema = z.object(browserScreenshotShape);
export type BrowserScreenshotInput = z.infer<typeof browserScreenshotSchema>;

export const browserNavigateShape = {
  session_id: z.string().min(1),
  url: z.string().url(),
} as const;
export const browserNavigateSchema = z.object(browserNavigateShape);
export type BrowserNavigateInput = z.infer<typeof browserNavigateSchema>;

// ---------------------------------------------------------------------------
// v0.5 atomic additions
// ---------------------------------------------------------------------------

export const browserHoverShape = {
  session_id: z.string().min(1),
  ref: z.string().min(1),
} as const;
export const browserHoverSchema = z.object(browserHoverShape);
export type BrowserHoverInput = z.infer<typeof browserHoverSchema>;

export const browserDragShape = {
  session_id: z.string().min(1),
  from_ref: z.string().min(1),
  to_ref: z.string().min(1),
} as const;
export const browserDragSchema = z.object(browserDragShape);
export type BrowserDragInput = z.infer<typeof browserDragSchema>;

export const fillFieldKindSchema = z.enum([
  "input",
  "select",
  "checkbox",
  "radio",
]);

export const fillFormFieldSchema = z.object({
  ref: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
  kind: fillFieldKindSchema.optional(),
});

export const browserFillFormShape = {
  session_id: z.string().min(1),
  fields: z.array(fillFormFieldSchema).min(1),
} as const;
export const browserFillFormSchema = z.object(browserFillFormShape);
export type BrowserFillFormInput = z.infer<typeof browserFillFormSchema>;

export const browserUploadFileShape = {
  session_id: z.string().min(1),
  ref: z.string().min(1),
  file_path: z.string().min(1),
} as const;
export const browserUploadFileSchema = z.object(browserUploadFileShape);
export type BrowserUploadFileInput = z.infer<typeof browserUploadFileSchema>;

export const dialogActionSchema = z.enum([
  "accept",
  "dismiss",
  "accept_with_text",
]);

export const browserHandleDialogShape = {
  session_id: z.string().min(1),
  action: dialogActionSchema,
  /** Only used when action='accept_with_text'. */
  text: z.string().optional(),
  /**
   * Arming behavior: registers a one-shot handler for the NEXT dialog
   * raised on the page. Call this BEFORE the action that triggers the
   * dialog (e.g. before clicking the button that calls `confirm()`).
   * Default 30s if no dialog appears, handler is auto-removed.
   */
  timeout_ms: z.number().int().positive().optional(),
  /**
   * When false (default), arm the handler and return immediately so a
   * sequential MCP client can issue the triggering action next; the outcome
   * surfaces as `last_dialog` on a later call. When true, block until the
   * dialog fires or the timeout elapses (only safe if another actor triggers
   * the dialog concurrently).
   */
  wait: z.boolean().default(false),
} as const;
export const browserHandleDialogSchema = z.object(browserHandleDialogShape);
export type BrowserHandleDialogInput = z.infer<typeof browserHandleDialogSchema>;

export const consoleLevelSchema = z.enum([
  "error",
  "warning",
  "info",
  "log",
  "debug",
  "trace",
]);

export const browserConsoleShape = {
  session_id: z.string().min(1),
  /** Filter to only these levels. Default: errors+warnings. */
  levels: z.array(consoleLevelSchema).optional(),
  /** Substring match on message text. */
  contains: z.string().optional(),
  /** Drop all buffered messages after returning. */
  clear: z.boolean().default(false),
  /** Cap on returned messages (artifact still holds full ring buffer). */
  limit: z.number().int().positive().max(1000).default(50),
} as const;
export const browserConsoleSchema = z.object(browserConsoleShape);
export type BrowserConsoleInput = z.infer<typeof browserConsoleSchema>;

export const browserNetworkShape = {
  session_id: z.string().min(1),
  /** Substring or regex (per `pattern_kind`) match on URL. */
  url_pattern: z.string().optional(),
  pattern_kind: z.enum(["substring", "regex"]).default("substring"),
  method: z.string().optional(),
  /** Inclusive range — e.g. `{min: 400, max: 599}` for any error response. */
  status_range: z
    .object({
      min: z.number().int().min(100).max(599),
      max: z.number().int().min(100).max(599),
    })
    .optional(),
  only_failed: z.boolean().default(false),
  /** Write the full HAR file for this session to artifacts/{runId}/network.har. */
  export_har: z.boolean().default(false),
  /** Drop buffered entries after returning. */
  clear: z.boolean().default(false),
  limit: z.number().int().positive().max(1000).default(50),
} as const;
export const browserNetworkSchema = z.object(browserNetworkShape);
export type BrowserNetworkInput = z.infer<typeof browserNetworkSchema>;

export const networkPresetSchema = z.enum([
  "offline",
  "slow-3g",
  "fast-3g",
  "slow-4g",
  "fast-4g",
  "no-throttling",
]);

export const geolocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
});

/**
 * Runtime environment mutation. Merges resize+emulate. Fields here are
 * the ones Playwright supports changing AFTER context creation. Things
 * that must be set at context-creation time (user_agent, locale,
 * timezone) live on `browser_open` and cannot be changed mid-session.
 *
 * `network_throttle` and `cpu_throttle` are chromium-only (CDP-backed).
 */
export const browserSetEnvShape = {
  session_id: z.string().min(1),
  viewport: viewportSchema.optional(),
  offline: z.boolean().optional(),
  geolocation: geolocationSchema.optional(),
  color_scheme: z.enum(["light", "dark", "no-preference"]).optional(),
  reduced_motion: z.enum(["reduce", "no-preference"]).optional(),
  extra_headers: z.record(z.string(), z.string()).optional(),
  network_throttle: networkPresetSchema.optional(),
  /** CPU slowdown multiplier (1 = no throttle, 4 = 4x slower). Chromium only. */
  cpu_throttle: z.number().min(1).max(20).optional(),
} as const;
export const browserSetEnvSchema = z.object(browserSetEnvShape);
export type BrowserSetEnvInput = z.infer<typeof browserSetEnvSchema>;

/**
 * Execute JavaScript in the page context. GATED: server must be started
 * with env `ROLEPOD_ALLOW_EVAL=1`, otherwise the tool returns an
 * `eval_disabled` error. Equivalent to arbitrary code execution — only
 * enable for trusted automation scenarios.
 *
 * `script` is the body of an async function whose return value is sent
 * back as `result`. Use `args` to pass JSON-serialisable values.
 */
export const browserEvaluateShape = {
  session_id: z.string().min(1),
  script: z.string().min(1),
  args: z.array(z.unknown()).optional(),
} as const;
export const browserEvaluateSchema = z.object(browserEvaluateShape);
export type BrowserEvaluateInput = z.infer<typeof browserEvaluateSchema>;

/**
 * Read computed CSS for the first element matching `selector`. Read-only —
 * no eval gate. `properties` overrides the curated default set when given.
 */
export const extractComputedStyleShape = {
  session_id: z.string().min(1),
  selector: z.string().min(1),
  properties: z.array(z.string().min(1)).optional(),
} as const;
export const extractComputedStyleSchema = z.object(extractComputedStyleShape);
export type ExtractComputedStyleInput = z.infer<typeof extractComputedStyleSchema>;

/**
 * Multi-page support. A session owns one browser context, which may
 * have multiple pages (e.g. when an OAuth popup or `target="_blank"`
 * link opens). The active page index is sticky — all subsequent
 * tool calls operate on it until `switch_page` changes it.
 */
export const browserPagesShape = {
  session_id: z.string().min(1),
} as const;
export const browserPagesSchema = z.object(browserPagesShape);
export type BrowserPagesInput = z.infer<typeof browserPagesSchema>;

export const browserSwitchPageShape = {
  session_id: z.string().min(1),
  index: z.number().int().nonnegative(),
} as const;
export const browserSwitchPageSchema = z.object(browserSwitchPageShape);
export type BrowserSwitchPageInput = z.infer<typeof browserSwitchPageSchema>;

// ---------------------------------------------------------------------------
// Composite verify_ui_flow
//
// Both `mode: 'assert'` and `mode: 'reproduce'` are implemented (D-025).
// When mode='reproduce' && passed && minimize, the composite runs a
// classic ddmin pass over `steps` and adds a `minimized` block to the
// output carrying the surviving step list and a `replay-minimized.json`
// artifact path.
// ---------------------------------------------------------------------------

export const verifyFillFieldSchema = z.object({
  query: z.string(),
  value: z.union([z.string(), z.boolean()]),
  kind: fillFieldKindSchema.optional(),
});

export const verifyStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), query: z.string() }),
  z.object({
    kind: z.literal("type"),
    query: z.string(),
    text: z.string(),
    clear_first: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("wait_for"), condition: waitConditionSchema }),
  z.object({ kind: z.literal("navigate"), url: z.string().url() }),
  // v0.5 additions
  z.object({ kind: z.literal("hover"), query: z.string() }),
  z.object({
    kind: z.literal("drag"),
    from_query: z.string(),
    to_query: z.string(),
  }),
  z.object({
    kind: z.literal("fill_form"),
    fields: z.array(verifyFillFieldSchema).min(1),
  }),
  z.object({
    kind: z.literal("upload"),
    query: z.string(),
    file_path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("dialog"),
    action: dialogActionSchema,
    text: z.string().optional(),
  }),
  z.object({
    kind: z.literal("set_env"),
    viewport: viewportSchema.optional(),
    offline: z.boolean().optional(),
    geolocation: geolocationSchema.optional(),
    color_scheme: z.enum(["light", "dark", "no-preference"]).optional(),
    reduced_motion: z.enum(["reduce", "no-preference"]).optional(),
    extra_headers: z.record(z.string(), z.string()).optional(),
    network_throttle: networkPresetSchema.optional(),
    cpu_throttle: z.number().min(1).max(20).optional(),
  }),
  z.object({
    kind: z.literal("switch_page"),
    index: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("evaluate"), script: z.string().min(1) }),
  // v0.9 additions — reveal-on-scroll support (field finding #4)
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]).default("down"),
    amount: z.number().int().positive().optional(),
  }),
  // Convenience: scroll the full page to trigger IntersectionObserver
  // reveals + lazy content, network-idle, then return to top. Mirrors the
  // one-shot settle used by visual_diff. Web-only (PlaywrightEngine).
  z.object({ kind: z.literal("settle") }),
]);

export const verifyExpectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_visible"), text: z.string() }),
  z.object({ kind: z.literal("text_absent"), text: z.string() }),
  z.object({ kind: z.literal("url_matches"), pattern: z.string() }),
  z.object({
    kind: z.literal("ref_in_state"),
    query: z.string(),
    state: z.enum(["visible", "enabled", "focused"]),
  }),
  // v0.5 additions
  z.object({
    kind: z.literal("no_console_errors"),
    exclude_patterns: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("no_failed_requests"),
    exclude_patterns: z.array(z.string()).optional(),
    /** When true, only 5xx counts as a failure. Default false (4xx + 5xx). */
    allow_4xx: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("request_made"),
    url_pattern: z.string(),
    method: z.string().optional(),
    min_count: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("response_status"),
    url_pattern: z.string(),
    status: z.number().int().min(100).max(599),
  }),
]);

export const captureKindSchema = z.enum([
  "screenshot",
  "har",
  "console",
  "a11y_tree",
  "video",
  "trace",
]);

/**
 * Extension Protocol v1 phase vocabulary. Mirrors `ManifestPhase` in
 * `src/util/manifest.ts`; drift is caught at compile time where composites
 * pass the parsed value into `writeManifest`.
 */
export const manifestPhaseSchema = z.enum(["verify", "debug", "build", "review"]);

export const verifyUiFlowShape = {
  mode: z.enum(["assert", "reproduce"]).default("assert"),
  open: browserOpenSchema,
  steps: z.array(verifyStepSchema).default([]),
  expect: z.array(verifyExpectSchema).default([]),
  capture: z.array(captureKindSchema).optional(),
  close_on_finish: z.boolean().default(true),
  /**
   * Only consulted when `mode='reproduce'`. When true (default) and the
   * initial run reproduces the bug, the composite tries to remove each
   * step in turn and re-runs to find a smaller reproducer.
   */
  minimize: z.boolean().default(true),
  /**
   * Phase hint for the emitted manifest.json. The calling skill knows its
   * context — /check-errors tracing a bug should tag evidence "debug" so the
   * parent's debug-issue skill picks it up. Default: "verify".
   */
  phase: manifestPhaseSchema.optional(),
} as const;
export const verifyUiFlowSchema = z.object(verifyUiFlowShape);
export type VerifyUiFlowInput = z.infer<typeof verifyUiFlowSchema>;

// ---------------------------------------------------------------------------
// audit_a11y
// ---------------------------------------------------------------------------

export const wcagLevelSchema = z.enum(["wcag-a", "wcag-aa", "wcag-aaa"]);
export const a11ySeveritySchema = z.enum([
  "critical",
  "serious",
  "moderate",
  "minor",
]);
export const auditScopeSchema = z.union([
  z.literal("page"),
  z.object({ ref: z.string().min(1) }),
]);

export const auditA11yShape = {
  open: browserOpenSchema,
  level: wcagLevelSchema.default("wcag-aa"),
  scope: auditScopeSchema.default("page"),
  report_format: z.enum(["json", "markdown"]).default("json"),
  close_on_finish: z.boolean().default(true),
  /**
   * Phase hint for the emitted manifest.json. An a11y audit run inside a
   * code-review context should tag evidence "review" so the parent's
   * review-code skill aggregates it. Default: "verify".
   */
  phase: manifestPhaseSchema.optional(),
} as const;
export const auditA11ySchema = z.object(auditA11yShape);
export type AuditA11yInput = z.infer<typeof auditA11ySchema>;

// ---------------------------------------------------------------------------
// visual_diff
// ---------------------------------------------------------------------------

export const visualDiffShape = {
  open: browserOpenSchema,
  baseline_id: z.string().min(1),
  viewport: viewportSchema.optional(),
  /**
   * Max fraction of differing pixels (0–1) that still passes. Default 0.01
   * (1% of pixels). The old 0.1 default let a tenth of the page change and
   * still report a pass — too lax to catch real visual regressions.
   */
  threshold_pct: z.number().min(0).max(1).default(0.01),
  close_on_finish: z.boolean().default(true),
  /** Pixel sensitivity for pixelmatch (0 = strict, 1 = lax). Default 0.1. */
  pixel_threshold: z.number().min(0).max(1).default(0.1),
  /**
   * Bring the page to a fully-rendered, deterministic state before capture:
   * scroll the full height to trigger scroll-reveal (opacity:0 +
   * IntersectionObserver) and lazy media, wait for network idle, return to
   * top, and freeze animations/transitions. Default ON — turn off only for
   * static pages where the extra scroll/wait is wasted.
   */
  settle: z.boolean().default(true),
  /**
   * CSS selector to scope the capture to a single element instead of the
   * full page. Diffs the element's own bounding box — catches per-component
   * regressions and sidesteps full-page height drift. Use a distinct
   * baseline_id per region. Omit to diff the whole page.
   */
  selector: z.string().min(1).optional(),
} as const;
export const visualDiffSchema = z.object(visualDiffShape);
export type VisualDiffInput = z.infer<typeof visualDiffSchema>;

// ---------------------------------------------------------------------------
// scaffold_e2e
// ---------------------------------------------------------------------------

export const e2eFrameworkSchema = z.enum([
  "playwright-test",
  "vitest+playwright",
  "pytest+selenium",
  "maestro",
]);

export const scaffoldE2eShape = {
  framework: e2eFrameworkSchema,
  scenario_nl: z.string().min(1),
  /**
   * Entry URL. Required for the web frameworks. For `maestro` pass either
   * `app_id` (mobile app flow) or `url` (web flow) — enforced in the handler
   * since a raw shape cannot express cross-field rules. When both are given,
   * `app_id` wins and the flow targets the mobile app.
   */
  url: z.string().url().optional(),
  /**
   * Application id for `maestro` flows (e.g. `com.example.app`). Ignored by
   * the web frameworks.
   */
  app_id: z.string().min(1).optional(),
  recorded_bundle: z.string().min(1).optional(),
  /** Override the generated test file name. */
  filename: z.string().min(1).optional(),
} as const;
export const scaffoldE2eSchema = z.object(scaffoldE2eShape);
export type ScaffoldE2eInput = z.infer<typeof scaffoldE2eSchema>;

// ---------------------------------------------------------------------------
// extract_ui_state — used internally by other shipped skills (not user-facing).
// ---------------------------------------------------------------------------

export const extractUiStateShape = {
  session_id: z.string().min(1).optional(),
  open: browserOpenSchema.optional(),
  question_nl: z.string().min(1),
  close_on_finish: z.boolean().default(false),
} as const;
export const extractUiStateSchema = z.object(extractUiStateShape);
export type ExtractUiStateInput = z.infer<typeof extractUiStateSchema>;

// ---------------------------------------------------------------------------
// v0.7 measurement surface
//
// Three composites that turn the live browser into a measurement
// substrate: Core Web Vitals (PerformanceObserver), page-weight budget
// (HAR-classified), and on-page SEO (DOM + meta inspection). All three
// are in-browser-observable only — bundle analysis, p95/p99 latency,
// and build-time concerns are reserved for the parent rolepod's
// performance-engineer agent (see brief/handoff-uiproof-v0.7.md).
// ---------------------------------------------------------------------------

export const cwvInteractionStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), query: z.string() }),
  z.object({ kind: z.literal("type"), query: z.string(), text: z.string() }),
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]).default("down"),
    amount: z.number().int().positive().optional(),
  }),
]);

export const cwvThresholdsSchema = z.object({
  lcp_ms: z.number().positive().default(2500),
  inp_ms: z.number().positive().default(200),
  cls: z.number().min(0).default(0.1),
});

export const measureCwvShape = {
  url: z.string().url(),
  browser: browserSchema.optional().default("chromium"),
  viewport: viewportSchema.optional(),
  emulate: z
    .object({
      network_throttle: networkPresetSchema.optional(),
      cpu_throttle: z.number().min(1).max(20).optional(),
    })
    .optional(),
  observe_ms: z.number().int().min(1000).max(30000).default(5000),
  interactions: z.array(cwvInteractionStepSchema).optional(),
  thresholds: cwvThresholdsSchema.optional(),
  close_on_finish: z.boolean().default(true),
} as const;
export const measureCwvSchema = z.object(measureCwvShape);
export type MeasureCwvInput = z.infer<typeof measureCwvSchema>;

export const pageBudgetSchema = z.object({
  total_kb: z.number().positive().default(1500),
  js_kb: z.number().positive().default(300),
  css_kb: z.number().positive().default(100),
  image_kb: z.number().positive().default(500),
  font_kb: z.number().positive().default(100),
  third_party_kb: z.number().positive().default(200),
  request_count: z.number().int().positive().default(100),
});

export const auditPageBudgetShape = {
  url: z.string().url(),
  browser: browserSchema.optional().default("chromium"),
  viewport: viewportSchema.optional(),
  budget: pageBudgetSchema.optional(),
  third_party_hostnames: z.array(z.string().min(1)).optional(),
  wait_for_idle_ms: z.number().int().min(0).max(60000).default(2000),
  close_on_finish: z.boolean().default(true),
} as const;
export const auditPageBudgetSchema = z.object(auditPageBudgetShape);
export type AuditPageBudgetInput = z.infer<typeof auditPageBudgetSchema>;

export const seoCheckSchema = z.enum([
  "title",
  "meta_description",
  "h1",
  "lang",
  "viewport",
  "canonical",
  "robots",
  "og_tags",
  "twitter_tags",
  "json_ld",
  "hreflang",
  "favicon",
]);

export const auditSeoShape = {
  url: z.string().url(),
  browser: browserSchema.optional().default("chromium"),
  viewport: viewportSchema.optional(),
  checks: z.array(seoCheckSchema).optional(),
  report_format: z.enum(["json", "markdown"]).default("json"),
  close_on_finish: z.boolean().default(true),
} as const;
export const auditSeoSchema = z.object(auditSeoShape);
export type AuditSeoInput = z.infer<typeof auditSeoSchema>;

// ---------------------------------------------------------------------------
// discover_flows — black-box flow discovery (brief/13-discover-flows.md)
//
// Crawls a running app like a user (GET navigation, same-origin by default),
// enumerates pages / interactive elements, and derives candidate flows plus a
// proposed test-case table. Read-only: destructive-looking actions (delete /
// pay / send / publish, …) are classified and listed, never executed. Form
// interaction is opt-in and limited to GET forms with dummy data — POST
// submission would mutate the target and stays out of a read-only crawl.
// ---------------------------------------------------------------------------

export const discoverFlowsShape = {
  url: z.string().url(),
  browser: browserSchema.optional().default("chromium"),
  viewport: viewportSchema.optional(),
  /** Hard crawl budget — small defaults; crawling is time/token-expensive. */
  max_pages: z.number().int().min(1).max(50).default(10),
  max_depth: z.number().int().min(0).max(5).default(2),
  max_time_ms: z.number().int().min(5000).max(300_000).default(60_000),
  /**
   * Regex allowlist for URLs beyond the start origin. Same-origin is always
   * crawlable; anything else must match one of these.
   */
  allow_patterns: z.array(z.string().min(1)).optional(),
  /** Regex denylist — wins over same-origin and allow_patterns. */
  deny_patterns: z.array(z.string().min(1)).optional(),
  /**
   * Steps run once before the crawl starts (e.g. a login sequence) — the
   * same step vocabulary /verify-ui uses, so an existing logged-in flow
   * setup can be pasted in unchanged. Never raw credentials as config.
   */
  setup_steps: z.array(verifyStepSchema).optional(),
  /**
   * Opt-in: submit non-destructive GET forms with dummy data to discover
   * result pages (search, filters). POST forms are always listed but never
   * submitted — a black-box crawl must not mutate the target.
   */
  interact_forms: z.boolean().default(false),
  report_format: z.enum(["json", "markdown"]).default("json"),
  close_on_finish: z.boolean().default(true),
  /**
   * Phase hint for the emitted manifest.json. Discovery produces test-plan
   * artifacts (like /scaffold-e2e), so the default is "build".
   */
  phase: manifestPhaseSchema.optional(),
} as const;
export const discoverFlowsSchema = z.object(discoverFlowsShape);
export type DiscoverFlowsInput = z.infer<typeof discoverFlowsSchema>;

// ---------------------------------------------------------------------------
// Tool name registry — single source of truth for tool naming.
// Bare names (no prefix); the MCP server namespace already scopes them.
// ---------------------------------------------------------------------------

export const ToolNames = {
  browserOpen: "browser_open",
  browserClose: "browser_close",
  browserSnapshot: "browser_snapshot",
  browserClick: "browser_click",
  browserType: "browser_type",
  browserKey: "browser_key",
  browserScroll: "browser_scroll",
  browserWaitFor: "browser_wait_for",
  browserScreenshot: "browser_screenshot",
  browserNavigate: "browser_navigate",
  // v0.5 atomics
  browserHover: "browser_hover",
  browserDrag: "browser_drag",
  browserFillForm: "browser_fill_form",
  browserUploadFile: "browser_upload_file",
  browserHandleDialog: "browser_handle_dialog",
  browserConsole: "browser_console",
  browserNetwork: "browser_network",
  browserSetEnv: "browser_set_env",
  browserEvaluate: "browser_evaluate",
  browserPages: "browser_pages",
  browserSwitchPage: "browser_switch_page",
  extractComputedStyle: "extract_computed_style",
  // composite
  verifyUiFlow: "verify_ui_flow",
  auditA11y: "audit_a11y",
  visualDiff: "visual_diff",
  scaffoldE2e: "scaffold_e2e",
  extractUiState: "extract_ui_state",
  // v0.7 measurement surface
  measureCwv: "measure_cwv",
  auditPageBudget: "audit_page_budget",
  auditSeo: "audit_seo",
  // v0.16 black-box discovery
  discoverFlows: "discover_flows",
} as const;

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];
