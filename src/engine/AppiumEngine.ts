import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  RolepodMcpError,
  UnknownRefError,
  UnknownSessionError,
  UnsupportedPlatformError,
} from "../util/errors.js";
import { log } from "../util/log.js";
import {
  parseUiAutomator2Tree,
  type AndroidRefMeta,
} from "./a11y/uiautomator2.js";
import { parseXcuiTestTree, type IosRefMeta } from "./a11y/xcuitest.js";
import {
  autoAppiumDisabled,
  ensureAppiumUp,
  installManagedWebdriverio,
  isAppiumConnectionError,
  isLoopbackHost,
  preflightMobileHost,
  resolveManagedWebdriverio,
} from "./appiumProvision.js";
import type {
  A11ySnapshot,
  Direction,
  Engine,
  OpenOptions,
  Platform,
  Session,
  WaitCondition,
} from "./Engine.js";

type MobileRefMeta = IosRefMeta | AndroidRefMeta;

/**
 * Minimal subset of the webdriverio `Browser` surface that AppiumEngine
 * relies on. We type only what we use so that consumers without
 * `webdriverio` installed still typecheck.
 */
type WdioElement = {
  click(): Promise<void>;
  clearValue(): Promise<void>;
  setValue(value: string): Promise<void>;
  isEnabled(): Promise<boolean>;
};

type WdioBrowser = {
  sessionId: string;
  capabilities: Record<string, unknown>;
  getPageSource(): Promise<string>;
  saveScreenshot(filepath?: string): Promise<Buffer>;
  takeScreenshot(): Promise<string>; // base64
  pressKeyCode?: (code: number) => Promise<void>;
  $(selector: string): Promise<WdioElement> & WdioElement;
  execute<T = unknown>(script: string, ...args: unknown[]): Promise<T>;
  deleteSession(): Promise<void>;
  pause(ms: number): Promise<void>;
};

type WdioRemote = (
  opts: Record<string, unknown>,
) => Promise<WdioBrowser>;

type MobileSession = {
  readonly id: string;
  readonly platform: "ios" | "android";
  readonly driver: WdioBrowser;
};

type SessionInternals = {
  session: MobileSession;
  refIndex: Map<string, MobileRefMeta>;
  snapshotGeneration: number;
  refGeneration: number;
  lastSnapshotAt: string | null;
};

/**
 * AppiumEngine — v0.3 mobile support via Appium 2.x + webdriverio.
 *
 * webdriverio is an `optionalDependency` (brief D-020). The engine
 * lazy-imports it; if missing, every public method throws a structured
 * `engine_error` with installation guidance.
 *
 * Smoke tests run against a real simulator only when one is reachable;
 * unit tests for AT normalization use fixture XML strings (see
 * `tests/unit/`).
 */
export class AppiumEngine implements Engine {
  readonly id = "appium" as const;

  private readonly sessions = new Map<string, SessionInternals>();
  private wdioCache: WdioRemote | null = null;

