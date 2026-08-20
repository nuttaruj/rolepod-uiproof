import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { discoverFlowsTool, type DiscoveredFlow } from "../../src/tools/composite/discover_flows.js";
import { verifyUiFlowTool } from "../../src/tools/composite/verify_ui_flow.js";
import {
  discoverFlowsSchema,
  verifyUiFlowSchema,
} from "../../src/schema/tools.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Acceptance for brief/13-discover-flows.md, against a local demo site
 * (node:http — no network dependency):
 * 1. the obvious flows (nav links, form) are found within the default budget;
 * 2. a proposed flow feeds verify_ui_flow unchanged and runs;
 * 3. destructive actions are flagged and NEVER requested;
 * 4. budget truncation is visible in the result, not silent.
 */

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const SITE: Record<string, string> = {
  "/": page(
    "Home",
    `<nav>
       <a href="/about">About</a>
       <a href="/pricing">Pricing</a>
       <a href="https://other.example.com/">Partner site</a>
       <a href="/account/delete">Delete account</a>
     </nav>
     <form action="/search" method="get">
       <label for="q">Search</label>
       <input id="q" name="q" type="search">
       <button type="submit">Go</button>
     </form>`,
  ),
  "/about": page("About", `<a href="/about/team">Team</a>`),
  "/about/team": page("Team", `<p>The team.</p>`),
  "/pricing": page("Pricing", `<p>Plans.</p>`),
  "/search": page("Results", `<p>Results for your query.</p>`),
  "/account/delete": page("Danger", `<p>must never be crawled</p>`),
};

let server: Server;
let base: string;
const hits: Record<string, number> = {};

let tmpRoot: string;
let registry: SessionRegistry;
let ctx: ToolContext;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    const body = SITE[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("Not found", "<p>404</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;

  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-discover-"));
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
  ctx = {
    registry,
    store: new ArtifactStore({
      rootDir: join(tmpRoot, "artifacts"),
      mode: "standalone",
    }),
  };
});

afterAll(async () => {
  await registry.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("discover_flows — black-box crawl of a demo site", () => {
  it(
    "finds the obvious flows within the default budget, flags destructive, and round-trips into verify_ui_flow",
    async () => {
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({ url: `${base}/` }),
      );
      expect(result.isError).not.toBe(true);
      const body = result.structuredContent as {
        status: string;
        pages_visited: number;
        flows: DiscoveredFlow[];
        test_cases: Array<{ id: string; priority: string }>;
        destructive_count: number;
        truncated: { hit: boolean };
      };

      // 1. Obvious flows found: 5 crawlable pages, nav + form flows present.
      expect(body.status).toBe("pass");
      expect(body.pages_visited).toBe(4); // /, /about, /pricing, /about/team
      const pricing = body.flows.find((f) =>
        f.target_url?.endsWith("/pricing"),
      );
      expect(pricing).toBeDefined();
      expect(pricing!.steps).toEqual([
        { kind: "navigate", url: `${base}/` },
        { kind: "click", query: "Pricing" },
      ]);
      const formFlow = body.flows.find((f) => f.kind === "form");
      expect(formFlow).toBeDefined();
      expect(formFlow!.executed).toBe(false); // interact_forms defaulted off

      // 3. Destructive link flagged, unexecuted, and NEVER requested.
      const destructive = body.flows.filter((f) => f.destructive);
      expect(destructive.length).toBeGreaterThanOrEqual(1);
      expect(destructive.every((f) => f.executed === false)).toBe(true);
      expect(hits["/account/delete"] ?? 0).toBe(0);

      // TC table: stable ids, P1/P2 present.
      expect(body.test_cases[0]!.id).toBe("TC1");
      expect(new Set(body.test_cases.map((t) => t.priority))).toEqual(
        new Set(["P1", "P2"]),
      );

      // 2. Round-trip: the proposed flow runs through verify_ui_flow unchanged.
      const verifyHandler = verifyUiFlowTool.build(ctx);
      const verifyResult = await verifyHandler(
        verifyUiFlowSchema.parse({
          open: { url: `${base}/` },
          steps: pricing!.steps,
          expect: pricing!.expect,
        }),
      );
      expect(verifyResult.isError).not.toBe(true);
      const verdict = verifyResult.structuredContent as { passed: boolean };
      expect(verdict.passed).toBe(true);
    },
    60_000,
  );

  it(
    "reports budget truncation visibly (status=warn) instead of silently capping",
    async () => {
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({ url: `${base}/`, max_pages: 2 }),
      );
      const body = result.structuredContent as {
        status: string;
        truncated: { hit: boolean; reasons: string[]; pages_not_visited: number };
      };
      expect(body.status).toBe("warn");
      expect(body.truncated.hit).toBe(true);
      expect(body.truncated.reasons.join(" ")).toContain("max_pages");
      expect(body.truncated.pages_not_visited).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "interact_forms submits GET forms with dummy data and marks the flow executed",
    async () => {
      const before = hits["/search"] ?? 0;
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({ url: `${base}/`, interact_forms: true }),
      );
      const body = result.structuredContent as { flows: DiscoveredFlow[] };
      const formFlow = body.flows.find((f) => f.kind === "form");
      expect(formFlow!.executed).toBe(true);
      expect((hits["/search"] ?? 0)).toBeGreaterThan(before);
      // Destructive link still untouched even with interaction enabled.
      expect(hits["/account/delete"] ?? 0).toBe(0);
    },
    60_000,
  );

  it(
    "fails loudly (status=fail + root_error) when the start URL 404s",
    async () => {
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({ url: `${base}/missing` }),
      );
      const body = result.structuredContent as {
        status: string;
        root_error?: string;
        flows: unknown[];
      };
      expect(body.status).toBe("fail");
      expect(body.root_error).toContain("HTTP 404");
      expect(body.flows).toHaveLength(0);
    },
    60_000,
  );

  it(
    "refuses a deny-listed start URL before any request is made",
    async () => {
      const before = hits["/pricing"] ?? 0;
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({
          url: `${base}/pricing`,
          deny_patterns: ["/pricing"],
        }),
      );
      expect(result.isError).toBe(true);
      const body = result.structuredContent as { code: string };
      expect(body.code).toBe("invalid_input");
      expect(hits["/pricing"] ?? 0).toBe(before);
    },
    60_000,
  );

  it(
    "a failing setup step still yields a run_id + report + manifest (status=fail)",
    async () => {
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({
          url: `${base}/`,
          setup_steps: [{ kind: "click", query: "No Such Button" }],
        }),
      );
      expect(result.isError).not.toBe(true);
      const body = result.structuredContent as {
        run_id: string;
        status: string;
        root_error?: string;
        report_path: string;
        manifest?: string;
      };
      expect(body.status).toBe("fail");
      expect(body.root_error).toContain("setup_steps failed");
      expect(body.run_id).toBeTruthy();
      expect(body.report_path).toContain("flow-map.json");
      expect(body.manifest).toContain("manifest.json");
    },
    60_000,
  );
});

