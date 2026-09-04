import { describe, expect, it } from "vitest";
import { resolveHeadless } from "../../src/engine/PlaywrightEngine.js";

/**
 * Headless is the safe default so display-less hosts (CI, servers,
 * containers) can launch. Headed is opt-in via ROLEPOD_HEADED=1.
 */
describe("resolveHeadless", () => {
  it("defaults to headless with no env flag", () => {
    expect(resolveHeadless({})).toBe(true);
  });

  it("stays headless in CI", () => {
    expect(resolveHeadless({ CI: "true" })).toBe(true);
  });

  it("is headed only when ROLEPOD_HEADED=1", () => {
    expect(resolveHeadless({ ROLEPOD_HEADED: "1" })).toBe(false);
  });

  it("ignores other ROLEPOD_HEADED values", () => {
    expect(resolveHeadless({ ROLEPOD_HEADED: "0" })).toBe(true);
    expect(resolveHeadless({ ROLEPOD_HEADED: "true" })).toBe(true);
  });
});

/**
 * Headless Chromium's `HeadlessChrome/` token gets 403'd by edge rules on
 * real hosts (wp-admin POST on a Plesk/nginx box, 2026-09-04). The default
 * session must present the headed UA — same string, marker stripped — and
 * leave browsers without the marker alone.
 */
describe("withoutHeadlessMarker", async () => {
  const { withoutHeadlessMarker } = await import("../../src/engine/PlaywrightEngine.js");

  it("strips the headless marker and keeps the version", () => {
    expect(
      withoutHeadlessMarker(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    );
  });

  it("returns null when there is no marker to strip (headed, firefox, webkit)", () => {
    expect(
      withoutHeadlessMarker(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBeNull();
    expect(
      withoutHeadlessMarker("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"),
    ).toBeNull();
  });
});