  async open(opts: OpenOptions): Promise<Session> {
    if (opts.platform !== "ios" && opts.platform !== "android") {
      throw new UnsupportedPlatformError(opts.platform);
    }
    const host = process.env.APPIUM_HOST ?? "127.0.0.1";
    const port = Number(process.env.APPIUM_PORT ?? 4723);
    const path = process.env.APPIUM_BASE_PATH ?? "/";
    // Fail fast with actionable guidance if the host is missing Xcode /
    // the Android SDK — otherwise those surface as cryptic driver errors
    // deep inside appium. A remote APPIUM_HOST brings its own devices, and
    // ROLEPOD_NO_AUTO_APPIUM=1 means "hands off my environment" — both
    // skip the preflight.
    if (isLoopbackHost(host) && !autoAppiumDisabled()) {
      preflightMobileHost(opts.platform);
    }
    const remote = await this.loadWdio();
    const caps = this.buildCapabilities(opts);
    const connect = () => remote({ hostname: host, port, path, capabilities: caps });
    const wrap = (err: unknown, provisioned: boolean) =>
      new RolepodMcpError(
        "engine_error",
        `Could not start an Appium session (${err instanceof Error ? err.message : String(err)}). ` +
          (provisioned
            ? `The Appium server was auto-started at ${host}:${port}${path} but the session still failed — check that a ${opts.platform} device/simulator is available and matches the capabilities.`
            : `Check that the Appium server is running at ${host}:${port}${path} and a ${opts.platform} device/simulator is available and matches the capabilities.`),
        { platform: opts.platform },
      );
    let driver: WdioBrowser;
    try {
      driver = await connect();
    } catch (err) {
      // Mobile analog of the browser auto-install: a connection-level
      // failure against a loopback host means "no server there" — so
      // provision one (install appium + driver if needed, start the
      // daemon) and retry ONCE. Anything else keeps the original error.
      if (
        !isAppiumConnectionError(err) ||
        autoAppiumDisabled() ||
        !isLoopbackHost(host)
      ) {
        throw wrap(err, false);
      }
      await ensureAppiumUp(opts.platform, { host, port, basePath: path });
      try {
        driver = await connect();
      } catch (retryErr) {
        // Still a connection error after provisioning → the auto-started
        // server died; don't misdirect the user at device availability.
        if (isAppiumConnectionError(retryErr)) {
          throw new RolepodMcpError(
            "engine_error",
            `The Appium server was auto-started at ${host}:${port}${path} but stopped responding ` +
              `(${retryErr instanceof Error ? retryErr.message : String(retryErr)}). ` +
              `Try starting it manually with \`appium\` to see its startup logs.`,
            { platform: opts.platform },
          );
        }
        throw wrap(retryErr, true);
      }
    }

    const sessionId = randomUUID();
    const session: MobileSession = { id: sessionId, platform: opts.platform, driver };
    this.sessions.set(sessionId, {
      session,
      refIndex: new Map(),
      snapshotGeneration: 0,
      refGeneration: -1,
      lastSnapshotAt: null,
    });
    log.info("mobile session opened", {
      session_id: sessionId,
      platform: opts.platform,
      remote_session: driver.sessionId,
    });
    return { id: sessionId, platform: opts.platform };
  }

  async close(session: Session): Promise<void> {
    const s = this.requireSession(session.id);
    await s.session.driver.deleteSession().catch((err: unknown) =>
      log.warn("appium deleteSession failed", { session_id: session.id, err: String(err) }),
    );
    this.sessions.delete(session.id);
    log.info("mobile session closed", { session_id: session.id });
  }

  async snapshot(session: Session, _mode?: "visible" | "full"): Promise<A11ySnapshot> {
    void _mode;
    const s = this.requireSession(session.id);
    const xml = await s.session.driver.getPageSource();
    const normalized =
      s.session.platform === "ios"
        ? parseXcuiTestTree(xml)
        : parseUiAutomator2Tree(xml);

    s.snapshotGeneration += 1;
    s.refGeneration = s.snapshotGeneration;
    s.refIndex = normalized.refIndex as Map<string, MobileRefMeta>;
    s.lastSnapshotAt = new Date().toISOString();

    return {
      session_id: session.id,
      platform: s.session.platform,
      url_or_screen: this.screenIdentifier(s),
      taken_at: s.lastSnapshotAt,
      tree: normalized.tree,
    };
  }

  async click(session: Session, ref: string): Promise<void> {
    const s = this.requireSession(session.id);
    const el = await this.resolveElement(s, ref);
    await el.click();
    this.invalidateRefs(s);
  }

  async type(
    session: Session,
    ref: string,
    text: string,
    opts?: { clearFirst?: boolean },
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const el = await this.resolveElement(s, ref);
    if (opts?.clearFirst) await el.clearValue();
    await el.setValue(text);
    this.invalidateRefs(s);
  }

  async key(session: Session, key: string): Promise<void> {
    const s = this.requireSession(session.id);
    if (s.session.platform === "android" && s.session.driver.pressKeyCode) {
      const code = ANDROID_KEY_CODES[key];
      if (code !== undefined) {
        await s.session.driver.pressKeyCode(code);
        this.invalidateRefs(s);
        return;
      }
    }
    throw new RolepodMcpError(
      "not_implemented_in_v02",
      `Mobile key("${key}") is partially supported in v0.3 — only well-known Android keycodes are mapped. iOS hardware keys land later.`,
      { platform: s.session.platform, key },
    );
  }

