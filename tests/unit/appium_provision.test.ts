import { describe, expect, it } from "vitest";
import { countAdbDevices, countAvailableSimulators } from "../../src/cli/doctor.js";
import {
  androidHostProblem,
  assertSafeEndpoint,
  driverForPlatform,
  iosHostProblem,
  isAppiumConnectionError,
  isLoopbackHost,
  parseInstalledDrivers,
} from "../../src/engine/appiumProvision.js";

describe("isAppiumConnectionError — gates the auto-provision path", () => {
  it("detects ECONNREFUSED (no server on the port)", () => {
    const e = new Error("connect ECONNREFUSED 127.0.0.1:4723");
    expect(isAppiumConnectionError(e)).toBe(true);
  });

  it("detects webdriverio's friendly rewrite of a refused connection", () => {
    // Real wdio v9 message when no server listens — carries no errno and no cause.
    const e = new Error(
      'Unable to connect to "http://127.0.0.1:4723/", make sure browser driver is running on that address.\n' +
        "It seems like the service failed to start or is rejecting any connections.",
    );
    expect(isAppiumConnectionError(e)).toBe(true);
  });

  it("detects undici 'fetch failed' with a nested cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED ::1:4723"), {
      code: "ECONNREFUSED",
    });
    const e = new Error("fetch failed");
    (e as Error & { cause?: unknown }).cause = cause;
    expect(isAppiumConnectionError(e)).toBe(true);
  });

  it("does NOT fire for capability/device errors a live server reports", () => {
    expect(
      isAppiumConnectionError(
        new Error("Could not find a connected Android device in 20000ms"),
      ),
    ).toBe(false);
    expect(
      isAppiumConnectionError(new Error("invalid session id")),
    ).toBe(false);
    expect(isAppiumConnectionError("not an error")).toBe(false);
  });

  it("survives self-referential causes without looping", () => {
    const e = new Error("some opaque failure");
    (e as Error & { cause?: unknown }).cause = e;
    expect(isAppiumConnectionError(e)).toBe(false);
  });
});

describe("isLoopbackHost — remote hosts are never auto-provisioned", () => {
  it("accepts loopback forms", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLoopbackHost("appium.internal")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
  });
});

describe("parseInstalledDrivers — `appium driver list --installed --json`", () => {
  it("returns driver names from the keyed-object shape", () => {
    const out = JSON.stringify({
      uiautomator2: { version: "3.0.0", installed: true },
      xcuitest: { version: "7.0.0", installed: true },
    });
    expect(parseInstalledDrivers(out).sort()).toEqual(["uiautomator2", "xcuitest"]);
  });

  it("returns [] for empty object, arrays, and garbage", () => {
    expect(parseInstalledDrivers("{}")).toEqual([]);
    expect(parseInstalledDrivers("[1,2]")).toEqual([]);
    expect(parseInstalledDrivers("✔ Listing installed drivers")).toEqual([]);
  });
});

describe("assertSafeEndpoint — spawn args are validated before use", () => {
  it("accepts normal endpoints", () => {
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: 4723, basePath: "/" }),
    ).not.toThrow();
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: 4900, basePath: "/wd/hub" }),
    ).not.toThrow();
  });

  it("rejects shell metacharacters in APPIUM_BASE_PATH", () => {
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: 4723, basePath: "/; rm -rf ~" }),
    ).toThrow(/APPIUM_BASE_PATH/);
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: 4723, basePath: "no-leading-slash" }),
    ).toThrow(/APPIUM_BASE_PATH/);
  });

  it("rejects garbage ports (e.g. APPIUM_PORT=abc → NaN)", () => {
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: Number("abc"), basePath: "/" }),
    ).toThrow(/APPIUM_PORT/);
    expect(() =>
      assertSafeEndpoint({ host: "127.0.0.1", port: 70_000, basePath: "/" }),
    ).toThrow(/APPIUM_PORT/);
  });
});

describe("host preflight classifiers — missing Xcode / Android SDK fail fast with guidance", () => {
  it("iosHostProblem: non-mac host is rejected outright", () => {
    expect(iosHostProblem("linux", null)).toMatch(/macOS host/);
    expect(iosHostProblem("win32", null)).toMatch(/macOS host/);
  });

  it("iosHostProblem: Command Line Tools alone are not enough", () => {
    expect(iosHostProblem("darwin", "/Library/Developer/CommandLineTools\n")).toMatch(
      /Install Xcode/,
    );
    expect(iosHostProblem("darwin", null)).toMatch(/Install Xcode/);
  });

  it("iosHostProblem: full Xcode passes", () => {
    expect(iosHostProblem("darwin", "/Applications/Xcode.app/Contents/Developer\n")).toBeNull();
  });

  it("androidHostProblem: needs SDK dir or adb, either is enough", () => {
    expect(androidHostProblem({ sdkDirExists: false, adbOnPath: false })).toMatch(
      /ANDROID_HOME/,
    );
    expect(androidHostProblem({ sdkDirExists: true, adbOnPath: false })).toBeNull();
    expect(androidHostProblem({ sdkDirExists: false, adbOnPath: true })).toBeNull();
  });
});

describe("driverForPlatform", () => {
  it("maps platforms to appium drivers", () => {
    expect(driverForPlatform("ios")).toBe("xcuitest");
    expect(driverForPlatform("android")).toBe("uiautomator2");
  });
});

describe("doctor parsers", () => {
  it("countAvailableSimulators sums devices across runtimes", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "iPhone 16" }],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          { name: "iPhone 15" },
          { name: "iPad Air" },
        ],
      },
    });
    expect(countAvailableSimulators(json)).toBe(3);
    expect(countAvailableSimulators("nope")).toBe(0);
  });

  it("countAdbDevices counts only 'device' rows, not offline/unauthorized", () => {
    const out = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ZY22FJKPMD\tunauthorized",
      "192.168.1.5:5555\toffline",
      "",
    ].join("\n");
    expect(countAdbDevices(out)).toBe(1);
    expect(countAdbDevices("List of devices attached\n\n")).toBe(0);
  });
});
