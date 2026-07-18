import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { RolepodMcpError } from "../util/errors.js";
import { log } from "../util/log.js";

/**
 * Auto-provisioning for the Appium server — the mobile analog of the
 * browser auto-install in `PlaywrightEngine.launchWithAutoInstall`.
 *
 * On the first `ios`/`android` session, if no Appium server is reachable
 * at the configured host/port, we:
 *   1. locate an existing `appium` (PATH → project → managed dir), or
 *      install one into `~/.rolepod-uiproof/appium` via npm,
 *   2. make sure the platform driver (xcuitest / uiautomator2) is
 *      installed,
 *   3. start the server as a child process and wait for `/status`.
 *
 * Xcode and the Android SDK cannot be auto-installed — those remain the
 * only manual prerequisites (surfaced by `doctor` / `install:mobile`).
 *
 * Opt out with `ROLEPOD_NO_AUTO_APPIUM=1`. Auto-start only ever targets
 * a loopback host — a remote `APPIUM_HOST` is never provisioned locally.
 */

export type AppiumCommand = {
  /** Executable to spawn (either `appium` from PATH or `node`). */
  exec: string;
  /** Leading args (the resolved appium entry script when exec is node). */
  args: string[];
  /** Extra env (APPIUM_HOME isolation for the managed install). */
  env: Record<string, string>;
  /** Where this command came from — used in logs and doctor output. */
  source: "path" | "project" | "managed";
  /**
   * Spawn through a shell. Required for `.cmd` shims on Windows — Node
   * (post CVE-2024-27980 fix) throws EINVAL for `.cmd`/`.bat` targets
   * spawned without `shell: true`. Every arg we pass alongside it is
   * validated to a safe charset (see `assertSafeBasePath`).
   */
  shell: boolean;
};

export type AppiumEndpoint = { host: string; port: number; basePath: string };

/** Managed install root — kept out of the user's project and npm prefix. */
export function managedAppiumRoot(): string {
  return join(homedir(), ".rolepod-uiproof", "appium");
}

/** APPIUM_HOME for the managed install, so user `~/.appium` setups are untouched. */
export function managedAppiumHome(): string {
  return join(managedAppiumRoot(), "appium-home");
}

export function autoAppiumDisabled(): boolean {
  return process.env.ROLEPOD_NO_AUTO_APPIUM === "1";
}

/** Only loopback hosts are eligible for local auto-start. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Does this error from `remote()` look like "no Appium server there" (as
 * opposed to a bad capability / missing device, which a local server
 * would report over HTTP)? Conservative on purpose: a false positive
 * costs one provisioning attempt + retry; a false negative keeps the
 * old manual-setup error.
 */
export function isAppiumConnectionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const msg =
      cur instanceof Error ? `${cur.message} ${String((cur as NodeJS.ErrnoException).code ?? "")}` : String(cur);
    // The last two patterns are webdriverio's friendly rewrite of a refused
    // connection — the final thrown error carries neither the errno nor a
    // `cause`, so we must match its wording too.
    if (
      /ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL|fetch failed|socket hang up|Failed to connect|Unable to connect to|failed to start or is rejecting/i.test(
        msg,
      )
    ) {
      return true;
    }
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}

export function driverForPlatform(platform: "ios" | "android"): "xcuitest" | "uiautomator2" {
  return platform === "ios" ? "xcuitest" : "uiautomator2";
}

// ---------------------------------------------------------------------------
// Host preflight — the ONE thing auto-provisioning can't fix is a missing
// Xcode / Android SDK. Without these checks a user without them gets a
// cryptic appium/wdio failure and no idea what to install; with them the
// session fails fast with the exact manual step. Pure classifiers below
// are unit-tested; the spawning wrapper stays thin.
// ---------------------------------------------------------------------------

