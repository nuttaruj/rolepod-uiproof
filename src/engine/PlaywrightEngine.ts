import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve as resolvePath, isAbsolute, dirname } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
  type ConsoleMessage,
  type Request,
  type Response,
  type Dialog,
  type CDPSession,
} from "playwright";
import {
  RolepodMcpError,
  UnknownRefError,
  UnsupportedPlatformError,
} from "../util/errors.js";
import { log } from "../util/log.js";
import { redactHarFile } from "../util/harRedact.js";
import {
  parseAriaSnapshot,
  type RefMeta,
} from "./a11y/normalize.js";
import type {
  A11ySnapshot,
  Direction,
  Engine,
  FillField,
  OpenOptions,
  ScreenshotOptions,
  Session,
  WaitCondition,
} from "./Engine.js";

/**
 * Headless is the safe default — display-less CI, servers, and containers
 * cannot launch a headed browser. Opt into a visible browser with
 * `ROLEPOD_HEADED=1`.
 */
export function resolveHeadless(env: NodeJS.ProcessEnv): boolean {
  return env.ROLEPOD_HEADED !== "1";
}

/**
 * True when a launch failed because the browser binary isn't downloaded — the
 * signature of a fresh install or a Playwright version bump that changed the
 * required browser build. Triggers a one-time auto-install.
 */
export function isMissingBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Executable doesn't exist/i.test(msg) ||
    /playwright install/i.test(msg) ||
    /please run the following command to download/i.test(msg)
  );
}

/**
 * Map Playwright's actionability TimeoutError to a classified engine_error so a
 * hidden/disabled/detached/covered target reads as "not actionable" instead of
 * a raw stack after a stall. Returns null for any other error (rethrow as-is).
 */
export function classifyActionTimeout(
  what: string,
  err: unknown,
): RolepodMcpError | null {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new RolepodMcpError(
      "engine_error",
      `${what} timed out — the target element is likely not actionable (hidden, disabled, detached, or covered by another element). Set ROLEPOD_ACTION_TIMEOUT_MS to fail faster. (${err.message.split("\n")[0]})`,
      { action: what },
    );
  }
  return null;
}

type WebSession = Session & {
  readonly platform: "web";
  readonly browser: Browser;
  readonly context: BrowserContext;
  /** Main (initial) page. Subsequent popups land in SessionInternals.pages. */
  readonly mainPage: Page;
};

export type ConsoleEntry = {
  level: "error" | "warning" | "info" | "log" | "debug" | "trace";
  text: string;
  ts: string;
  /** Best-effort file:line if Playwright provides it. */
  location?: string;
};

export type NetworkEntry = {
  id: number;
  url: string;
  method: string;
  status?: number;
  failure?: string;
  resource_type: string;
  ts: string;
  duration_ms?: number;
};

type DialogArming = {
  action: "accept" | "dismiss" | "accept_with_text";
  text?: string;
  expiresAt: number;
  resolve: (handled: boolean) => void;
};

export type DialogInfo = {
  type: string;
  message: string;
  action: "accept" | "dismiss" | "accept_with_text" | "auto_dismiss";
  handled: boolean;
  at: string;
};

type SessionInternals = {
  session: WebSession;
  refIndex: Map<string, RefMeta>;
  snapshotGeneration: number;
  refGeneration: number;
  lastSnapshotAt: string | null;

  // v0.5 additions
  pages: Page[];
  activePageIndex: number;
  consoleBuffer: ConsoleEntry[];
  networkBuffer: NetworkEntry[];
  networkNextId: number;
  /** Persistent CDP session for network/CPU throttle — detaching reverts the
   * emulation, so it is kept alive until close() (rebound if the page changes). */
  cdpSession: CDPSession | null;
  cdpPage: Page | null;
  dialogArming: DialogArming | null;
  lastDialog: DialogInfo | null;
  captureOpts: NonNullable<OpenOptions["capture"]> | undefined;
  traceStarted: boolean;
};

const CONSOLE_BUFFER_CAP = 1000;
const NETWORK_BUFFER_CAP = 1000;

