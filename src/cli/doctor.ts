import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, platform as osPlatform } from "node:os";
import { chromium } from "playwright";

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

  // Appium server reachable
  checks.push(await checkAppiumServer());

  // Xcode (macOS only, for iOS testing — roadmap v0.3)
  if (osPlatform() === "darwin") {
    checks.push(checkXcode());
  }

  // Android SDK (roadmap v0.3)
  checks.push(checkAndroidSdk());

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
      name: "webdriverio (mobile client, v0.3)",
      status: "ok",
      detail: url ?? "resolved",
    };
  } catch {
    return {
      name: "webdriverio (mobile client, v0.3)",
      status: "warn",
      detail:
        "Not installed — web works fine without it. Mobile is roadmap v0.3. For mobile: npm i webdriverio",
    };
  }
}

async function checkAppiumServer(): Promise<Check> {
  const host = process.env.APPIUM_HOST ?? "127.0.0.1";
  const port = Number(process.env.APPIUM_PORT ?? 4723);
  const path = process.env.APPIUM_BASE_PATH ?? "/";
  const url = `http://${host}:${port}${path.endsWith("/") ? path : path + "/"}status`;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    return {
      name: "Appium server (roadmap v0.3)",
      status: res.ok ? "ok" : "warn",
      detail: `${url} → HTTP ${res.status}`,
    };
  } catch {
    return {
      name: "Appium server (roadmap v0.3)",
      status: "warn",
      detail: `Not reachable at ${url} — mobile sessions need a running Appium daemon. Web sessions are unaffected.`,
    };
  }
}

function checkXcode(): Check {
  const path = "/Applications/Xcode.app";
  if (existsSync(path)) {
    return { name: "Xcode (iOS, roadmap v0.3)", status: "ok", detail: path };
  }
  return {
    name: "Xcode (iOS, roadmap v0.3)",
    status: "warn",
    detail:
      "Install Xcode via the App Store; required for iOS simulators. Not needed for web targets.",
  };
}

function checkAndroidSdk(): Check {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ].filter((x): x is string => typeof x === "string");
  for (const path of candidates) {
    if (existsSync(path)) {
      return { name: "Android SDK (roadmap v0.3)", status: "ok", detail: path };
    }
  }
  return {
    name: "Android SDK (roadmap v0.3)",
    status: "warn",
    detail:
      "Set ANDROID_HOME — needed only for Android testing. Not needed for web or iOS targets.",
  };
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