/** Null when the host can run iOS simulators; otherwise the user-facing problem. */
export function iosHostProblem(os: string, xcodeSelectOut: string | null): string | null {
  if (os !== "darwin") {
    return "iOS sessions need a macOS host with Xcode — this machine cannot run an iOS simulator.";
  }
  if (!xcodeSelectOut || !/\.app\/Contents\/Developer\/?$/.test(xcodeSelectOut.trim())) {
    return (
      "iOS testing needs full Xcode — it is not installed (Command Line Tools alone cannot run simulators). " +
      "Install Xcode from the App Store, open it once to finish setup, then Xcode → Settings → Platforms → add an iOS Simulator runtime. " +
      "Verify with: xcrun simctl list devices"
    );
  }
  return null;
}

/** Null when Android tooling is reachable; otherwise the user-facing problem. */
export function androidHostProblem(opts: {
  sdkDirExists: boolean;
  adbOnPath: boolean;
}): string | null {
  if (opts.adbOnPath || opts.sdkDirExists) return null;
  return (
    "Android testing needs the Android SDK — it is not installed (no ANDROID_HOME and no adb on PATH). " +
    "Install Android Studio (or the command-line tools), set ANDROID_HOME to the SDK path, and start an emulator or connect a device. " +
    "Verify with: adb devices"
  );
}

/** SDK locations shared with `doctor` — env overrides first, then defaults. */
export function androidSdkCandidates(): string[] {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ].filter((x): x is string => typeof x === "string");
}

/**
 * Fail fast with actionable guidance when the host is missing the one
 * prerequisite we cannot install (Xcode / Android SDK). Only meaningful
 * for loopback endpoints — a remote Appium farm brings its own devices.
 * Checks are cheap (one short spawnSync + existsSync), so no caching:
 * installing the missing piece works on the next attempt without a
 * server restart.
 */
export function preflightMobileHost(platform: "ios" | "android"): void {
  let problem: string | null;
  if (platform === "ios") {
    const sel = spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000 });
    problem = iosHostProblem(
      osPlatform(),
      sel.status === 0 ? String(sel.stdout ?? "") : null,
    );
  } else {
    const adbExec = osPlatform() === "win32" ? "adb.exe" : "adb";
    const adb = spawnSync(adbExec, ["--version"], { encoding: "utf8", timeout: 10_000 });
    problem = androidHostProblem({
      sdkDirExists: androidSdkCandidates().some((p) => existsSync(p)),
      adbOnPath: adb.status === 0,
    });
  }
  if (problem) {
    throw new RolepodMcpError("engine_error", problem, { platform });
  }
}

/**
 * Parse `appium driver list --installed --json` output. Appium 2 prints
 * an object keyed by driver name. Anything unparseable → empty list (the
 * caller then just attempts an install, which is idempotent).
 */
export function parseInstalledDrivers(jsonText: string): string[] {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>);
    }
    return [];
  } catch {
    return [];
  }
}

/** GET /status with a short timeout — true iff an Appium-ish server answers. */
export async function isAppiumReachable(
  ep: AppiumEndpoint,
  timeoutMs = 1500,
): Promise<boolean> {
  const base = ep.basePath.endsWith("/") ? ep.basePath : `${ep.basePath}/`;
  const url = `http://${ep.host}:${ep.port}${base}status`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the appium entry script inside a package dir via its `bin` field. */
function appiumEntryFromPackageDir(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.appium ?? Object.values(pkg.bin ?? {})[0]);
    if (!bin) return null;
    const entry = resolvePath(pkgDir, bin);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Find a usable appium, preferring installs the user manages (their
 * drivers and plugins live there) over our managed fallback.
 */
export function resolveAppiumCommand(): AppiumCommand | null {
  // 1. PATH — user-managed global install. `.cmd` shims need shell: true.
  const pathExec = osPlatform() === "win32" ? "appium.cmd" : "appium";
  const pathShell = pathExec.endsWith(".cmd");
  const probe = spawnSync(pathExec, ["--version"], {
    timeout: 10_000,
    encoding: "utf8",
    shell: pathShell,
  });
  if (probe.status === 0) {
    return { exec: pathExec, args: [], env: {}, source: "path", shell: pathShell };
  }

  // 2. Project-local node_modules (someone added appium as a dep).
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    const pkgJson = require.resolve("appium/package.json");
    const entry = appiumEntryFromPackageDir(dirname(pkgJson));
    if (entry) {
      return { exec: process.execPath, args: [entry], env: {}, source: "project", shell: false };
    }
  } catch {
    // not installed in the project — fine
  }

  // 3. Managed install under ~/.rolepod-uiproof/appium.
  const managedPkgDir = join(managedAppiumRoot(), "node_modules", "appium");
  if (existsSync(managedPkgDir)) {
    const entry = appiumEntryFromPackageDir(managedPkgDir);
    if (entry) {
      return {
        exec: process.execPath,
        args: [entry],
        env: { APPIUM_HOME: managedAppiumHome() },
        source: "managed",
        shell: false,
      };
    }
  }
  return null;
}