// CDP network condition presets. Numbers match Chrome DevTools UI exactly.
const NETWORK_PRESETS = {
  offline: { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
  "slow-3g": {
    offline: false,
    // 500 Kbps down / 500 Kbps up / 400ms RTT
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
    latency: 400,
  },
  "fast-3g": {
    offline: false,
    downloadThroughput: (1.5 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 150,
  },
  "slow-4g": {
    offline: false,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (3 * 1024 * 1024) / 8,
    latency: 100,
  },
  "fast-4g": {
    offline: false,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (4.5 * 1024 * 1024) / 8,
    latency: 60,
  },
  "no-throttling": {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  },
} as const;

function pushRing<T>(buf: T[], entry: T, cap: number): void {
  buf.push(entry);
  if (buf.length > cap) buf.splice(0, buf.length - cap);
}

function mapConsoleLevel(t: string): ConsoleEntry["level"] {
  switch (t) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    case "debug":
      return "debug";
    case "trace":
      return "trace";
    default:
      return "log";
  }
}

function formatConsoleLocation(msg: ConsoleMessage): string | undefined {
  try {
    const loc = msg.location();
    if (!loc?.url) return undefined;
    return `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`;
  } catch {
    return undefined;
  }
}

function findNetworkEntry(
  buf: NetworkEntry[],
  req: Request,
): NetworkEntry | undefined {
  // Walk back-to-front — most recent match wins (handles redirects /
  // duplicate URLs with separate ids).
  const url = req.url();
  const method = req.method();
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i];
    if (!e) continue;
    if (e.url === url && e.method === method && e.status === undefined && !e.failure) {
      return e;
    }
  }
  return undefined;
}

/**
 * PlaywrightEngine — v0.1 web-only implementation backed by Playwright's
 * Chromium / Firefox / WebKit drivers and the built-in
 * `page.accessibility.snapshot()` API.
 *
 * The interface contract (Engine.ts) is shared with AppiumEngine and the
 * optional SeleniumEngine.
 */
export class PlaywrightEngine implements Engine {
  readonly id = "playwright" as const;

  private readonly sessions = new Map<string, SessionInternals>();

  async open(opts: OpenOptions): Promise<Session> {
    if (opts.platform !== "web") {
      throw new UnsupportedPlatformError(opts.platform);
    }

    const browserName = opts.browser ?? "chromium";
    const launcher =
      browserName === "firefox"
        ? firefox
        : browserName === "webkit"
          ? webkit
          : chromium;

    const headless = opts.headless ?? resolveHeadless(process.env);
    const browser = await this.launchWithAutoInstall(launcher, browserName, headless);

    const contextOptions: Parameters<typeof browser.newContext>[0] = {};
    if (opts.viewport) contextOptions.viewport = opts.viewport;
    if (opts.user_agent) contextOptions.userAgent = opts.user_agent;
    if (opts.locale) contextOptions.locale = opts.locale;
    if (opts.storage_state) contextOptions.storageState = opts.storage_state;

    // Wire capture lifecycle. Playwright requires recordHar / recordVideo
    // to be set at context creation; trace is start/stop-based.
    // HAR stays in mode "full" (audit_page_budget needs sizes/timings);
    // Cookie / Set-Cookie / Authorization are scrubbed on close — see
    // util/harRedact.ts.
    if (opts.capture?.har) {
      contextOptions.recordHar = { path: opts.capture.har.path };
    }
    if (opts.capture?.video) {
      contextOptions.recordVideo = {
        dir: opts.capture.video.dir,
        size:
          opts.capture.video.sizeWidth && opts.capture.video.sizeHeight
            ? {
                width: opts.capture.video.sizeWidth,
                height: opts.capture.video.sizeHeight,
              }
            : undefined,
      };
    }

    const context = await browser.newContext(contextOptions);

    if (opts.capture?.trace) {
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
    }

    const page = await context.newPage();
    const sessionId = randomUUID();

    const internals: SessionInternals = {
      session: {
        id: sessionId,
        platform: "web",
        browser,
        context,
        mainPage: page,
      },
      refIndex: new Map(),
      snapshotGeneration: 0,
      refGeneration: -1,
      lastSnapshotAt: null,
      pages: [page],
      activePageIndex: 0,
      consoleBuffer: [],
      networkBuffer: [],
      networkNextId: 1,
      cdpSession: null,
      cdpPage: null,
      dialogArming: null,
      lastDialog: null,
      captureOpts: opts.capture,
      traceStarted: !!opts.capture?.trace,
    };

    this.attachPageListeners(internals, page);
    context.on("page", (newPage) => {
      internals.pages.push(newPage);
      this.attachPageListeners(internals, newPage);
    });

    if (opts.url) {
      try {
        await page.goto(opts.url, { waitUntil: "domcontentloaded" });
      } catch (err) {
        // The browser launched but the initial navigation failed (dead URL,
        // down localhost, redirect loop). Close it so a session that never
        // opened doesn't leak a live browser process.
        await browser.close().catch(() => undefined);
        throw err;
      }
    }

    this.sessions.set(sessionId, internals);
    log.info("session opened", {
      session_id: sessionId,
      browser: browserName,
      url: opts.url ?? null,
      capture: opts.capture
        ? Object.keys(opts.capture).filter(
            (k) => opts.capture![k as keyof typeof opts.capture],
          )
        : [],
    });
    return { id: sessionId, platform: "web" };
  }

