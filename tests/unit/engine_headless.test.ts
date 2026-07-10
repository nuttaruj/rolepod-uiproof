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