  async scroll(
    session: Session,
    dir: Direction,
    amount = 400,
    _ref?: string,
  ): Promise<void> {
    void _ref;
    const s = this.requireSession(session.id);
    // Mobile scroll is fiddly across drivers — fall back to a touch
    // gesture via execute(). Most consumers will prefer a `wait_for`
    // followed by a `click` on a ref that scrolls into view.
    const action =
      s.session.platform === "ios"
        ? "mobile: swipe"
        : "mobile: scrollGesture";
    const params =
      s.session.platform === "ios"
        ? { direction: dir }
        : { left: 100, top: 200, width: 400, height: 600, direction: dir, percent: amount / 1000 };
    try {
      await s.session.driver.execute(action, params);
    } catch (err) {
      // Don't swallow a failed gesture as success — the caller must know the
      // scroll didn't happen rather than assume the target is now in view.
      throw new RolepodMcpError(
        "engine_error",
        `scroll (${dir}) gesture failed: ${err instanceof Error ? err.message : String(err)}`,
        { direction: dir },
      );
    }
    this.invalidateRefs(s);
  }

  async waitFor(
    session: Session,
    cond: WaitCondition,
    timeoutMs = 10_000,
  ): Promise<void> {
    const s = this.requireSession(session.id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond.kind === "idle") {
        await s.session.driver.pause(cond.ms);
        this.invalidateRefs(s);
        return;
      }
      // Poll on a fresh parse WITHOUT clobbering the session's refIndex /
      // generation — otherwise a pre-wait ref the caller holds would silently
      // resolve against a newly-rebuilt tree (positional refs like e5 point at
      // a different element). After a successful wait the caller re-snapshots.
      const xml = await s.session.driver.getPageSource();
      const tree = (
        s.session.platform === "ios"
          ? parseXcuiTestTree(xml)
          : parseUiAutomator2Tree(xml)
      ).tree;
      const matched =
        cond.kind === "text_visible"
          ? treeIncludesText(tree, cond.text)
          : cond.kind === "ref_exists"
            ? treeIncludesText(tree, cond.query)
            : false;
      if (matched) return;
      await s.session.driver.pause(250);
    }
    throw new RolepodMcpError(
      "engine_error",
      `wait_for ${cond.kind} timed out after ${timeoutMs}ms`,
      { condition: cond, timeout_ms: timeoutMs },
    );
  }

  async screenshot(session: Session, _fullPage?: boolean): Promise<Buffer> {
    void _fullPage;
    const s = this.requireSession(session.id);
    const b64 = await s.session.driver.takeScreenshot();
    return Buffer.from(b64, "base64");
  }

  async navigate(_session: Session, _url: string): Promise<void> {
    throw new UnsupportedPlatformError(_session.platform);
  }

  // -------------------------------------------------------------------------
  // v0.5 cross-platform additions — mobile stubs.
  // These ship as `not_implemented_in_v05` until the mobile gesture work lands.
  // -------------------------------------------------------------------------

  async hover(_session: Session, _ref: string): Promise<void> {
    throw new RolepodMcpError(
      "engine_error",
      "hover is not yet implemented for mobile (Appium). Use long-press via custom gesture if needed.",
    );
  }

  async drag(_session: Session, _fromRef: string, _toRef: string): Promise<void> {
    throw new RolepodMcpError(
      "engine_error",
      "drag is not yet implemented for mobile (Appium). Use the W3C Actions API directly if needed.",
    );
  }

  async fillForm(
    session: Session,
    fields: { ref: string; value: string | boolean; kind?: string }[],
  ): Promise<void> {
    const s = this.requireSession(session.id);
    // Resolve + set every field against the SAME snapshot generation and
    // invalidate once at the end. Calling type() per field would invalidate
    // refs after field 1, so field 2+ would throw stale_ref (multi-field
    // fills always failed).
    for (const f of fields) {
      const el = await this.resolveElement(s, f.ref);
      const v = typeof f.value === "boolean" ? String(f.value) : f.value;
      await el.setValue(v);
    }
    this.invalidateRefs(s);
  }

  async uploadFile(
    _session: Session,
    _ref: string,
    _filePath: string,
  ): Promise<void> {
    throw new RolepodMcpError(
      "engine_error",
      "upload_file is not supported on mobile (Appium).",
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadWdio(): Promise<WdioRemote> {
    if (this.wdioCache) return this.wdioCache;
    type WdioModule = { remote: WdioRemote };
    // 1. A webdriverio the user installed alongside us (pre-0.19 layout, or
    //    an explicit `npm i webdriverio`). Avoid TypeScript pulling the
    //    module into static types.
    try {
      const mod = (await import(/* @vite-ignore */ "webdriverio")) as unknown as WdioModule;
      this.wdioCache = mod.remote;
      return mod.remote;
    } catch {
      /* fall through to the managed install */
    }
    // 2. Managed install under ~/.rolepod-uiproof/webdriverio — provisioned
    //    on demand, same policy as Appium and the Playwright browsers.
    let entry = resolveManagedWebdriverio();
    if (!entry) {
      if (process.env.ROLEPOD_NO_AUTO_INSTALL === "1") {
        throw new RolepodMcpError(
          "engine_error",
          "Mobile support needs webdriverio and ROLEPOD_NO_AUTO_INSTALL=1 disabled the managed install. Run `npx @rolepod/uiproof install:mobile`.",
        );
      }
      entry = installManagedWebdriverio();
    }
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as WdioModule;
      this.wdioCache = mod.remote;
      return mod.remote;
    } catch (err) {
      throw new RolepodMcpError(
        "engine_error",
        "Mobile support needs webdriverio (and a running Appium server). Run `npx @rolepod/uiproof install:mobile` for the setup checklist.",
        { entry, cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private buildCapabilities(opts: OpenOptions): Record<string, unknown> {
    const caps: Record<string, unknown> = {};
    if (opts.platform === "ios") {
      caps.platformName = "iOS";
      caps["appium:automationName"] = "XCUITest";
      if (opts.device) caps["appium:deviceName"] = opts.device;
      if (opts.bundle_id) caps["appium:bundleId"] = opts.bundle_id;
    } else {
      caps.platformName = "Android";
      caps["appium:automationName"] = "UiAutomator2";
      if (opts.emulator) caps["appium:avd"] = opts.emulator;
      if (opts.app_package) caps["appium:appPackage"] = opts.app_package;
      if (opts.app_activity) caps["appium:appActivity"] = opts.app_activity;
    }
    if (opts.locale) caps["appium:language"] = opts.locale;
    return caps;
  }

  private screenIdentifier(s: SessionInternals): string {
    const caps = s.session.driver.capabilities as Record<string, unknown>;
    return String(
      caps["appium:bundleId"] ??
        caps["appium:appPackage"] ??
        caps.platformName ??
        s.session.platform,
    );
  }

  private requireSession(sessionId: string): SessionInternals {
    const s = this.sessions.get(sessionId);
    if (!s) throw new UnknownSessionError(sessionId);
    return s;
  }

  private async resolveElement(s: SessionInternals, ref: string): Promise<WdioElement> {
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
    const selector = this.toSelector(meta);
    return s.session.driver.$(selector);
  }

  private toSelector(meta: MobileRefMeta): string {
    if (meta.kind === "ios") {
      if (meta.accessibilityId) return `~${meta.accessibilityId}`;
      // Global class-chain index — a class-chain query matches the nth element
      // of a type across the whole tree, not among siblings.
      const chain = `**/${meta.type}[${meta.globalTypeIndex}]`;
      return `-ios class chain:${chain}`;
    }
    if (meta.resourceId) {
      return `-android uiautomator:new UiSelector().resourceId("${escape(meta.resourceId)}")`;
    }
    if (meta.contentDesc) return `~${meta.contentDesc}`;
    if (meta.text) {
      return `-android uiautomator:new UiSelector().text("${escape(meta.text)}")`;
    }
    // UiSelector.instance(k) is a global 0-based index over all elements of the
    // class — use the global index, not the sibling-scoped one.
    return `-android uiautomator:new UiSelector().className("${meta.androidClass}").instance(${meta.globalClassIndex - 1})`;
  }

  private invalidateRefs(s: SessionInternals): void {
    s.snapshotGeneration += 1;
  }
}

const ANDROID_KEY_CODES: Record<string, number> = {
  Enter: 66,
  Tab: 61,
  Escape: 111,
  Back: 4,
  Home: 3,
  Menu: 82,
  Search: 84,
  Backspace: 67,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
};

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type TextNode = {
  name?: string;
  value?: string;
  state?: { visible?: boolean };
  children?: unknown[];
};

function treeIncludesText(node: TextNode, text: string): boolean {
  const target = text.toLowerCase();
  const visit = (n: TextNode): boolean => {
    // Skip an explicitly off-screen node for text_visible / ref_exists waits —
    // an invisible node's text must not satisfy the condition.
    if (
      n.state?.visible !== false &&
      ((n.name && n.name.toLowerCase().includes(target)) ||
        (n.value && n.value.toLowerCase().includes(target)))
    ) {
      return true;
    }
    if (!n.children) return false;
    for (const c of n.children as TextNode[]) {
      if (visit(c)) return true;
    }
    return false;
  };
  return visit(node);
}

// Helper so we don't accidentally export this typo'd internal name.
function _platformGuard(p: Platform): void {
  void p;
}
void _platformGuard;