/** npm-install appium into the managed root. Blocking, with visible progress. */
export function installManagedAppium(): AppiumCommand {
  const root = managedAppiumRoot();
  mkdirSync(root, { recursive: true });
  log.warn("appium not found — installing into managed dir (first run only)", { dir: root });
  const npmExec = osPlatform() === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(
    npmExec,
    ["install", "appium@^2", "--prefix", root, "--no-fund", "--no-audit"],
    { stdio: "inherit", timeout: 600_000, shell: npmExec.endsWith(".cmd") },
  );
  if (res.status !== 0) {
    throw new RolepodMcpError(
      "engine_error",
      `Auto-install of Appium failed (npm exit ${res.status ?? "signal"}). ` +
        `Install manually with \`npm install -g appium\` or run \`npx @rolepod/uiproof install:mobile\`.`,
      { dir: root },
    );
  }
  const cmd = resolveAppiumCommand();
  if (!cmd) {
    throw new RolepodMcpError(
      "engine_error",
      "Appium install completed but the appium entry script could not be resolved.",
      { dir: root },
    );
  }
  return cmd;
}

function runAppium(
  cmd: AppiumCommand,
  args: string[],
  timeoutMs: number,
): ReturnType<typeof spawnSync> {
  return spawnSync(cmd.exec, [...cmd.args, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...cmd.env },
    shell: cmd.shell,
  });
}

function listInstalledDrivers(cmd: AppiumCommand): string[] {
  const list = runAppium(cmd, ["driver", "list", "--installed", "--json"], 60_000);
  return parseInstalledDrivers(
    `${String(list.stdout ?? "")}\n${String(list.stderr ?? "")}`.trim().replace(/^[^{[]*/, ""),
  );
}

/**
 * Idempotently make sure the platform driver is installed for this appium.
 * Returns true iff the driver was newly installed (the caller may need to
 * restart a running daemon — appium loads drivers at server boot).
 */
export function ensureDriverInstalled(cmd: AppiumCommand, driver: string): boolean {
  if (listInstalledDrivers(cmd).includes(driver)) return false;

  log.warn("appium driver missing — installing", { driver });
  const res = runAppium(cmd, ["driver", "install", driver], 300_000);
  if (res.status !== 0) {
    const tail = String(res.stderr ?? "").slice(-400);
    // "already installed" from a list-parse miss is success, not failure.
    if (/already installed/i.test(tail)) return false;
    throw new RolepodMcpError(
      "engine_error",
      `Auto-install of the Appium ${driver} driver failed (exit ${res.status ?? "signal"}). ` +
        `Install manually: appium driver install ${driver}. Stderr tail: ${tail}`,
      { driver },
    );
  }
  return true;
}

type ManagedServer = { child: ChildProcess; endpoint: AppiumEndpoint; cmd: AppiumCommand };
let managedServer: ManagedServer | null = null;
let exitHookInstalled = false;

/**
 * The endpoint values end up as spawn args (and `basePath` may travel
 * through a shell on Windows) — allow only an obviously safe shape.
 */
export function assertSafeEndpoint(ep: AppiumEndpoint): void {
  if (!/^\/[A-Za-z0-9._/-]*$/.test(ep.basePath)) {
    throw new RolepodMcpError(
      "invalid_input",
      `APPIUM_BASE_PATH "${ep.basePath}" is not a safe path (must start with "/" and use only letters, digits, ".", "_", "-", "/").`,
      { base_path: ep.basePath },
    );
  }
  if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65_535) {
    throw new RolepodMcpError(
      "invalid_input",
      `APPIUM_PORT "${ep.port}" is not a valid TCP port.`,
      { port: ep.port },
    );
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    managedServer?.child.kill("SIGTERM");
  });
}

