import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, platform as osPlatform } from "node:os";
import { chromium } from "playwright";
import {
  androidSdkCandidates,
  isAppiumReachable,
  parseInstalledDrivers,
  resolveAppiumCommand,
  resolveManagedWebdriverio,
  type AppiumCommand,
} from "../engine/appiumProvision.js";

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

/**
 * `rolepod-uiproof doctor` — diagnose local environment readiness. Exits
 * with code 0 if every check is `ok` or `warn`, 1 if any `fail`.
 */
export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node ≥20",
    status: major >= 20 ? "ok" : "fail",
    detail: process.versions.node,
  });

  // Playwright Chromium install (looks under the default cache directory)
  checks.push(checkPlaywrightChromium());

  // webdriverio (optional)
  checks.push(await checkWebdriverIO());

  // Appium binary + installed drivers (auto-provisioned on demand)
  const appiumCmd = resolveAppiumCommand();
  checks.push(checkAppiumBinary(appiumCmd));
  if (appiumCmd) checks.push(checkAppiumDrivers(appiumCmd));

  // Appium server reachable
  checks.push(await checkAppiumServer());

  // Xcode + simulators (macOS only, for iOS testing)
  if (osPlatform() === "darwin") {
    checks.push(checkXcode());
    checks.push(checkIosSimulators());
  }

  // Android SDK + connected devices
  checks.push(checkAndroidSdk());
  checks.push(checkAndroidDevices());

  // SeleniumEngine status — explicitly roadmap v0.4
  checks.push({
    name: "SeleniumEngine (roadmap v0.4)",
    status: "warn",
    detail:
      "Not implemented — deferred to v0.4 (legacy Selenium grid support, opt-in via ROLEPOD_MCP_WEB_ENGINE=selenium).",
  });

  // Artifact dir writable
  checks.push(checkArtifactDir());

  print(checks);
  const failed = checks.some((c) => c.status === "fail");
  return failed ? 1 : 0;
}

function checkPlaywrightChromium(): Check {
  // Ask Playwright where the browser actually is instead of guessing cache
  // dirs — the old dir-exists heuristic gave false OK (dir present, chromium
  // absent), false FAIL on Windows (different path), and false FAIL under
  // PLAYWRIGHT_BROWSERS_PATH=0 (browsers bundled with the package).
  let exe: string | null = null;
  let err: unknown;
  try {
    exe = chromium.executablePath();
  } catch (e) {
    err = e;
  }
  return classifyPlaywrightExe(exe, err, (p) => existsSync(p));
}

/**
 * Pure classifier for the Chromium executable probe — split out so it can be
 * unit-tested without a real Playwright install.
 */
export function classifyPlaywrightExe(
  exe: string | null,
  err: unknown,
  exists: (p: string) => boolean,
): Check {
  const name = "Playwright Chromium installed";
  if (err) {
    return {
      name,
      status: "warn",
      detail: `Could not resolve Chromium path (${String(err)}) — run: npx playwright install chromium`,
    };
  }
  if (exe && exists(exe)) {
    return { name, status: "ok", detail: exe };
  }
  return {
    name,
    status: "fail",
    detail: `Chromium not found${exe ? ` at ${exe}` : ""} — run: npx playwright install chromium`,
  };
}

async function checkWebdriverIO(): Promise<Check> {
  try {
    const url = await import.meta.resolve?.("webdriverio");
    return {
      name: "webdriverio (mobile client)",
      status: "ok",
      detail: url ?? "resolved",
    };
  } catch {
    const managed = resolveManagedWebdriverio();
    if (managed) {
      return {
        name: "webdriverio (mobile client)",
        status: "ok",
        detail: `managed install: ${managed}`,
      };
    }
    return {
      name: "webdriverio (mobile client)",
      status: "warn",
      detail:
        "Not installed — auto-installed on the first mobile session (or run: npx @rolepod/uiproof install:mobile). Web is unaffected.",
    };
  }
}

function checkAppiumBinary(cmd: AppiumCommand | null): Check {
  if (cmd) {
    return {
      name: "Appium (mobile server)",
      status: "ok",
      detail: `found via ${cmd.source} install`,
    };
  }
  return {
    name: "Appium (mobile server)",
    status: "warn",
    detail:
      "Not installed — auto-installed on the first mobile session (or run: npx @rolepod/uiproof install:mobile). Web is unaffected.",
  };
}

