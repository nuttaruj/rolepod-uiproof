import { describe, expect, it } from "vitest";
import { parseAriaSnapshot } from "../../src/engine/a11y/normalize.js";
import {
  classifyActionTimeout,
  isMissingBrowserError,
} from "../../src/engine/PlaywrightEngine.js";

describe("parseAriaSnapshot — malformed input is not a silent empty success", () => {
  it("throws on malformed YAML", () => {
    expect(() => parseAriaSnapshot("- foo: [unclosed")).toThrow();
  });

  it("returns a tree gracefully for empty input", () => {
    const r = parseAriaSnapshot("");
    expect(r.tree).toBeDefined();
  });
});

describe("classifyActionTimeout — actionability error classification", () => {
  it("maps a Playwright TimeoutError to a classified engine_error", () => {
    const e = new Error("locator.click: Timeout 30000ms exceeded\nwaiting for element");
    e.name = "TimeoutError";
    const c = classifyActionTimeout("click", e);
    expect(c).not.toBeNull();
    expect(c!.code).toBe("engine_error");
    expect(c!.message).toMatch(/not actionable/i);
    expect(c!.detail).toEqual({ action: "click" });
  });

  it("returns null for any non-timeout error (rethrown as-is)", () => {
    expect(classifyActionTimeout("click", new Error("boom"))).toBeNull();
    expect(classifyActionTimeout("click", "not even an error")).toBeNull();
  });
});

describe("isMissingBrowserError — triggers auto-install", () => {
  it("detects the 'Executable doesn't exist' launch failure", () => {
    const e = new Error(
      "browserType.launch: Executable doesn't exist at /…/chrome-headless-shell\nPlease run the following command to download new browsers:\n  npx playwright install",
    );
    expect(isMissingBrowserError(e)).toBe(true);
  });

  it("does not mistake an ordinary launch error for a missing browser", () => {
    expect(isMissingBrowserError(new Error("Target page crashed"))).toBe(false);
    expect(isMissingBrowserError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
  });
});
