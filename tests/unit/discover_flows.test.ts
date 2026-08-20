import { describe, expect, it } from "vitest";
import {
  buildGetSubmitUrl,
  buildTestCases,
  classifyDestructive,
  deriveFlows,
  isCrawlable,
  isDestructiveUrl,
  normalizeUrl,
  renderFlowMapMarkdown,
  type CrawledPage,
  type DiscoveredForm,
} from "../../src/tools/composite/discover_flows.js";
import {
  discoverFlowsSchema,
  verifyExpectSchema,
  verifyStepSchema,
} from "../../src/schema/tools.js";
import { z } from "zod";

const START = "https://app.example.com/";

function page(overrides: Partial<CrawledPage>): CrawledPage {
  return {
    url: START,
    title: "Home",
    depth: 0,
    links: [],
    forms: [],
    buttons: [],
    elements_truncated: false,
    ...overrides,
  };
}

function form(overrides: Partial<DiscoveredForm>): DiscoveredForm {
  return {
    action: "https://app.example.com/search",
    method: "get",
    fields: [{ name: "q", type: "search", label: "Search", required: false }],
    submit_text: "Search",
    destructive: false,
    submitted: false,
    ...overrides,
  };
}

describe("discover_flows schema defaults", () => {
  it("applies small hard budget caps by default", () => {
    const parsed = discoverFlowsSchema.parse({ url: START });
    expect(parsed.max_pages).toBe(10);
    expect(parsed.max_depth).toBe(2);
    expect(parsed.max_time_ms).toBe(60_000);
    expect(parsed.interact_forms).toBe(false);
    expect(parsed.phase).toBeUndefined();
  });

  it("rejects budgets above the hard ceiling", () => {
    expect(() =>
      discoverFlowsSchema.parse({ url: START, max_pages: 51 }),
    ).toThrow();
    expect(() =>
      discoverFlowsSchema.parse({ url: START, max_time_ms: 300_001 }),
    ).toThrow();
  });
});

describe("classifyDestructive", () => {
  it("flags destructive English action text (word-bounded)", () => {
    expect(classifyDestructive("Delete account")).toBe(true);
    expect(classifyDestructive("Send message")).toBe(true);
    expect(classifyDestructive("Proceed to checkout")).toBe(true);
    expect(classifyDestructive("Log out")).toBe(true);
  });

  it("does not flag words that merely contain a keyword", () => {
    // \b keeps "buy" from matching "Buyer's guide".
    expect(classifyDestructive("Buyer's guide")).toBe(false);
    expect(classifyDestructive("About us")).toBe(false);
    expect(classifyDestructive("Pricing")).toBe(false);
  });

  it("flags Thai destructive action text", () => {
    expect(classifyDestructive("ลบรายการ")).toBe(true);
    expect(classifyDestructive("ชำระเงิน")).toBe(true);
    expect(classifyDestructive("ออกจากระบบ")).toBe(true);
    expect(classifyDestructive("หน้าแรก")).toBe(false);
  });

  it("flags destructive hrefs even with harmless text", () => {
    expect(classifyDestructive("คลิก", "https://x.com/wp-login.php?action=logout")).toBe(true);
    expect(classifyDestructive("here", "https://x.com/post.php?action=delete&id=3")).toBe(true);
    expect(classifyDestructive("here", "https://x.com/account/delete")).toBe(true);
    expect(classifyDestructive("here", "https://x.com/blog/post-1")).toBe(false);
  });

  it("href vocabulary carries the full verb list — icon-only links can't slip through", () => {
    // publish/send/deactivate were text-only verbs before; an <a> with no
    // text (icon-only) must still classify on the URL.
    expect(classifyDestructive("", "https://x.com/posts/5/publish")).toBe(true);
    expect(classifyDestructive("", "https://x.com/invoices/9/send")).toBe(true);
    expect(classifyDestructive("", "https://x.com/account/deactivate")).toBe(true);
  });

  it("classification is not defeated by long leading text", () => {
    const cardText =
      "Acme Deluxe Widget Pro Max — limited edition, ships in 3 days, includes lifetime warranty and free returns, buyers love it, five stars across the board. Cancel order";
    expect(cardText.length).toBeGreaterThan(120);
    expect(classifyDestructive(cardText)).toBe(true);
  });
});

describe("isDestructiveUrl", () => {
  it("matches path + query only — a pay./checkout. hostname must not flag the whole site", () => {
    expect(isDestructiveUrl("https://pay.example.com/")).toBe(false);
    expect(isDestructiveUrl("https://checkout.example.com/docs")).toBe(false);
    expect(isDestructiveUrl("https://pay.example.com/orders/5/cancel")).toBe(true);
    expect(isDestructiveUrl("https://x.com/search?delete=test")).toBe(true);
  });
});