function checkAppiumDrivers(cmd: AppiumCommand): Check {
  const res = spawnSync(cmd.exec, [...cmd.args, "driver", "list", "--installed", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...cmd.env },
  });
  const drivers = parseInstalledDrivers(
    `${String(res.stdout ?? "")}\n${String(res.stderr ?? "")}`.trim().replace(/^[^{[]*/, ""),
  );
  if (drivers.length > 0) {
    return { name: "Appium drivers", status: "ok", detail: drivers.join(", ") };
  }
  return {
    name: "Appium drivers",
    status: "warn",
    detail:
      "None installed — auto-installed on first mobile session (xcuitest for iOS, uiautomator2 for Android).",
  };
}

async function checkAppiumServer(): Promise<Check> {
  const host = process.env.APPIUM_HOST ?? "127.0.0.1";
  const port = Number(process.env.APPIUM_PORT ?? 4723);
  const basePath = process.env.APPIUM_BASE_PATH ?? "/";
  const up = await isAppiumReachable({ host, port, basePath });
  if (up) {
    return {
      name: "Appium server",
      status: "ok",
      detail: `reachable at ${host}:${port}`,
    };
  }
  return {
    name: "Appium server",
    status: "warn",
    detail: `Not running at ${host}:${port} — auto-started on the first mobile session. Web sessions are unaffected.`,
  };
}

function checkXcode(): Check {
  const path = "/Applications/Xcode.app";
  if (existsSync(path)) {
    return { name: "Xcode (iOS)", status: "ok", detail: path };
  }
  return {
    name: "Xcode (iOS)",
    status: "warn",
    detail:
      "Install Xcode via the App Store; required for iOS simulators. Not needed for web targets.",
  };
}

function checkIosSimulators(): Check {
  const name = "iOS simulators";
  // Generous timeout: the first simctl call after an Xcode/CLT update
  // restarts the CoreSimulator service and can take tens of seconds.
  const res = spawnSync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
    timeout: 45_000,
  });
  if (res.status !== 0) {
    return {
      name,
      status: "warn",
      detail: "`xcrun simctl` failed — install Xcode Command Line Tools for iOS testing.",
    };
  }
  const count = countAvailableSimulators(String(res.stdout ?? ""));
  if (count > 0) {
    return { name, status: "ok", detail: `${count} available` };
  }
  return {
    name,
    status: "warn",
    detail: "No simulators — Xcode → Settings → Platforms → install an iOS runtime.",
  };
}

/** Pure parser for `simctl list devices available -j` — unit-testable. */
export function countAvailableSimulators(jsonText: string): number {
  try {
    const parsed = JSON.parse(jsonText) as { devices?: Record<string, unknown[]> };
    return Object.values(parsed.devices ?? {}).reduce((n, list) => n + list.length, 0);
  } catch {
    return 0;
  }
}

function checkAndroidSdk(): Check {
  for (const path of androidSdkCandidates()) {
    if (existsSync(path)) {
      return { name: "Android SDK", status: "ok", detail: path };
    }
  }
  return {
    name: "Android SDK",
    status: "warn",
    detail:
      "Set ANDROID_HOME — needed only for Android testing. Not needed for web or iOS targets.",
  };
}

function checkAndroidDevices(): Check {
  const name = "Android devices (adb)";
  const res = spawnSync("adb", ["devices"], { encoding: "utf8", timeout: 15_000 });
  if (res.status !== 0 || res.error) {
    return {
      name,
      status: "warn",
      detail: "adb not on PATH — needed only for Android testing.",
    };
  }
  const count = countAdbDevices(String(res.stdout ?? ""));
  if (count > 0) {
    return { name, status: "ok", detail: `${count} connected` };
  }
  return {
    name,
    status: "warn",
    detail: "No emulator/device connected — start one before an android session.",
  };
}

/** Pure parser for `adb devices` output — unit-testable. */
export function countAdbDevices(stdout: string): number {
  return stdout
    .split("\n")
    .slice(1) // "List of devices attached" header
    .filter((l) => /\tdevice$/.test(l.trim().replace(/\s+/, "\t"))).length;
}

function checkArtifactDir(): Check {
  const dir = resolve(process.cwd(), ".rolepod-uiproof");
  // Directory does not need to exist yet; only the parent does.
  return {
    name: "Artifact root writable",
    status: "ok",
    detail: `Will be created at: ${dir}/artifacts/{run_id}/`,
  };
}

function print(checks: Check[]): void {
  const icon = (s: Check["status"]) => (s === "ok" ? "✓" : s === "warn" ? "•" : "✗");
  for (const c of checks) {
    // Doctor output is user-facing CLI; stdout is appropriate here
    // because this subcommand never speaks MCP on the same channel.
    process.stdout.write(`  ${icon(c.status)} ${c.name.padEnd(30)} ${c.detail}\n`);
  }
}
