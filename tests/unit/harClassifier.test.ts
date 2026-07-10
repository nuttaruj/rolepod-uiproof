import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET,
  compareToBudget,
  isThirdParty,
  registrableDomain,
  summarizeHar,
  type HarFile,
} from "../../src/engine/harClassifier.js";

describe("registrableDomain", () => {
  it("reduces sibling subdomains to the same registrable domain", () => {
    expect(registrableDomain("www.site.com")).toBe("site.com");
    expect(registrableDomain("cdn.site.com")).toBe("site.com");
    expect(registrableDomain("site.com")).toBe("site.com");
  });

  it("handles common two-level TLDs", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("static.bbc.co.uk")).toBe("bbc.co.uk");
  });
});

describe("isThirdParty — sibling subdomains", () => {
  it("treats www. page + cdn. asset as first-party (same eTLD+1)", () => {
    expect(
      isThirdParty({ request: { url: "https://cdn.site.com/a.js" } }, "www.site.com", undefined),
    ).toBe(false);
  });

  it("still flags a genuinely different domain", () => {
    expect(
      isThirdParty({ request: { url: "https://analytics.io/t.js" } }, "www.site.com", undefined),
    ).toBe(true);
  });
});

describe("compareToBudget — transfer size", () => {
  it("compares against transfer bytes, not decoded content.size", () => {
    // 400KB decoded but only 40KB over the wire (gzip) — under a 100KB budget.
    const har: HarFile = {
      log: {
        entries: [
          {
            request: { url: "https://site.com/app.js" },
            response: {
              content: { size: 400_000, mimeType: "application/javascript" },
              _transferSize: 40_000,
            },
          },
        ],
      },
    };
    const summary = summarizeHar(har, { pageUrl: "https://site.com/" });
    const report = compareToBudget(summary, { ...DEFAULT_BUDGET, js_kb: 100, total_kb: 100 });
    // decoded (400KB) would violate; transfer (40KB) does not
    expect(report.violations.map((v) => v.category)).not.toContain("js");
    expect(report.status).toBe("pass");
  });
});