/** Stop the daemon we spawned (test hook + explicit shutdown). No-op otherwise. */
export function stopManagedAppium(): void {
  if (managedServer) {
    managedServer.child.kill("SIGTERM");
    managedServer = null;
  }
}

/**
 * Start `appium server` on the endpoint and wait until `/status` answers.
 * Keeps stderr in a small ring so a failed start has diagnostics.
 */
export async function startAppiumServer(
  cmd: AppiumCommand,
  ep: AppiumEndpoint,
  readyTimeoutMs = 60_000,
): Promise<void> {
  assertSafeEndpoint(ep);
  const args = [
    ...cmd.args,
    "server",
    "--address",
    ep.host,
    "--port",
    String(ep.port),
    "--base-path",
    ep.basePath,
  ];
  log.info("starting appium server", { source: cmd.source, port: ep.port });
  const child = spawn(cmd.exec, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...cmd.env },
    shell: cmd.shell,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1000);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await isAppiumReachable(ep, 1000)) {
      managedServer = { child, endpoint: ep, cmd };
      installExitHook();
      log.info("appium server ready", { port: ep.port });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  throw new RolepodMcpError(
    "engine_error",
    `Appium server did not become ready on ${ep.host}:${ep.port} within ${Math.round(readyTimeoutMs / 1000)}s.` +
      (stderrTail ? ` Stderr tail: ${stderrTail}` : ""),
    { port: ep.port },
  );
}

async function doEnsureAppiumUp(
  platform: "ios" | "android",
  ep: AppiumEndpoint,
): Promise<void> {
  preflightMobileHost(platform);
  const driver = driverForPlatform(platform);

  if (await isAppiumReachable(ep)) {
    // A server is already up. If it's one WE started and this platform's
    // driver landed after its boot (appium loads drivers at server start),
    // install the driver and bounce the daemon. A user-managed server is
    // never touched.
    if (managedServer && ensureDriverInstalled(managedServer.cmd, driver)) {
      const cmd = managedServer.cmd;
      stopManagedAppium();
      await startAppiumServer(cmd, ep);
    }
    return;
  }

  let cmd = resolveAppiumCommand();
  if (!cmd) cmd = installManagedAppium();
  ensureDriverInstalled(cmd, driver);
  await startAppiumServer(cmd, ep);
}

/**
 * Full provisioning pipeline used by AppiumEngine after a connection
 * failure: reuse a live server if one appeared, otherwise locate/install
 * appium, ensure the platform driver, and start the daemon.
 *
 * Calls are SERIALIZED through a module-level chain — two sessions opened
 * concurrently (e.g. ios + android in one turn) must not both spawn a
 * daemon on the same port; the second waits and then sees the first's
 * server as reachable.
 */
let provisionChain: Promise<void> = Promise.resolve();
export function ensureAppiumUp(
  platform: "ios" | "android",
  ep: AppiumEndpoint,
): Promise<void> {
  const run = provisionChain.then(() => doEnsureAppiumUp(platform, ep));
  // Keep the chain alive after a failure — the next caller still runs.
  provisionChain = run.catch(() => undefined);
  return run;
}