describe("normalizeUrl", () => {
  it("resolves relative hrefs and strips fragments", () => {
    expect(normalizeUrl("/about#team", START)).toBe(
      "https://app.example.com/about",
    );
    expect(normalizeUrl("pricing", "https://app.example.com/docs/")).toBe(
      "https://app.example.com/docs/pricing",
    );
  });

  it("rejects non-crawlable schemes and bare fragments", () => {
    expect(normalizeUrl("javascript:void(0)", START)).toBeNull();
    expect(normalizeUrl("mailto:a@b.com", START)).toBeNull();
    expect(normalizeUrl("tel:+66812345678", START)).toBeNull();
    expect(normalizeUrl("#top", START)).toBeNull();
    expect(normalizeUrl("", START)).toBeNull();
  });
});

describe("isCrawlable", () => {
  const origin = "https://app.example.com";

  it("allows same-origin by default, blocks cross-origin", () => {
    expect(isCrawlable("https://app.example.com/x", origin, [], [])).toBe(true);
    expect(isCrawlable("https://evil.example.com/x", origin, [], [])).toBe(false);
  });

  it("allow_patterns open specific cross-origin URLs", () => {
    expect(
      isCrawlable(
        "https://docs.example.com/guide",
        origin,
        [/^https:\/\/docs\.example\.com\//],
        [],
      ),
    ).toBe(true);
  });

  it("deny_patterns win over same-origin and allowlist", () => {
    expect(
      isCrawlable("https://app.example.com/admin/x", origin, [], [/\/admin\//]),
    ).toBe(false);
    expect(
      isCrawlable(
        "https://docs.example.com/guide",
        origin,
        [/docs\.example\.com/],
        [/docs\.example\.com/],
      ),
    ).toBe(false);
  });
});

describe("buildGetSubmitUrl", () => {
  it("turns a GET form into a dummy-data query URL", () => {
    const url = buildGetSubmitUrl(form({}));
    expect(url).toBe("https://app.example.com/search?q=test");
  });

  it("uses type-appropriate dummy values", () => {
    const url = buildGetSubmitUrl(
      form({
        fields: [
          { name: "email", type: "email", label: null, required: true },
          { name: "n", type: "number", label: null, required: false },
        ],
      }),
    );
    expect(url).toContain("email=test%40example.com");
    expect(url).toContain("n=1");
  });

  it("never builds a submit URL for POST forms — read-only crawl", () => {
    expect(buildGetSubmitUrl(form({ method: "post" }))).toBeNull();
  });

  it("returns null when no field is named", () => {
    expect(
      buildGetSubmitUrl(
        form({ fields: [{ name: "", type: "text", label: "X", required: false }] }),
      ),
    ).toBeNull();
  });
});

describe("deriveFlows", () => {
  it("reconstructs the click path for navigation flows", () => {
    const pages: CrawledPage[] = [
      page({}),
      page({
        url: "https://app.example.com/about",
        title: "About",
        depth: 1,
        via: { from_url: START, link_text: "About", kind: "link" },
      }),
      page({
        url: "https://app.example.com/about/team",
        title: "Team",
        depth: 2,
        via: {
          from_url: "https://app.example.com/about",
          link_text: "Team",
          kind: "link",
        },
      }),
    ];
    const flows = deriveFlows(pages, START);
    const team = flows.find((f) => f.target_url?.endsWith("/about/team"));
    expect(team).toBeDefined();
    expect(team!.executed).toBe(true);
    expect(team!.depth).toBe(2);
    expect(team!.steps).toEqual([
      { kind: "navigate", url: START },
      { kind: "click", query: "About" },
      { kind: "click", query: "Team" },
    ]);
    expect(team!.expect).toEqual([
      { kind: "url_matches", pattern: "/about/team" },
    ]);
  });

  it("degrades to direct navigation when the path has a form hop", () => {
    const pages: CrawledPage[] = [
      page({}),
      page({
        url: "https://app.example.com/search?q=test",
        title: "Results",
        depth: 1,
        via: { from_url: START, link_text: "Search", kind: "form" },
      }),
    ];
    const flows = deriveFlows(pages, START);
    const results = flows.find((f) => f.kind === "navigation");
    expect(results!.steps).toEqual([
      { kind: "navigate", url: "https://app.example.com/search?q=test" },
    ]);
  });

  it("dedupes an identical form repeated across pages (shared layout)", () => {
    const pages: CrawledPage[] = [
      page({ forms: [form({})] }),
      page({
        url: "https://app.example.com/about",
        depth: 1,
        via: { from_url: START, link_text: "About", kind: "link" },
        forms: [form({})],
      }),
    ];
    const flows = deriveFlows(pages, START);
    expect(flows.filter((f) => f.kind === "form")).toHaveLength(1);
  });

  it("emits fill_form with dummy values and the submit click", () => {
    const flows = deriveFlows([page({ forms: [form({})] })], START);
    const f = flows.find((x) => x.kind === "form")!;
    expect(f.steps).toEqual([
      { kind: "navigate", url: START },
      { kind: "fill_form", fields: [{ query: "Search", value: "test" }] },
      { kind: "click", query: "Search" },
    ]);
    expect(f.expect).toEqual([{ kind: "url_matches", pattern: "/search" }]);
  });

  it("flags destructive links/buttons as unexecuted flows", () => {
    const flows = deriveFlows(
      [
        page({
          links: [
            {
              text: "Delete account",
              url: "https://app.example.com/account/delete",
              external: false,
              destructive: true,
            },
          ],
          buttons: [{ text: "Publish", destructive: true }],
        }),
      ],
      START,
    );
    const destructive = flows.filter((f) => f.destructive);
    expect(destructive).toHaveLength(2);
    for (const f of destructive) {
      expect(f.executed).toBe(false);
    }
  });

  it("round-trips: every derived step/expect parses under the verify vocabulary", () => {
    const pages: CrawledPage[] = [
      page({
        forms: [form({}), form({ method: "post", action: START, submit_text: "Pay now", destructive: true })],
        links: [
          {
            text: "Logout",
            url: "https://app.example.com/logout",
            external: false,
            destructive: true,
          },
        ],
      }),
      page({
        url: "https://app.example.com/pricing",
        title: "Pricing",
        depth: 1,
        via: { from_url: START, link_text: "Pricing", kind: "link" },
      }),
    ];
    const flows = deriveFlows(pages, START);
    expect(flows.length).toBeGreaterThanOrEqual(4);
    for (const f of flows) {
      // The acceptance criterion: a proposed flow feeds verify_ui_flow
      // unchanged. zod parse throws on any drift from the step vocabulary.
      expect(() => z.array(verifyStepSchema).parse(f.steps)).not.toThrow();
      expect(() => z.array(verifyExpectSchema).parse(f.expect)).not.toThrow();
    }
  });
});

describe("renderFlowMapMarkdown", () => {
  it("escapes pipes/newlines from crawled titles so the tables survive", () => {
    const md = renderFlowMapMarkdown({
      run_id: "r1",
      url: START,
      pages: [page({ title: "Evil | title\nwith newline" })],
      page_errors: [],
      flows: [],
      test_cases: [],
      truncated: { hit: false, reasons: [], pages_not_visited: 0 },
    });
    const row = md.split("\n").find((l) => l.includes("Evil"));
    expect(row).toBeDefined();
    expect(row).toContain("Evil \\| title with newline");
  });
});

describe("buildTestCases", () => {
  it("assigns stable TC ids with P1 before P2 and flags destructive rows", () => {
    const pages: CrawledPage[] = [
      page({ forms: [form({})] }),
      page({
        url: "https://app.example.com/deep/a/b",
        title: "Deep",
        depth: 2,
        via: {
          from_url: "https://app.example.com/deep/a",
          link_text: "B",
          kind: "link",
        },
        buttons: [{ text: "Delete", destructive: true }],
      }),
      page({
        url: "https://app.example.com/pricing",
        title: "Pricing",
        depth: 1,
        via: { from_url: START, link_text: "Pricing", kind: "link" },
      }),
    ];
    const cases = buildTestCases(deriveFlows(pages, START));
    expect(cases.map((c) => c.id)).toEqual(cases.map((_, i) => `TC${i + 1}`));
    // P1 rows (depth<=1 nav + non-destructive forms) come first.
    const priorities = cases.map((c) => c.priority);
    expect(priorities.indexOf("P2")).toBeGreaterThan(0);
    expect(priorities).toEqual(
      [...priorities].sort((a, b) => (a === b ? 0 : a === "P1" ? -1 : 1)),
    );
    const destructiveRow = cases.find((c) => c.destructive)!;
    expect(destructiveRow.priority).toBe("P2");
    expect(destructiveRow.expected_result).toContain("NOT EXECUTED");
  });
});
