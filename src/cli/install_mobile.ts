import { platform as osPlatform } from "node:os";

export function runInstallMobile(): number {
  const os = osPlatform();
  const lines: string[] = [];

  lines.push("rolepod-uiproof install:mobile — setup checklist\n");
  lines.push("Mobile support is OPTIONAL. Skip if you only target the web.\n");

  lines.push("1. Install the Node client:");
  lines.push("     npm install webdriverio\n");

  lines.push("2. Install the Appium server (2.x):");
  lines.push("     npm install -g appium");
  lines.push("     appium driver install xcuitest      # iOS");
  lines.push("     appium driver install uiautomator2  # Android");
  lines.push("     appium                              # leave running\n");

  if (os === "darwin") {
    lines.push("3. iOS — macOS host required:");
    lines.push("     • Install Xcode + Command Line Tools");
    lines.push("     • Open Xcode → Settings → Platforms → install an iOS Simulator");
    lines.push("     • `xcrun simctl list devices` confirms a device is available\n");
  } else {
    lines.push("3. iOS: not supported on this OS (macOS host required).\n");
  }

  lines.push("4. Android — any host:");
  lines.push("     • Install Android Studio OR command-line tools");
  lines.push("     • Set ANDROID_HOME to the SDK location");
  lines.push("     • `adb devices` confirms an emulator or device is reachable\n");

  lines.push("5. Verify:");
  lines.push("     npx @rolepod/uiproof doctor\n");

  lines.push("Environment overrides (optional):");
  lines.push("     APPIUM_HOST       default: 127.0.0.1");
  lines.push("     APPIUM_PORT       default: 4723");
  lines.push("     APPIUM_BASE_PATH  default: /");

  for (const l of lines) process.stdout.write(l + "\n");
  return 0;
}