  async close(session: Session): Promise<void> {
    const s = this.requireSession(session.id);

    // Stop tracing before context closes — trace.zip is written here.
    if (s.traceStarted && s.captureOpts?.trace) {
      const tracePath = resolvePath(s.captureOpts.trace.artifactDir, "trace.zip");
      await s.session.context.tracing
        .stop({ path: tracePath })
        .catch((err: unknown) => {
          log.warn("trace stop failed", {
            session_id: session.id,
            err: String(err),
          });
        });
    }

    if (s.cdpSession) {
      await s.cdpSession.detach().catch(() => undefined);
      s.cdpSession = null;
    }
    await s.session.context.close().catch((err: unknown) => {
      log.warn("context close failed", { session_id: session.id, err: String(err) });
    });
    // Playwright flushes network.har on context close. Scrub auth headers
    // before anyone can read it — an authenticated session's HAR is the
    // session.
    if (s.captureOpts?.har) {
      await redactHarFile(s.captureOpts.har.path)
        .then((n) => {
          if (n > 0) log.info("har redacted", { session_id: session.id, scrubbed: n });
        })
        .catch((err: unknown) => {
          log.warn("har redaction failed — treat network.har as a credential", {
            session_id: session.id,
            err: String(err),
          });
        });
    }
    await s.session.browser.close().catch((err: unknown) => {
      log.warn("browser close failed", { session_id: session.id, err: String(err) });
    });
    this.sessions.delete(session.id);
    log.info("session closed", { session_id: session.id });
  }

  async snapshot(
    session: Session,
    mode: "visible" | "full" = "visible",
  ): Promise<A11ySnapshot> {
    const s = this.requireSession(session.id);
    // Playwright 1.60 removed `page.accessibility`. The ai-mode aria
    // snapshot is the supported successor — it carries `[ref=eN]` markers
    // that the `aria-ref=` locator can resolve back to elements.
    const ariaYaml = await this.activePage(s).ariaSnapshot({ mode: "ai" });
    const { tree, refIndex } = parseAriaSnapshot(ariaYaml);
    void mode; // depth control will route here once we expose `depth` to callers.

    s.snapshotGeneration += 1;
    s.refGeneration = s.snapshotGeneration;
    s.refIndex = refIndex;
    s.lastSnapshotAt = new Date().toISOString();

    return {
      session_id: session.id,
      platform: "web",
      url_or_screen: this.activePage(s).url(),
      taken_at: s.lastSnapshotAt,
      tree,
    };
  }

  /**
   * Per-action timeout override (ms) via `ROLEPOD_ACTION_TIMEOUT_MS`. Lets a
   * caller fail fast on a non-actionable element instead of waiting out
   * Playwright's 30s default. Absent → Playwright default.
   */
  private actionTimeout(): { timeout: number } | undefined {
    const raw = process.env.ROLEPOD_ACTION_TIMEOUT_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? { timeout: n } : undefined;
  }

