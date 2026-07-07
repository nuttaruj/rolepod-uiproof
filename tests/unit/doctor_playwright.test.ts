import { describe, expect, it } from "vitest";
import { classifyPlaywrightExe } from "../../src/cli/doctor.js";

/**
 * The Chromium check must ask Playwright for the real executable path rather
 * than guessing cache dirs (false OK / false FAIL across platforms).
 */
describe("classifyPlaywrightExe", () => {
  it("ok when the executable resolves and exists", () => {
    const c = classifyPlaywrightExe(
      "/browsers/chromium-1200/chrome-linux/headless_shell",
      null,
      () => true,
    );
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("/browsers/chromium-1200");
  });

  it("fail when the path resolves but the binary is missing", () => {
    const c = classifyPlaywrightExe(
      "/browsers/chromium-1200/chrome-linux/headless_shell",
      null,
      () => false,
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/playwright install/);
  });

  it("fail when no path resolves", () => {
    const c = classifyPlaywrightExe(null, null, () => false);
    expect(c.status).toBe("fail");
  });

  it("warn when executablePath throws (bundled-mode edge)", () => {
    const c = classifyPlaywrightExe(null, new Error("no browser"), () => false);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/Could not resolve/);
  });
});
