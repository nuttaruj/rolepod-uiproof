import type { A11yNode } from "../schema/tools.js";

/**
 * The single seam between rolepod-uiproof's tool layer and any
 * browser/mobile automation backend.
 *
 * Implementations: PlaywrightEngine (web), AppiumEngine (iOS + Android),
 * optional SeleniumEngine (legacy grid, not yet implemented).
 */

export type Platform = "web" | "ios" | "android";
export type Direction = "up" | "down" | "left" | "right";

/**
 * Capture-time options. `freezeMotion` maps to Playwright's native
 * `animations: "disabled"` + `caret: "hide"` so finite animations/
 * transitions fast-forward to their end state and infinite ones cancel —
 * a deterministic capture without hand-injected CSS. Ignored on mobile.
 */
export type ScreenshotOptions = {
  freezeMotion?: boolean;
};

export type WaitCondition =
  | { kind: "text_visible"; text: string }
  | { kind: "ref_exists"; query: string }
  | { kind: "url_matches"; pattern: string }
  | { kind: "idle"; ms: number };

export type OpenOptions = {
  platform: Platform;
  url?: string;
  browser?: "chromium" | "firefox" | "webkit";
  viewport?: { width: number; height: number };
  headless?: boolean;
  user_agent?: string;
  locale?: string;
  /**
   * Absolute path to a Playwright storageState JSON (cookies + localStorage).
   * Lets a caller inject an already-authenticated session instead of
   * navigating a login / one-time-link URL every time. Web-only.
   */
  storage_state?: string;
  // mobile forward-compat fields — ignored by web engines
  bundle_id?: string;
  device?: string;
  app_package?: string;
  app_activity?: string;
  emulator?: string;
  /**
   * v0.5 capture lifecycle. Pass when the session needs HAR/video/trace
   * recording. These MUST be requested at open time because Playwright
   * wires recordHar/recordVideo at context creation.
   */
  capture?: {
    har?: { path: string };
    video?: { dir: string; sizeWidth?: number; sizeHeight?: number };
    trace?: { artifactDir: string };
  };
};

export type FillFieldKind = "input" | "select" | "checkbox" | "radio";
export type FillField = {
  ref: string;
  value: string | boolean;
  kind?: FillFieldKind;
};

/** Opaque session handle returned by `Engine.open`. */
export interface Session {
  readonly id: string;
  readonly platform: Platform;
}

export type A11ySnapshot = {
  session_id: string;
  platform: Platform;
  url_or_screen: string;
  taken_at: string;
  tree: A11yNode;
  /** Screenshot buffer captured alongside the snapshot, if requested. */
  screenshot?: Buffer;
};

export interface Engine {
  readonly id: "playwright" | "appium" | "selenium";

  open(opts: OpenOptions): Promise<Session>;
  close(session: Session): Promise<void>;

  snapshot(session: Session, mode?: "visible" | "full"): Promise<A11ySnapshot>;

  click(
    session: Session,
    ref: string,
    opts?: { button?: "left" | "right" | "middle" },
  ): Promise<void>;
  type(
    session: Session,
    ref: string,
    text: string,
    opts?: { clearFirst?: boolean },
  ): Promise<void>;
  key(session: Session, key: string): Promise<void>;
  scroll(
    session: Session,
    dir: Direction,
    amount?: number,
    ref?: string,
  ): Promise<void>;
  waitFor(
    session: Session,
    cond: WaitCondition,
    timeoutMs?: number,
  ): Promise<void>;
  screenshot(
    session: Session,
    fullPage?: boolean,
    opts?: ScreenshotOptions,
  ): Promise<Buffer>;
  /** Web-only. Throws `unsupported_platform` on mobile sessions. */
  navigate(session: Session, url: string): Promise<void>;

  // ---------------- v0.5 cross-platform input additions ----------------

  /** Move pointer / hover over the element identified by `ref`. */
  hover(session: Session, ref: string): Promise<void>;
  /** Drag element `from` onto element `to`. */
  drag(session: Session, fromRef: string, toRef: string): Promise<void>;
  /**
   * Batch-fill multiple form fields in a single call. Token-efficient
   * alternative to a sequence of `type` calls; also handles checkboxes,
   * radios, and `<select>` options.
   */
  fillForm(session: Session, fields: FillField[]): Promise<void>;
  /**
   * Attach a local file to the file input identified by `ref`.
   * Path MUST be absolute on the host filesystem.
   */
  uploadFile(session: Session, ref: string, filePath: string): Promise<void>;
}