  /**
   * Run an interaction and classify Playwright's actionability TimeoutError
   * into a clear, actionable engine_error, instead of surfacing a raw stack
   * after a 30s stall on a hidden/disabled/detached/covered element.
   */
  private async runAction<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyActionTimeout(what, err);
      if (classified) throw classified;
      throw err;
    }
  }

  private readonly installedThisSession = new Set<string>();

  /**
   * Launch, and if the browser binary isn't downloaded (fresh install or a
   * Playwright version bump that changed the required build), auto-install it
   * once and retry — so `npx @rolepod/uiproof` just works instead of erroring
   * with "Executable doesn't exist". Opt out with ROLEPOD_NO_AUTO_INSTALL=1.
   */
  private async launchWithAutoInstall(
    launcher: typeof chromium | typeof firefox | typeof webkit,
    browserName: string,
    headless: boolean,
  ): Promise<Browser> {
    try {
      return await launcher.launch({ headless });
    } catch (err) {
      if (
        !isMissingBrowserError(err) ||
        process.env.ROLEPOD_NO_AUTO_INSTALL === "1" ||
        this.installedThisSession.has(browserName)
      ) {
        throw err;
      }
      log.warn(
        "browser binary missing — auto-installing (first run / Playwright version drift). This one-time download may take a minute.",
        { browser: browserName },
      );
      this.installBrowser(browserName);
      this.installedThisSession.add(browserName);
      return await launcher.launch({ headless });
    }
  }

  private installBrowser(browserName: string): void {
    const require = createRequire(import.meta.url);
    const cli = resolvePath(dirname(require.resolve("playwright")), "cli.js");
    // For chromium also fetch the headless-shell (a separate download used by
    // headless launches); firefox/webkit have no separate shell.
    const targets =
      browserName === "chromium"
        ? ["chromium", "chromium-headless-shell"]
        : [browserName];
    const res = spawnSync(process.execPath, [cli, "install", ...targets], {
      stdio: "inherit",
      timeout: 300_000,
    });
    if (res.status !== 0) {
      throw new RolepodMcpError(
        "engine_error",
        `Auto-install of the ${browserName} browser failed (exit ${res.status ?? res.signal}). Run \`npx playwright install ${browserName}\` manually, or set ROLEPOD_NO_AUTO_INSTALL=1 to disable auto-install and surface the raw launch error.`,
        { browser: browserName },
      );
    }
  }

  async click(
    session: Session,
    ref: string,
    opts?: { button?: "left" | "right" | "middle" },
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const locator = this.resolveLocator(s, ref);
    await this.runAction("click", () =>
      locator.click({
        ...(opts?.button ? { button: opts.button } : {}),
        ...(this.actionTimeout() ?? {}),
      }),
    );
    this.invalidateRefs(s);
  }

  async type(
    session: Session,
    ref: string,
    text: string,
    opts?: { clearFirst?: boolean },
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const locator = this.resolveLocator(s, ref);
    if (opts?.clearFirst) {
      await this.runAction("type", () => locator.fill("", this.actionTimeout()));
    }
    await this.runAction("type", () => locator.fill(text, this.actionTimeout()));
    this.invalidateRefs(s);
  }

  async key(session: Session, key: string): Promise<void> {
    const s = this.requireSession(session.id);
    await this.activePage(s).keyboard.press(key);
    this.invalidateRefs(s);
  }

  async scroll(
    session: Session,
    dir: Direction,
    amount = 400,
    ref?: string,
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
    if (ref) {
      const locator = this.resolveLocator(s, ref);
      await locator.evaluate(
        (el, [x, y]) => el.scrollBy(x as number, y as number),
        [dx, dy],
      );
    } else {
      await this.activePage(s).mouse.wheel(dx, dy);
    }
    this.invalidateRefs(s);
  }

  async waitFor(
    session: Session,
    cond: WaitCondition,
    timeoutMs = 10_000,
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const page = this.activePage(s);
    switch (cond.kind) {
      case "text_visible":
        await page
          .getByText(cond.text, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: timeoutMs });
        break;
      case "ref_exists":
        // Role-agnostic: wait for ANY element whose accessible text matches the
        // query, not just a button, so `ref_exists` no longer falsely times out
        // for links, inputs, headings, etc. Wait for `visible` (not merely
        // `attached`) so a hidden duplicate (e.g. a display:none responsive-nav
        // copy earlier in the DOM) can't satisfy the wait before the real,
        // visible element renders.
        await page
          .getByText(cond.query, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: timeoutMs });
        break;
      case "url_matches":
        await page.waitForURL(new RegExp(cond.pattern), { timeout: timeoutMs });
        break;
      case "idle":
        await page.waitForLoadState("networkidle", { timeout: timeoutMs });
        await page.waitForTimeout(cond.ms);
        break;
    }
    this.invalidateRefs(s);
  }

  async screenshot(
    session: Session,
    fullPage = false,
    opts: ScreenshotOptions = {},
  ): Promise<Buffer> {
    const s = this.requireSession(session.id);
    return this.activePage(s).screenshot({
      fullPage,
      ...(opts.freezeMotion ? { animations: "disabled", caret: "hide" } : {}),
    });
  }

  /**
   * Capture a single element's bounding box (region-scoped screenshot).
   * Web-only. Auto-waits for the element to be visible; a selector that
   * matches nothing surfaces `invalid_input` rather than a raw timeout.
   */
  async screenshotElement(
    session: Session,
    selector: string,
    opts: ScreenshotOptions = {},
  ): Promise<Buffer> {
    const s = this.requireSession(session.id);
    const locator = this.activePage(s).locator(selector).first();
    try {
      return await locator.screenshot({
        timeout: 10_000,
        ...(opts.freezeMotion ? { animations: "disabled", caret: "hide" } : {}),
      });
    } catch (err) {
      throw new RolepodMcpError(
        "invalid_input",
        `selector "${selector}" matched no visible element to screenshot.`,
        { selector, cause: String(err) },
      );
    }
  }

  /**
   * Read the computed CSS of the first element matching `selector`, plus its
   * bounding box. Read-only DOM introspection — not gated like evaluate().
   * `props` is the exact list of CSS property names to read.
   */
  async computedStyle(
    session: Session,
    selector: string,
    props: string[],
  ): Promise<{
    found: boolean;
    match_count: number;
    styles: Record<string, string>;
    box: { x: number; y: number; width: number; height: number } | null;
  }> {
    const s = this.requireSession(session.id);
    return this.activePage(s).evaluate(
      ({ sel, properties }) => {
        const g = globalThis as unknown as {
          document: { querySelectorAll: (q: string) => ArrayLike<unknown> };
          getComputedStyle: (el: unknown) => {
            getPropertyValue: (p: string) => string;
          };
        };
        const nodes = g.document.querySelectorAll(sel);
        if (nodes.length === 0) {
          return { found: false, match_count: 0, styles: {}, box: null };
        }
        const el = nodes[0] as {
          getBoundingClientRect: () => {
            x: number;
            y: number;
            width: number;
            height: number;
          };
        };
        const cs = g.getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (const p of properties) styles[p] = cs.getPropertyValue(p);
        const r = el.getBoundingClientRect();
        return {
          found: true,
          match_count: nodes.length,
          styles,
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      },
      { sel: selector, properties: props },
    );
  }

  /**
   * Bring the page to a deterministic, fully-rendered state before a
   * capture. A fullPage screenshot resizes the viewport in one step and
   * never fires the scroll/intersection events that scroll-reveal widgets
   * (opacity:0 + IntersectionObserver) and lazy media wait for — so an
   * immediate capture records them invisible. settle() steps down a
   * viewport at a time to trigger every observer + lazy load, waits for the
   * network to go idle, then returns to the top. Best-effort: a networkidle
   * timeout is swallowed (pages with persistent sockets never idle).
   *
   * Pair with `screenshot(…, { freezeMotion: true })` — settle reveals
   * the content, freezeMotion makes the pixels deterministic.
   */
  async settle(
    session: Session,
    opts: {
      scroll?: boolean;
      timeoutMs?: number;
      quietMs?: number;
      maxScrollSteps?: number;
    } = {},
  ): Promise<{ scrolled_steps: number; capped: boolean }> {
    const s = this.requireSession(session.id);
    const page = this.activePage(s);
    const scroll = opts.scroll ?? true;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const quietMs = opts.quietMs ?? 400;
    const maxSteps = opts.maxScrollSteps ?? 40;

    await page
      .waitForLoadState("networkidle", { timeout: timeoutMs })
      .catch(() => undefined);

    let steps = 0;
    let capped = false;
    if (scroll) {
      for (; steps < maxSteps; steps++) {
        const atBottom = await page.evaluate(() => {
          const g = globalThis as unknown as {
            scrollTo: (x: number, y: number) => void;
            scrollY: number;
            innerHeight: number;
            document: { body: { scrollHeight: number } };
          };
          const next = g.scrollY + g.innerHeight;
          g.scrollTo(0, next);
          // Re-read scrollHeight each step — lazy content grows the page.
          return next >= g.document.body.scrollHeight - g.innerHeight;
        });
        await page.waitForTimeout(quietMs);
        if (atBottom) {
          steps += 1;
          break;
        }
      }
      capped = steps >= maxSteps;
      if (capped) {
        log.warn("settle scroll hit maxScrollSteps — page may be longer", {
          session_id: session.id,
          max_steps: maxSteps,
        });
      }
      // Settle anything the scroll kicked off (lazy images, fetches), then
      // return to the top so fixed/sticky elements render predictably.
      await page
        .waitForLoadState("networkidle", { timeout: timeoutMs })
        .catch(() => undefined);
      await page.evaluate(() => {
        (
          globalThis as unknown as { scrollTo: (x: number, y: number) => void }
        ).scrollTo(0, 0);
      });
      await page.waitForTimeout(quietMs);
    }

    this.invalidateRefs(s);
    return { scrolled_steps: steps, capped };
  }

  async navigate(session: Session, url: string): Promise<void> {
    const s = this.requireSession(session.id);
    if (s.session.platform !== "web") {
      throw new UnsupportedPlatformError(s.session.platform);
    }
    await this.activePage(s).goto(url, { waitUntil: "domcontentloaded" });
    this.invalidateRefs(s);
  }

  /**
   * Composite-only escape hatch — exposes the raw Playwright Page so a
   * composite tool that genuinely needs page-level APIs (axe-core,
   * `getByText`, etc.) can use them without bloating the Engine interface
   * with web-specific verbs. Throws if the session is not web.
   */
  getPageForSession(sessionId: string): Page {
    const s = this.requireSession(sessionId);
    if (s.session.platform !== "web") {
      throw new UnsupportedPlatformError(s.session.platform);
    }
    return this.activePage(s);
  }

  /** Increment generation; the next ref-using call will see them as stale. */
  bumpGeneration(sessionId: string): void {
    const s = this.requireSession(sessionId);
    this.invalidateRefs(s);
  }

  // -------------------------------------------------------------------------
  // v0.5 — input additions
  // -------------------------------------------------------------------------

  async hover(session: Session, ref: string): Promise<void> {
    const s = this.requireSession(session.id);
    const locator = this.resolveLocator(s, ref);
    await this.runAction("hover", () => locator.hover(this.actionTimeout()));
    // Hover does not modify DOM in the same way click does; keep refs valid.
  }

  async drag(
    session: Session,
    fromRef: string,
    toRef: string,
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const from = this.resolveLocator(s, fromRef);
    const to = this.resolveLocator(s, toRef);
    await this.runAction("drag", () => from.dragTo(to, this.actionTimeout()));
    this.invalidateRefs(s);
  }

  async fillForm(session: Session, fields: FillField[]): Promise<void> {
    const s = this.requireSession(session.id);
    for (const field of fields) {
      const locator = this.resolveLocator(s, field.ref);
      const kind = field.kind;
      const t = this.actionTimeout();
      if (kind === "checkbox" || kind === "radio") {
        const checked = typeof field.value === "boolean"
          ? field.value
          : field.value === "true" || field.value === "on";
        await this.runAction("fill_form", () => locator.setChecked(checked, t));
      } else if (kind === "select") {
        await this.runAction("fill_form", () =>
          locator.selectOption(String(field.value), t),
        );
      } else {
        // input / textarea / contenteditable
        await this.runAction("fill_form", () => locator.fill(String(field.value), t));
      }
    }
    this.invalidateRefs(s);
  }

  async uploadFile(
    session: Session,
    ref: string,
    filePath: string,
  ): Promise<void> {
    const s = this.requireSession(session.id);
    if (!isAbsolute(filePath)) {
      throw new RolepodMcpError(
        "invalid_input",
        `upload_file requires an absolute path; got "${filePath}".`,
        { file_path: filePath },
      );
    }
    const locator = this.resolveLocator(s, ref);
    await this.runAction("upload", () =>
      locator.setInputFiles(filePath, this.actionTimeout()),
    );
    this.invalidateRefs(s);
  }

  // -------------------------------------------------------------------------
  // v0.5 — web-only extensions (not on Engine interface; tools cast to
  // PlaywrightEngine before calling).
  // -------------------------------------------------------------------------

  /**
   * Pre-arm a one-shot dialog handler for the next dialog raised on the
   * active page. Returns when either the dialog fires (and is handled)
   * or the timeout elapses. The caller is expected to trigger the
   * dialog (via click etc.) AFTER arming.
   */
  async handleDialog(
    sessionId: string,
    opts: {
      action: "accept" | "dismiss" | "accept_with_text";
      text?: string;
      timeoutMs?: number;
      wait?: boolean;
    },
  ): Promise<{ handled: boolean; armed?: boolean; last_dialog?: DialogInfo | null }> {
    const s = this.requireSession(sessionId);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const expiresAt = Date.now() + timeoutMs;

    // If a previous arming is still pending, treat the new call as a
    // replacement.
    if (s.dialogArming) {
      s.dialogArming.resolve(false);
    }

    if (!opts.wait) {
      // Default: arm and return immediately so a sequential MCP client can
      // issue the triggering action next (a blocking wait would deadlock —
      // the client can't fire the dialog while this call is pending). The
      // page.on("dialog") consumer handles the next dialog; its outcome
      // surfaces as `last_dialog`. handlePageDialog's expiresAt check auto-
      // expires a stale arming.
      s.dialogArming = {
        action: opts.action,
        text: opts.text,
        expiresAt,
        resolve: () => {
          s.dialogArming = null;
        },
      };
      return { armed: true, handled: false, last_dialog: s.lastDialog };
    }

    return new Promise<{ handled: boolean }>((resolve) => {
      const arming: DialogArming = {
        action: opts.action,
        text: opts.text,
        expiresAt,
        resolve: (handled) => {
          s.dialogArming = null;
          resolve({ handled });
        },
      };
      s.dialogArming = arming;

      // Timeout safety
      const timer = setTimeout(() => {
        if (s.dialogArming === arming) {
          s.dialogArming = null;
          resolve({ handled: false });
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  getConsole(
    sessionId: string,
    opts?: {
      levels?: ConsoleEntry["level"][];
      contains?: string;
      clear?: boolean;
      limit?: number;
    },
  ): ConsoleEntry[] {
    const s = this.requireSession(sessionId);
    const levels = opts?.levels;
    const contains = opts?.contains;
    const limit = opts?.limit ?? 50;
    let entries = s.consoleBuffer;
    if (levels && levels.length > 0) {
      entries = entries.filter((e) => levels.includes(e.level));
    }
    if (contains) {
      entries = entries.filter((e) => e.text.includes(contains));
    }
    const result = entries.slice(-limit);
    if (opts?.clear) s.consoleBuffer = [];
    return result;
  }

  getNetwork(
    sessionId: string,
    opts?: {
      urlPattern?: string;
      patternKind?: "substring" | "regex";
      method?: string;
      statusRange?: { min: number; max: number };
      onlyFailed?: boolean;
      clear?: boolean;
      limit?: number;
    },
  ): NetworkEntry[] {
    const s = this.requireSession(sessionId);
    let entries = s.networkBuffer;
    if (opts?.urlPattern) {
      if (opts.patternKind === "regex") {
        const re = new RegExp(opts.urlPattern);
        entries = entries.filter((e) => re.test(e.url));
      } else {
        entries = entries.filter((e) => e.url.includes(opts.urlPattern!));
      }
    }
    if (opts?.method) {
      const m = opts.method.toUpperCase();
      entries = entries.filter((e) => e.method.toUpperCase() === m);
    }
    if (opts?.statusRange) {
      const { min, max } = opts.statusRange;
      entries = entries.filter(
        (e) =>
          e.status !== undefined && e.status >= min && e.status <= max,
      );
    }
    if (opts?.onlyFailed) {
      entries = entries.filter(
        (e) => !!e.failure || (e.status !== undefined && e.status >= 400),
      );
    }
    const limit = opts?.limit ?? 50;
    const result = entries.slice(-limit);
    if (opts?.clear) s.networkBuffer = [];
    return result;
  }

  /**
   * Read the consoleBuffer/networkBuffer directly without filtering —
   * used by verify_ui_flow expect evaluators.
   */
  peekBuffers(sessionId: string): {
    console: ConsoleEntry[];
    network: NetworkEntry[];
  } {
    const s = this.requireSession(sessionId);
    return { console: s.consoleBuffer, network: s.networkBuffer };
  }

  /**
   * Runtime mutation of context-level emulation. CPU + network throttle
   * use CDP and only work on chromium; everything else is cross-browser.
   */
  async setEnv(
    sessionId: string,
    opts: {
      viewport?: { width: number; height: number };
      offline?: boolean;
      geolocation?: { latitude: number; longitude: number; accuracy?: number };
      colorScheme?: "light" | "dark" | "no-preference";
      reducedMotion?: "reduce" | "no-preference";
      extraHeaders?: Record<string, string>;
      networkThrottle?:
        | "offline"
        | "slow-3g"
        | "fast-3g"
        | "slow-4g"
        | "fast-4g"
        | "no-throttling";
      cpuThrottle?: number;
    },
  ): Promise<void> {
    const s = this.requireSession(sessionId);
    const page = this.activePage(s);
    const ctx = s.session.context;

    if (opts.viewport) {
      await page.setViewportSize(opts.viewport);
    }
    if (opts.offline !== undefined) {
      await ctx.setOffline(opts.offline);
    }
    if (opts.geolocation) {
      await ctx.setGeolocation(opts.geolocation);
    }
    if (opts.extraHeaders) {
      await ctx.setExtraHTTPHeaders(opts.extraHeaders);
    }
    if (opts.colorScheme || opts.reducedMotion) {
      await page.emulateMedia({
        ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
        ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}),
      });
    }
    if (opts.networkThrottle || opts.cpuThrottle !== undefined) {
      const browserName = ctx.browser()?.browserType().name();
      if (browserName !== "chromium") {
        throw new RolepodMcpError(
          "unsupported_engine",
          `networkThrottle / cpuThrottle require chromium (CDP-backed); current browser is "${browserName}".`,
        );
      }
      // Keep the CDP session attached — detaching reverts the emulation, so
      // the previous code applied a throttle that immediately snapped back.
      // Reuse one persistent session per web session; rebind if the active
      // page changed; detach happens in close().
      if (s.cdpSession && s.cdpPage !== page) {
        await s.cdpSession.detach().catch(() => undefined);
        s.cdpSession = null;
      }
      if (!s.cdpSession) {
        s.cdpSession = await ctx.newCDPSession(page);
        s.cdpPage = page;
      }
      const cdp = s.cdpSession;
      if (opts.networkThrottle) {
        const preset = NETWORK_PRESETS[opts.networkThrottle];
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", preset);
      }
      if (opts.cpuThrottle !== undefined) {
        await cdp.send("Emulation.setCPUThrottlingRate", {
          rate: opts.cpuThrottle,
        });
      }
    }
    this.invalidateRefs(s);
  }

  /**
   * Execute a JavaScript function in the page context. ALWAYS gated by
   * the tool layer (`ROLEPOD_ALLOW_EVAL=1`); this method does not enforce
   * the env check.
   */
  async evaluate(
    sessionId: string,
    script: string,
    args?: unknown[],
  ): Promise<unknown> {
    const s = this.requireSession(sessionId);
    const page = this.activePage(s);
    // Script body runs inside `(async () => { ... })()` in the page context.
    // Caller can `return await fetch(...)` etc. `args` is exposed as a global
    // `args` array.
    return page.evaluate(
      ({ src, a }) =>
        // eslint-disable-next-line no-new-func
        new Function("args", `return (async () => { ${src} })();`)(a),
      { src: script, a: args ?? [] },
    );
  }

  listPages(sessionId: string): {
    index: number;
    url: string;
    title_promise: Promise<string>;
    active: boolean;
  }[] {
    const s = this.requireSession(sessionId);
    return s.pages.map((p, i) => ({
      index: i,
      url: p.url(),
      // A page can close between listing and awaiting the title — degrade
      // to "" instead of leaving an unhandled rejection behind.
      title_promise: p.title().catch(() => ""),
      active: i === s.activePageIndex,
    }));
  }

  async switchPage(sessionId: string, index: number): Promise<void> {
    const s = this.requireSession(sessionId);
    if (index < 0 || index >= s.pages.length) {
      throw new RolepodMcpError(
        "invalid_input",
        `Page index ${index} out of range (have ${s.pages.length} page(s)).`,
        { index, available: s.pages.length },
      );
    }
    s.activePageIndex = index;
    this.invalidateRefs(s);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private activePage(s: SessionInternals): Page {
    return s.pages[s.activePageIndex] ?? s.session.mainPage;
  }

  private attachPageListeners(s: SessionInternals, page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const level = mapConsoleLevel(msg.type());
      pushRing(
        s.consoleBuffer,
        {
          level,
          text: msg.text(),
          ts: new Date().toISOString(),
          location: formatConsoleLocation(msg),
        },
        CONSOLE_BUFFER_CAP,
      );
    });

    page.on("request", (req: Request) => {
      const id = s.networkNextId++;
      // Optimistic entry — updated on response/failed.
      pushRing(
        s.networkBuffer,
        {
          id,
          url: req.url(),
          method: req.method(),
          resource_type: req.resourceType(),
          ts: new Date().toISOString(),
        },
        NETWORK_BUFFER_CAP,
      );
    });

    page.on("response", (res: Response) => {
      const req = res.request();
      const entry = findNetworkEntry(s.networkBuffer, req);
      if (entry) {
        entry.status = res.status();
        entry.duration_ms = Date.now() - new Date(entry.ts).getTime();
      }
    });

    page.on("requestfailed", (req: Request) => {
      const entry = findNetworkEntry(s.networkBuffer, req);
      if (entry) {
        entry.failure = req.failure()?.errorText ?? "request failed";
      }
    });

    page.on("dialog", (dialog: Dialog) => {
      void this.handlePageDialog(s, dialog);
    });

    // Prune a page from the session when it closes so listPages/switch_page
    // never operate on a dead tab, and activePageIndex never dangles.
    page.on("close", () => {
      const idx = s.pages.indexOf(page);
      if (idx === -1) return;
      s.pages.splice(idx, 1);
      if (idx < s.activePageIndex) {
        s.activePageIndex -= 1;
      } else if (idx === s.activePageIndex) {
        s.activePageIndex = Math.min(s.activePageIndex, s.pages.length - 1);
      }
      if (s.activePageIndex < 0) s.activePageIndex = 0;
    });
  }

  private async handlePageDialog(
    s: SessionInternals,
    dialog: Dialog,
  ): Promise<void> {
    const type = dialog.type();
    const message = dialog.message();
    const at = new Date().toISOString();
    const arm = s.dialogArming;
    if (!arm || Date.now() > arm.expiresAt) {
      // Nothing armed → auto-dismiss so the page does not hang.
      await dialog.dismiss().catch(() => undefined);
      s.lastDialog = { type, message, action: "auto_dismiss", handled: false, at };
      if (arm) arm.resolve(false);
      return;
    }
    try {
      if (arm.action === "accept") {
        await dialog.accept();
      } else if (arm.action === "accept_with_text") {
        await dialog.accept(arm.text ?? "");
      } else {
        await dialog.dismiss();
      }
      s.lastDialog = { type, message, action: arm.action, handled: true, at };
      arm.resolve(true);
    } catch (err) {
      s.lastDialog = { type, message, action: arm.action, handled: false, at };
      log.warn("dialog handle failed", {
        session_id: s.session.id,
        err: String(err),
      });
      arm.resolve(false);
    }
  }

  private requireSession(sessionId: string): SessionInternals {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new RolepodMcpError(
        "unknown_session",
        `No open session with id "${sessionId}".`,
        { session_id: sessionId },
      );
    }
    return s;
  }

  private resolveLocator(s: SessionInternals, ref: string): Locator {
    if (s.refGeneration !== s.snapshotGeneration) {
      throw new RolepodMcpError(
        "stale_ref",
        `Ref "${ref}" is stale — re-snapshot before retrying.`,
        {
          session_id: s.session.id,
          ref,
          last_valid_snapshot_at: s.lastSnapshotAt,
        },
      );
    }
    const meta = s.refIndex.get(ref);
    if (!meta) throw new UnknownRefError(s.session.id, ref);
    // The synthetic refs (`s1`, `s2`, ...) we issue for the wrapper root
    // are not real elements; the Lead should never click them.
    if (meta.ref.startsWith("s")) {
      throw new UnknownRefError(s.session.id, ref);
    }
    return this.activePage(s).locator(`aria-ref=${meta.ref}`);
  }

  private invalidateRefs(s: SessionInternals): void {
    s.snapshotGeneration += 1;
  }

  /**
   * Test / shutdown helper. Closes every open session.
   */
  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(
      ids.map((id) => this.close({ id, platform: "web" }).catch(() => undefined)),
    );
  }
}
