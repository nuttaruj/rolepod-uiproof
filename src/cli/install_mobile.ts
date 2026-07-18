import { platform as osPlatform } from "node:os";
import {
  ensureDriverInstalled,
  installManagedAppium,
  isAppiumReachable,
  managedAppiumRoot,
  resolveAppiumCommand,
} from "../engine/appiumProvision.js";

/**
 * `rolepod-uiproof install:mobile` — actually provision the mobile stack
 * (Appium server + platform drivers), not just print a checklist. The
 * pieces that cannot be automated (Xcode, Android SDK) are printed as
 * remaining manual steps at the end.
 *
 * `install:mobile --checklist` prints the manual checklist only, without
 * installing anything.
 */
export async function runInstallMobile(args: string[] = []): Promise<number> {
  if (args.includes("--checklist")) {
    printChecklist();
    return 0;
  }

  const out = (l: string) => process.stdout.write(l + "\n");
  const os = osPlatform();
  out("rolepod-uiproof install:mobile — provisioning the mobile stack\n");

  // 1. Appium server package
  let cmd = resolveAppiumCommand();
  if (cmd) {
    out(`  ✓ appium found (${cmd.source})`);
  } else {
    out(`  … appium not found — installing into ${managedAppiumRoot()} (one-time, ~1-2 min)`);
    try {
      cmd = installManagedAppium();
      out("  ✓ appium installed");
    } catch (err) {
      out(`  ✗ appium install failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // 2. Platform drivers — uiautomator2 everywhere, xcuitest only on macOS.
  const drivers = os === "darwin" ? ["uiautomator2", "xcuitest"] : ["uiautomator2"];
  for (const driver of drivers) {
    try {
      ensureDriverInstalled(cmd, driver);
      out(`  ✓ driver ${driver} ready`);
    } catch (err) {
      out(`  ✗ driver ${driver} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (os !== "darwin") {
    out("  • xcuitest skipped — iOS needs a macOS host.");
  }

  // 3. Server status — informational; sessions auto-start the daemon on demand.
  const host = process.env.APPIUM_HOST ?? "127.0.0.1";
  const port = Number(process.env.APPIUM_PORT ?? 4723);
  const basePath = process.env.APPIUM_BASE_PATH ?? "/";
  const up = await isAppiumReachable({ host, port, basePath });
  out(
    up
      ? `  ✓ appium server already running at ${host}:${port}`
      : `  • appium server not running — it will be auto-started on the first mobile session.`,
  );

  out("\nRemaining manual steps (cannot be automated):");
  if (os === "darwin") {
    out("  iOS:     Xcode + an iOS Simulator (Xcode → Settings → Platforms).");
    out("           Verify with: xcrun simctl list devices");
  } else {
    out("  iOS:     not available on this OS (macOS host required).");
  }
  out("  Android: Android Studio or command-line tools; set ANDROID_HOME.");
  out("           Verify with: adb devices");
  out("\nThen check everything: npx @rolepod/uiproof doctor");
  return 0;
}

function printChecklist(): void {
  const os = osPlatform();
  const lines: string[] = [];

  lines.push("rolepod-uiproof install:mobile --checklist — manual setup steps\n");
  lines.push("Mobile support is OPTIONAL. Skip if you only target the web.");
  lines.push("Running `install:mobile` without --checklist does steps 1-2 for you.\n");

  lines.push("1. Install the Appium server (2.x):");
  lines.push("     npm install -g appium");
  lines.push("     appium driver install xcuitest      # iOS");
  lines.push("     appium driver install uiautomator2  # Android");
  lines.push("     appium                              # or let uiproof auto-start it\n");

  if (os === "darwin") {
    lines.push("2. iOS — macOS host required:");
    lines.push("     • Install Xcode + Command Line Tools");
    lines.push("     • Open Xcode → Settings → Platforms → install an iOS Simulator");
    lines.push("     • `xcrun simctl list devices` confirms a device is available\n");
  } else {
    lines.push("2. iOS: not supported on this OS (macOS host required).\n");
  }

  lines.push("3. Android — any host:");
  lines.push("     • Install Android Studio OR command-line tools");
  lines.push("     • Set ANDROID_HOME to the SDK location");
  lines.push("     • `adb devices` confirms an emulator or device is reachable\n");

  lines.push("4. Verify:");
  lines.push("     npx @rolepod/uiproof doctor\n");

  lines.push("Environment overrides (optional):");
  lines.push("     APPIUM_HOST             default: 127.0.0.1");
  lines.push("     APPIUM_PORT             default: 4723");
  lines.push("     APPIUM_BASE_PATH        default: /");
  lines.push("     ROLEPOD_NO_AUTO_APPIUM  set to 1 to disable auto-provisioning");

  for (const l of lines) process.stdout.write(l + "\n");
}
