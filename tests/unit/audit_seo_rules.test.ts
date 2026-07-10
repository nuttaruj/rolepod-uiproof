import { describe, expect, it } from "vitest";
import { runSeoRules, type SeoSnapshot } from "../../src/tools/composite/audit_seo.js";

function snap(overrides: Partial<SeoSnapshot>): SeoSnapshot {
  return {
    title: "A good enough title",
    meta_description: "A meta description that is comfortably within the fifty to one hundred sixty range.",
    h1_texts: ["Heading"],
    html_lang: "en",
    viewport: "width=device-width, initial-scale=1",
    canonical: "https://site.com/",
    robots: null,
    og_tags: { "og:title": "t", "og:image": "i" },
    twitter_tags: { "twitter:card": "summary" },
    json_ld: [],
    hreflang: [],
    favicon: "/favicon.ico",
    ...overrides,
  };
}

const all = new Set([
  "title", "meta_description", "h1", "lang", "viewport", "canonical",
  "robots", "og_tags", "twitter_tags", "json_ld", "hreflang", "favicon",
]);

describe("audit_seo robots rule", () => {
  it("flags robots 'none' as blocking indexing", () => {
    const findings = runSeoRules(snap({ robots: "none" }), all);
    expect(findings.some((f) => f.check === "robots")).toBe(true);
  });

  it("flags robots 'noindex'", () => {
    const findings = runSeoRules(snap({ robots: "noindex, follow" }), all);
    expect(findings.some((f) => f.check === "robots")).toBe(true);
  });

  it("does not flag robots 'index, follow'", () => {
    const findings = runSeoRules(snap({ robots: "index, follow" }), all);
    expect(findings.some((f) => f.check === "robots")).toBe(false);
  });
});

describe("audit_seo JSON-LD @type rule", () => {
  it("accepts a @graph document with per-node @type (no false 'missing @type')", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "x" },
        { "@type": "Organization", name: "y" },
      ],
    };
    const findings = runSeoRules(
      snap({ json_ld: [{ raw: "{}", parsed: graph }] }),
      all,
    );
    expect(findings.some((f) => f.check === "json_ld")).toBe(false);
  });

  it("accepts a top-level array of typed nodes", () => {
    const arr = [{ "@type": "Product", name: "p" }];
    const findings = runSeoRules(snap({ json_ld: [{ raw: "[]", parsed: arr }] }), all);
    expect(findings.some((f) => f.check === "json_ld")).toBe(false);
  });

  it("flags a document where no node carries @type", () => {
    const graph = { "@graph": [{ name: "no type here" }] };
    const findings = runSeoRules(snap({ json_ld: [{ raw: "{}", parsed: graph }] }), all);
    expect(findings.some((f) => f.check === "json_ld")).toBe(true);
  });
});