describe("discover_flows — redirects", () => {
  let rServer: Server;
  let rBase: string;
  const rHits: Record<string, number> = {};

  beforeAll(async () => {
    const pages: Record<string, string> = {
      "/": page(
        "Home",
        // Three unvetted navigation channels aim at the destructive URL: an
        // HTTP 302 (via /go), an embedded iframe, and a scripted popup.
        // Every one must be blocked BEFORE the request reaches the server.
        `<a href="/old">Old pricing</a>
         <a href="/go">Read more</a>
         <a href="/pricing">Pricing</a>
         <iframe src="/account/delete?via=iframe"></iframe>
         <script>window.open("/account/delete?via=popup");</script>`,
      ),
      "/pricing": page("Pricing", `<p>Plans.</p>`),
      "/account/delete": page("Danger", `<p>must never be requested</p>`),
    };
    rServer = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      rHits[path] = (rHits[path] ?? 0) + 1;
      if (path === "/old") {
        res.writeHead(301, { location: "/pricing" });
        res.end();
        return;
      }
      if (path === "/go") {
        res.writeHead(302, { location: "/account/delete" });
        res.end();
        return;
      }
      const body = pages[path];
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    await new Promise<void>((r) => rServer.listen(0, "127.0.0.1", r));
    const addr = rServer.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    rBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => rServer.close(() => r()));
  });

  it(
    "blocks a redirect onto a destructive URL before the request leaves the browser, and dedupes benign redirects",
    async () => {
      const handler = discoverFlowsTool.build(ctx);
      const result = await handler(
        discoverFlowsSchema.parse({ url: `${rBase}/` }),
      );
      const body = result.structuredContent as {
        status: string;
        pages: Array<{ url: string }>;
        page_errors: Array<{ url: string; error: string }>;
        flows: DiscoveredFlow[];
      };

      // None of the three channels (HTTP 302 follow, iframe embed, scripted
      // popup) may reach the destructive URL — the server must never see it.
      expect(rHits["/account/delete"] ?? 0).toBe(0);
      const guardError = body.page_errors.find((e) =>
        e.error.includes("read-only guard"),
      );
      expect(guardError).toBeDefined();
      expect(guardError!.url).toBe(`${rBase}/go`);

      // /old 301s to /pricing, which is also linked directly — exactly one
      // page record under the FINAL URL.
      const pricingPages = body.pages.filter((p) =>
        p.url.endsWith("/pricing"),
      );
      expect(pricingPages).toHaveLength(1);

      // A blocked interior page degrades the verdict to warn, never a silent pass.
      expect(body.status).toBe("warn");

      // No flow may claim the destructive redirect target was executed.
      for (const f of body.flows) {
        expect(f.target_url?.endsWith("/account/delete") && f.executed).not.toBe(
          true,
        );
      }
    },
    60_000,
  );
});
