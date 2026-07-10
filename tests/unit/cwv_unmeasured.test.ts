import { describe, expect, it } from "vitest";
import {
  DEFAULT_CWV_THRESHOLDS,
  classifyMetric,
  computeOverallVerdict,
} from "../../src/engine/cwv.js";

/**
 * A real LCP paint is always > 0ms. lcp === 0 means the observer never fired
 * (instant cache load, background tab, page that never painted) — reporting
 * "good" there is a false pass. It must classify as unmeasured, and an
 * unmeasured LCP must keep the overall verdict off "pass".
 */
const t = DEFAULT_CWV_THRESHOLDS;

describe("CWV — unmeasured LCP is not a pass", () => {
  it("classifies lcp <= 0 as unmeasured, not good", () => {
    expect(classifyMetric("lcp", 0, t)).toBe("unmeasured");
    expect(classifyMetric("lcp", -1, t)).toBe("unmeasured");
    // a real small LCP is still good
    expect(classifyMetric("lcp", 1, t)).toBe("good");
  });

  it("CLS 0 stays good (0 shift is a real, valid value)", () => {
    expect(classifyMetric("cls", 0, t)).toBe("good");
  });

  it("overall verdict is warn (not pass) when LCP is unmeasured", () => {
    expect(
      computeOverallVerdict({ lcp: "unmeasured", inp: "unmeasured", cls: "good" }),
    ).toBe("warn");
  });

  it("overall stays pass when LCP is measured-good and only INP is unmeasured", () => {
    expect(
      computeOverallVerdict({ lcp: "good", inp: "unmeasured", cls: "good" }),
    ).toBe("pass");
  });
});
