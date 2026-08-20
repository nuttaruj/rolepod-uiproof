import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import type { OpenOptions, Session } from "../../engine/Engine.js";
import {
  discoverFlowsShape,
  ToolNames,
  type DiscoverFlowsInput,
  type VerifyUiFlowInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import {
  writeManifest,
  type ManifestArtifact,
  type ManifestStatus,
} from "../../util/manifest.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";
import { runStep } from "./verify_ui_flow.js";

type VerifyStep = VerifyUiFlowInput["steps"][number];
type VerifyExpect = VerifyUiFlowInput["expect"][number];

// ---------------------------------------------------------------------------
// Crawl data model
// ---------------------------------------------------------------------------

export type DiscoveredLink = {
  text: string;
  url: string;
  external: boolean;
  destructive: boolean;
};

export type DiscoveredFormField = {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
};

export type DiscoveredForm = {
  /** Absolute submit URL (resolved against the page; page URL when no action). */
  action: string;
  method: string;
  fields: DiscoveredFormField[];
  submit_text: string | null;
  destructive: boolean;
  /** Set when interact_forms enqueued this form's GET submit URL. */
  submit_url?: string;
  /** True when the crawler actually visited the submit URL. */
  submitted: boolean;
};

export type CrawlEdge = {
  from_url: string;
  link_text: string;
  kind: "link" | "form";
};

export type CrawledPage = {
  /** Where the browser actually landed (post-redirect, normalized). */
  url: string;
  /** The enqueued URL, present only when a redirect changed it. */
  requested_url?: string;
  title: string;
  depth: number;
  /** BFS edge that discovered this page (absent on the root). */
  via?: CrawlEdge;
  links: DiscoveredLink[];
  forms: DiscoveredForm[];
  buttons: Array<{ text: string; destructive: boolean }>;
  /** True when per-page element caps clipped links/forms/buttons. */
  elements_truncated: boolean;
};

export type DiscoveredFlow = {
  id: string;
  name: string;
  kind: "navigation" | "form" | "action";
  destructive: boolean;
  /** Whether the crawler actually traversed this flow. Destructive: never. */
  executed: boolean;
  /** BFS depth of the target page (navigation flows only). */
  depth?: number;
  entry_url: string;
  target_url?: string;
  /** verify_ui_flow-compatible — feeds `/verify-ui` steps unchanged. */
  steps: VerifyStep[];
  /** Suggested expectations; empty when the outcome can't be predicted. */
  expect: VerifyExpect[];
};

export type ProposedTestCase = {
  id: string;
  flow_id: string;
  name: string;
  priority: "P1" | "P2";
  destructive: boolean;
  steps: string[];
  expected_result: string;
};

export type Truncation = {
  hit: boolean;
  reasons: string[];
  pages_not_visited: number;
};

// ---------------------------------------------------------------------------
// Destructive-action classification — the crawler NEVER follows these; they
// are listed as flagged, unexecuted flows. Over-flagging is the safe
// direction: a flagged flow is still proposed, just left for a human /
// explicitly-approved verify run.
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the destructive-verb vocabulary — the href
 * regex derives from the SAME list, so an icon-only link (no text) with a
 * verb-bearing URL (`/posts/5/publish`) is caught exactly like a text link.
 */
const DESTRUCTIVE_VERBS_EN = [
  "delete",
  "remove",
  "destroy",
  "erase",
  "wipe",
  "trash",
  "purge",
  "drop",
  "reset",
  // money movement / payment rails
  "pay",
  "payout",
  "purchase",
  "buy",
  "checkout",
  "order",
  "charge",
  "chargeback",
  "capture",
  "disburse",
  "wire",
  "transfer",
  "withdraw",
  "refund",
  "void",
  // lifecycle / account state
  "subscribe",
  "unsubscribe",
  "renew",
  "send",
  "submit payment",
  "publish",
  "unpublish",
  "deactivate",
  "disable",
  "suspend",
  "terminate",
  "close",
  "cancel",
  "archive",
  "approve",
  "reject",
  "revoke",
  "ban",
  "deploy",
  "rollback",
  "logout",
  "log out",
  "sign out",
];

const DESTRUCTIVE_TEXT_EN = new RegExp(
  `\\b(${DESTRUCTIVE_VERBS_EN.join("|")})\\b`,
  "i",
);

/**
 * Thai has no word boundaries usable by `\b` — substring match on a curated
 * list. Deliberately loose (e.g. "ส่ง" also hits "จัดส่ง"): over-flagging is
 * the safe direction for a read-only crawl.
 */
const DESTRUCTIVE_TEXT_TH = [
  "ลบ",
  "ชำระเงิน",
  "สั่งซื้อ",
  "ซื้อ",
  "ยกเลิก",
  "ออกจากระบบ",
  "เผยแพร่",
  "ส่ง",
  "โอน",
  "ถอน",
];

const DESTRUCTIVE_HREF = new RegExp(
  `\\b(${[...DESTRUCTIVE_VERBS_EN, "log-out", "signout", "sign-out"].join("|")})\\b` +
    "|[?&]action=(delete|trash|remove|logout)",
  "i",
);

/**
 * URL-level destructive check, evaluated against the PATH + QUERY only —
 * matching the full URL would flag every link on a host like
 * `pay.example.com` and freeze the whole crawl.
 */
export function isDestructiveUrl(url: string): boolean {
  let pathAndQuery = url;
  try {
    const u = new URL(url);
    pathAndQuery = u.pathname + u.search;
  } catch {
    /* not absolute — test the raw string */
  }
  return DESTRUCTIVE_HREF.test(pathAndQuery);
}

export function classifyDestructive(text: string, href?: string): boolean {
  if (DESTRUCTIVE_TEXT_EN.test(text)) return true;
  if (DESTRUCTIVE_TEXT_TH.some((t) => text.includes(t))) return true;
  if (href !== undefined && isDestructiveUrl(href)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * Resolve a raw href against a base and normalize for dedup (fragment
 * stripped). Returns null for non-crawlable schemes (javascript:, mailto:,
 * tel:, …) and unparseable values.
 */
export function normalizeUrl(raw: string, baseUrl: string): string | null {
  const t = raw.trim();
  if (t === "" || t.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|data|blob|file|about):/i.test(t)) return null;
  try {
    const u = new URL(t, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Same-origin is always crawlable; beyond that a URL must match an
 * allow-pattern. Deny-patterns win over everything.
 */
export function isCrawlable(
  url: string,
  origin: string,
  allow: RegExp[],
  deny: RegExp[],
): boolean {
  if (deny.some((re) => re.test(url))) return false;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === origin;
  } catch {
    return false;
  }
  return sameOrigin || allow.some((re) => re.test(url));
}

function compilePatterns(patterns: string[] | undefined, which: string): RegExp[] {
  return (patterns ?? []).map((p) => {
    try {
      return new RegExp(p);
    } catch (err) {
      throw new RolepodMcpError(
        "invalid_input",
        `Invalid ${which} regex "${p}": ${(err as Error).message}`,
        { pattern: p },
      );
    }
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Dummy data for opt-in GET-form interaction
// ---------------------------------------------------------------------------

export function dummyValueFor(field: DiscoveredFormField): string | boolean {
  switch (field.type) {
    case "email":
      return "test@example.com";
    case "tel":
      return "0812345678";
    case "number":
    case "range":
      return "1";
    case "password":
      return "Test1234!";
    case "url":
      return "https://example.com";
    case "date":
      return "2026-01-01";
    case "checkbox":
      return true;
    default:
      return "test";
  }
}

/**
 * A GET form submission is a pure URL navigation — the only form interaction
 * a read-only crawl performs (opt-in). Returns null for POST forms and forms
 * with no named fields.
 */
export function buildGetSubmitUrl(form: DiscoveredForm): string | null {
  if (form.method !== "get") return null;
  const named = form.fields.filter((f) => f.name !== "");
  if (named.length === 0) return null;
  try {
    const u = new URL(form.action);
    for (const f of named) {
      const v = dummyValueFor(f);
      u.searchParams.set(f.name, typeof v === "boolean" ? "on" : v);
    }
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flow derivation — pure, unit-tested. Steps round-trip into verify_ui_flow.
// ---------------------------------------------------------------------------

export function deriveFlows(pages: CrawledPage[], startUrl: string): DiscoveredFlow[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const flows: DiscoveredFlow[] = [];
  let n = 0;
  const nextId = () => `flow-${++n}`;

  // Navigation flows — one per crawled non-root page, as the click path the
  // crawler actually took. A path broken by a form-submit hop (or a missing
  // link text) degrades to a direct navigate.
  for (const page of pages) {
    if (page.depth === 0) continue;
    const chain: string[] = [];
    let cur: CrawledPage | undefined = page;
    let broken = false;
    while (cur !== undefined && cur.depth > 0) {
      if (!cur.via || cur.via.kind !== "link" || cur.via.link_text === "") {
        broken = true;
        break;
      }
      chain.unshift(cur.via.link_text);
      cur = byUrl.get(cur.via.from_url);
    }
    const steps: VerifyStep[] =
      broken || cur === undefined
        ? [{ kind: "navigate", url: page.url }]
        : [
            { kind: "navigate", url: startUrl },
            ...chain.map((t) => ({ kind: "click" as const, query: t })),
          ];
    flows.push({
      id: nextId(),
      name: `Navigate to ${page.title || pathnameOf(page.url)}`,
      kind: "navigation",
      destructive: false,
      executed: true,
      depth: page.depth,
      entry_url: startUrl,
      target_url: page.url,
      steps,
      expect: [
        { kind: "url_matches", pattern: escapeRegex(pathnameOf(page.url)) },
      ],
    });
  }

  // Form flows — deduped by (method, action, field names): the same login /
  // search form repeated in a shared layout yields one flow, anchored at the
  // page where it was first seen.
  const seenForms = new Set<string>();
  for (const page of pages) {
    for (const form of page.forms) {
      const sig = `${form.method} ${form.action} ${form.fields
        .map((f) => f.name || f.label || f.type)
        .join(",")}`;
      if (seenForms.has(sig)) continue;
      seenForms.add(sig);

      const fillables = form.fields.filter(
        (f) => f.label !== null || f.name !== "",
      );
      const steps: VerifyStep[] = [{ kind: "navigate", url: page.url }];
      if (fillables.length > 0) {
        steps.push({
          kind: "fill_form",
          fields: fillables.map((f) => ({
            query: f.label ?? f.name,
            value: dummyValueFor(f),
          })),
        });
      }
      steps.push({ kind: "click", query: form.submit_text ?? "Submit" });

      const actionPath = pathnameOf(form.action);
      const expect: VerifyExpect[] =
        actionPath !== pathnameOf(page.url)
          ? [{ kind: "url_matches", pattern: escapeRegex(actionPath) }]
          : [];

      flows.push({
        id: nextId(),
        name: `Form: ${form.submit_text ?? actionPath} on ${
          page.title || pathnameOf(page.url)
        }`,
        kind: "form",
        destructive: form.destructive,
        executed: form.submitted,
        entry_url: page.url,
        target_url: form.action,
        steps,
        expect,
      });
    }
  }

  // Destructive links + buttons — listed as flagged flows, never executed.
  const seenActions = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!link.destructive) continue;
      const key = `link:${link.url || link.text.toLowerCase()}`;
      if (seenActions.has(key)) continue;
      seenActions.add(key);
      flows.push({
        id: nextId(),
        name: `Destructive: ${link.text || pathnameOf(link.url)}`,
        kind: "navigation",
        destructive: true,
        executed: false,
        entry_url: page.url,
        target_url: link.url,
        steps: [
          { kind: "navigate", url: page.url },
          { kind: "click", query: link.text || link.url },
        ],
        expect: [],
      });
    }
    for (const button of page.buttons) {
      if (!button.destructive) continue;
      const key = `button:${button.text.toLowerCase()}`;
      if (seenActions.has(key)) continue;
      seenActions.add(key);
      flows.push({
        id: nextId(),
        name: `Destructive: ${button.text}`,
        kind: "action",
        destructive: true,
        executed: false,
        entry_url: page.url,
        steps: [
          { kind: "navigate", url: page.url },
          { kind: "click", query: button.text },
        ],
        expect: [],
      });
    }
  }

  return flows;
}

// ---------------------------------------------------------------------------
// Proposed test-case table — TC-ID + P1/P2, the same convention the
// /scaffold-e2e handoff uses, so parent qa-tester can consume it directly.
// ---------------------------------------------------------------------------

function describeStep(step: VerifyStep): string {
  switch (step.kind) {
    case "navigate":
      return `navigate ${step.url}`;
    case "click":
      return `click "${step.query}"`;
    case "fill_form":
      return `fill ${step.fields.length} field(s) with dummy data`;
    default:
      return step.kind;
  }
}

function describeExpectShort(exp: VerifyExpect): string {
  switch (exp.kind) {
    case "url_matches":
      return `URL matches /${exp.pattern}/`;
    case "text_visible":
      return `text "${exp.text}" visible`;
    default:
      return exp.kind;
  }
}

export function buildTestCases(flows: DiscoveredFlow[]): ProposedTestCase[] {
  const p1: DiscoveredFlow[] = [];
  const p2: DiscoveredFlow[] = [];
  for (const f of flows) {
    const isP1 =
      !f.destructive &&
      (f.kind === "form" || (f.kind === "navigation" && (f.depth ?? 99) <= 1));
    (isP1 ? p1 : p2).push(f);
  }
  return [...p1, ...p2].map((f, i) => ({
    id: `TC${i + 1}`,
    flow_id: f.id,
    name: f.name,
    priority: i < p1.length ? ("P1" as const) : ("P2" as const),
    destructive: f.destructive,
    steps: f.steps.map(describeStep),
    expected_result: f.destructive
      ? "NOT EXECUTED (destructive) — requires explicit approval before any verify run"
      : f.expect.length > 0
        ? f.expect.map(describeExpectShort).join("; ")
        : "TODO: define expected result",
  }));
}

// ---------------------------------------------------------------------------
// The composite tool
// ---------------------------------------------------------------------------

/** Per-page element caps — reported via `elements_truncated`, never silent. */
const MAX_LINKS_PER_PAGE = 100;
const MAX_FORMS_PER_PAGE = 20;
const MAX_BUTTONS_PER_PAGE = 50;
const PAGE_GOTO_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 5;

export const discoverFlowsTool: ToolModule<typeof discoverFlowsShape> = {
  name: ToolNames.discoverFlows,
  description:
    "Black-box flow discovery: crawl a running app (GET navigation, same-origin, hard budget caps), enumerate pages / links / forms / buttons, and derive candidate user flows plus a proposed TC-ID/P1-P2 test-case table. Flow steps feed verify_ui_flow unchanged. Destructive-looking actions are flagged, never executed; form interaction is opt-in and GET-only with dummy data.",
  inputShape: discoverFlowsShape,
  build(ctx) {
    return safeHandler(async (args: DiscoverFlowsInput) => {
      const startedAt = new Date().toISOString();
      const startUrl = normalizeUrl(args.url, args.url);
      if (startUrl === null) {
        throw new RolepodMcpError(
          "invalid_input",
          `Start URL "${args.url}" is not a crawlable http(s) URL.`,
        );
      }
      const origin = new URL(startUrl).origin;
      const allow = compilePatterns(args.allow_patterns, "allow_patterns");
      const deny = compilePatterns(args.deny_patterns, "deny_patterns");

      // deny_patterns must win over EVERYTHING — including the start URL
      // itself, which would otherwise get one authenticated GET (setup goto
      // or pre-flight hop 0) before any guard sees it. Same for a start URL
      // that is itself a destructive GET endpoint.
      if (deny.some((re) => re.test(startUrl)) || isDestructiveUrl(startUrl)) {
        throw new RolepodMcpError(
          "invalid_input",
          `Start URL "${args.url}" is deny-listed or classified destructive — refusing to crawl it.`,
        );
      }

      const { runId, runDir, skill } = await ctx.store.startRun("discover", {
        skill: "discover-flows",
      });

      const openOpts: OpenOptions = {
        platform: "web",
        browser: args.browser ?? "chromium",
        viewport: args.viewport,
      };
      const session = await ctx.registry.open(openOpts);
      const sessionHandle: Session = {
        id: session.id,
        platform: session.platform,
      };
      const engine = ctx.registry.engineFor(session.id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "discover_flows requires PlaywrightEngine (web-only).",
        );
      }

      const pages: CrawledPage[] = [];
      const pageErrors: Array<{ url: string; error: string }> = [];
      const truncation: Truncation = {
        hit: false,
        reasons: [],
        pages_not_visited: 0,
      };
      let rootFailed: string | undefined;

      let cleanupRoute: (() => Promise<void>) | undefined;
      try {
        const page = engine.getPageForSession(session.id);
        const deadline = Date.now() + args.max_time_ms;

        // Setup steps (e.g. a login sequence) — same vocabulary + semantics
        // as /verify-ui, executed once before the crawl. A failure here must
        // still produce a report + manifest (parity with every other failure
        // path in this composite), so it maps to rootFailed, never a throw.
        if (args.setup_steps !== undefined && args.setup_steps.length > 0) {
          try {
            await page.goto(startUrl, {
              waitUntil: "load",
              timeout: PAGE_GOTO_TIMEOUT_MS,
            });
            for (const step of args.setup_steps) {
              if (Date.now() >= deadline) {
                throw new RolepodMcpError(
                  "engine_error",
                  `max_time_ms (${args.max_time_ms}) exceeded during setup_steps`,
                );
              }
              const snap = await engine.snapshot(sessionHandle);
              await runStep(engine, sessionHandle, step, snap);
            }
          } catch (err) {
            rootFailed = `setup_steps failed: ${errMessage(err)}`;
          }
        }

        // Read-only navigation guard: abort any main-frame navigation whose
        // target is destructive or outside the crawl scope BEFORE the request
        // leaves the browser. This is what stops an HTTP 302 / meta-refresh /
        // scripted redirect from dragging the crawler onto a delete/logout
        // URL that enqueue-time classification never saw. Installed AFTER
        // setup_steps so a login flow may bounce through an external IdP.
        const blockedNav: string[] = [];
        if (rootFailed === undefined) {
          // Context-level, not page-level: window.open() popups are separate
          // Pages in the same context (and headless Chromium ships with popup
          // blocking disabled), and iframes navigate in subframes — both are
          // navigation channels a page-scoped main-frame-only guard misses.
          const browserContext = page.context();
          await browserContext.route("**/*", (route) => {
            const req = route.request();
            let isNav = false;
            try {
              isNav = req.isNavigationRequest();
            } catch {
              isNav = false;
            }
            if (!isNav) {
              void route.continue().catch(() => undefined);
              return;
            }
            const target = req.url();
            // Destructive-URL navigations abort in EVERY frame of EVERY page
            // — an embedded `<iframe src="/logout">` or a scripted popup to a
            // delete endpoint is still an authenticated GET.
            if (isDestructiveUrl(target)) {
              blockedNav.push(target);
              void route.abort("blockedbyclient").catch(() => undefined);
              return;
            }
            // Crawl-scope enforcement applies to top-level navigations of any
            // page (main page + popups); subframe embeds may load
            // out-of-scope content (video embeds etc.) without harm.
            let topLevel = false;
            try {
              topLevel = req.frame().parentFrame() === null;
            } catch {
              topLevel = false; // service-worker request — no frame
            }
            if (topLevel && !isCrawlable(target, origin, allow, deny)) {
              blockedNav.push(target);
              void route.abort("blockedbyclient").catch(() => undefined);
              return;
            }
            void route.continue().catch(() => undefined);
          });
          cleanupRoute = () => browserContext.unroute("**/*");
        }

        // HTTP redirects are followed INSIDE Playwright's network stack —
        // they never re-enter the route guard above (verified empirically;
        // fulfilling a fetched 302 is followed internally too). So the guard
        // alone cannot stop `GET /go → 302 → /account/delete`. Pre-flight
        // the chain hop by hop with redirect-following disabled, vetting
        // every Location BEFORE it is ever requested; goto then targets the
        // vetted final URL directly. The guard still covers browser-initiated
        // navigations (meta refresh, scripted location changes).
        const apiRequest = page.context().request;
        const resolveRedirectChain = async (
          url: string,
          timeoutMs: number,
        ): Promise<{ finalUrl: string; blocked?: string }> => {
          let current = url;
          for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
            const resp = await apiRequest.get(current, {
              maxRedirects: 0,
              timeout: timeoutMs,
              failOnStatusCode: false,
            });
            const status = resp.status();
            const location = resp.headers()["location"];
            await resp.dispose().catch(() => undefined);
            if (status < 300 || status >= 400 || location === undefined) {
              return { finalUrl: current };
            }
            const next = normalizeUrl(location, current);
            if (next === null) return { finalUrl: current };
            if (
              !isCrawlable(next, origin, allow, deny) ||
              isDestructiveUrl(next)
            ) {
              return { finalUrl: current, blocked: next };
            }
            current = next;
          }
          // Chain too deep to vet — refuse rather than follow blindly.
          return { finalUrl: current, blocked: current };
        };

        const queue: Array<{ url: string; depth: number; via?: CrawlEdge }> =
          rootFailed === undefined ? [{ url: startUrl, depth: 0 }] : [];
        const visited = new Set<string>();
        const enqueued = new Set<string>([startUrl]);
        const depthSkipped = new Set<string>();

        while (queue.length > 0) {
          if (pages.length >= args.max_pages) {
            truncation.hit = true;
            truncation.reasons.push(
              `max_pages (${args.max_pages}) reached — ${queue.length} queued URL(s) not visited`,
            );
            truncation.pages_not_visited += queue.length;
            break;
          }
          if (Date.now() >= deadline) {
            truncation.hit = true;
            truncation.reasons.push(
              `max_time_ms (${args.max_time_ms}) exceeded — ${queue.length} queued URL(s) not visited`,
            );
            truncation.pages_not_visited += queue.length;
            break;
          }

          const item = queue.shift()!;
          if (visited.has(item.url)) continue;
          visited.add(item.url);

          const blockedBefore = blockedNav.length;
          let gotoUrl = item.url;
          let httpStatus = 0;
          try {
            const gotoTimeout = Math.max(
              1000,
              Math.min(PAGE_GOTO_TIMEOUT_MS, deadline - Date.now()),
            );
            const chain = await resolveRedirectChain(item.url, gotoTimeout);
            if (chain.blocked !== undefined) {
              const msg = `redirect target ${chain.blocked} blocked by read-only guard — destructive or outside crawl scope`;
              if (item.depth === 0) {
                rootFailed = `start URL failed to load: ${msg}`;
                break;
              }
              pageErrors.push({ url: item.url, error: msg });
              continue;
            }
            gotoUrl = chain.finalUrl;
            if (gotoUrl !== item.url) {
              if (visited.has(gotoUrl)) continue; // redirect converged on a crawled page
              visited.add(gotoUrl);
            }
            const resp = await page.goto(gotoUrl, {
              waitUntil: "load",
              timeout: gotoTimeout,
            });
            httpStatus = resp?.status() ?? 0;
          } catch (err) {
            const blockedTarget =
              blockedNav.length > blockedBefore
                ? blockedNav[blockedNav.length - 1]
                : undefined;
            const msg =
              blockedTarget !== undefined
                ? `navigation blocked by read-only guard — target ${blockedTarget} is destructive or outside crawl scope`
                : errMessage(err);
            if (item.depth === 0) {
              rootFailed = `start URL failed to load: ${msg}`;
              break;
            }
            pageErrors.push({ url: item.url, error: msg });
            continue;
          }
          if (httpStatus >= 400) {
            if (item.depth === 0) {
              rootFailed = `start URL returned HTTP ${httpStatus}`;
              break;
            }
            pageErrors.push({ url: item.url, error: `HTTP ${httpStatus}` });
            continue;
          }

          // Bounded settle for client-rendered pages (same as audit_seo),
          // clamped to the remaining time budget.
          await page
            .waitForLoadState("networkidle", {
              timeout: Math.max(250, Math.min(2000, deadline - Date.now())),
            })
            .catch(() => undefined);

          // Where did we actually land? The pre-flight vetted the HTTP chain,
          // but an in-page redirect (meta refresh / script) during the settle
          // can still move the page: dedupe and scope-check the FINAL URL,
          // and record the page under it so emitted flows/expectations match
          // what a verify run sees.
          const finalUrl = page.url();
          const finalNorm = normalizeUrl(finalUrl, finalUrl) ?? gotoUrl;
          if (finalNorm !== gotoUrl) {
            if (visited.has(finalNorm)) continue; // converged on a crawled page
            visited.add(finalNorm);
            // Defense in depth behind the route guard + pre-flight.
            if (
              !isCrawlable(finalNorm, origin, allow, deny) ||
              isDestructiveUrl(finalNorm)
            ) {
              pageErrors.push({
                url: item.url,
                error: `redirected to ${finalNorm} — destructive or outside crawl scope; page skipped`,
              });
              continue;
            }
          }

          const raw = await page.evaluate(extractPageMap, {
            maxLinks: MAX_LINKS_PER_PAGE,
            maxForms: MAX_FORMS_PER_PAGE,
            maxButtons: MAX_BUTTONS_PER_PAGE,
          });

          // Classification always sees the FULL extracted text (the action
          // verb may sit past any display cap); stored text is truncated.
          const links: DiscoveredLink[] = [];
          for (const l of raw.links) {
            const resolved = normalizeUrl(l.href, finalUrl);
            if (resolved === null) continue;
            links.push({
              text: l.text.slice(0, 120),
              url: resolved,
              external: new URL(resolved).origin !== origin,
              destructive: classifyDestructive(l.text, resolved),
            });
          }

          const forms: DiscoveredForm[] = raw.forms.map((f) => {
            const action = f.action !== null && f.action.trim() !== ""
              ? (normalizeUrl(f.action, finalUrl) ?? finalNorm)
              : finalNorm;
            const submitText = f.submit_text;
            return {
              action,
              method: f.method.toLowerCase() === "post" ? "post" : "get",
              fields: f.fields,
              submit_text: submitText !== null ? submitText.slice(0, 120) : null,
              destructive: classifyDestructive(
                `${submitText ?? ""} ${f.fields.map((x) => x.label ?? "").join(" ")}`,
                action,
              ),
              submitted: false,
            };
          });

          const crawled: CrawledPage = {
            url: finalNorm,
            ...(finalNorm !== item.url ? { requested_url: item.url } : {}),
            title: raw.title,
            depth: item.depth,
            ...(item.via !== undefined ? { via: item.via } : {}),
            links,
            forms,
            buttons: raw.buttons.map((t) => ({
              text: t.slice(0, 120),
              destructive: classifyDestructive(t),
            })),
            elements_truncated: raw.truncated,
          };
          pages.push(crawled);

          // Enqueue crawlable, non-destructive links.
          for (const link of links) {
            if (link.destructive) continue;
            if (!isCrawlable(link.url, origin, allow, deny)) continue;
            if (enqueued.has(link.url) || visited.has(link.url)) continue;
            if (item.depth >= args.max_depth) {
              depthSkipped.add(link.url);
              continue;
            }
            enqueued.add(link.url);
            queue.push({
              url: link.url,
              depth: item.depth + 1,
              via: { from_url: finalNorm, link_text: link.text, kind: "link" },
            });
          }

          // Opt-in GET-form interaction: submitting a GET form is a pure URL
          // navigation with dummy query values. POST forms are never
          // submitted — that would mutate the target.
          if (args.interact_forms) {
            for (const form of forms) {
              if (form.destructive) continue;
              const submitUrl = buildGetSubmitUrl(form);
              if (submitUrl === null) continue;
              form.submit_url = submitUrl;
              if (!isCrawlable(submitUrl, origin, allow, deny)) continue;
              // A dummy query param can itself introduce a destructive token
              // (e.g. a field named "delete") — never enqueue such a URL.
              if (isDestructiveUrl(submitUrl)) continue;
              if (enqueued.has(submitUrl) || visited.has(submitUrl)) continue;
              if (item.depth >= args.max_depth) {
                // Form submits dropped by the depth cap are truncation too.
                depthSkipped.add(submitUrl);
                continue;
              }
              enqueued.add(submitUrl);
              queue.push({
                url: submitUrl,
                depth: item.depth + 1,
                via: {
                  from_url: finalNorm,
                  link_text: form.submit_text ?? "Submit",
                  kind: "form",
                },
              });
            }
          }
        }

        if (depthSkipped.size > 0) {
          truncation.hit = true;
          truncation.reasons.push(
            `max_depth (${args.max_depth}) reached — ${depthSkipped.size} unique URL(s) not followed`,
          );
        }

        // Mark which GET forms were actually followed.
        for (const p of pages) {
          for (const form of p.forms) {
            if (form.submit_url !== undefined && visited.has(form.submit_url)) {
              form.submitted = true;
            }
          }
        }
      } finally {
        // Leave no route handler behind on a session the caller keeps open.
        if (cleanupRoute !== undefined) {
          await cleanupRoute().catch(() => undefined);
        }
        if (args.close_on_finish) {
          await ctx.registry.close(sessionHandle).catch(() => undefined);
        }
      }

      const flows = deriveFlows(pages, startUrl);
      const testCases = buildTestCases(flows);
      const destructiveCount = flows.filter((f) => f.destructive).length;

      // Non-root page errors degrade the verdict to "warn" — a caller gating
      // on manifest.status must not read a crawl with broken interior links
      // as a clean pass.
      const status: ManifestStatus =
        rootFailed !== undefined
          ? "fail"
          : truncation.hit || pageErrors.length > 0
            ? "warn"
            : "pass";
      const summary =
        rootFailed !== undefined
          ? `discover failed: ${rootFailed}`
          : `${pages.length} page(s), ${flows.length} flow(s), ${testCases.length} test case(s), ${destructiveCount} destructive flagged` +
            (pageErrors.length > 0 ? `, ${pageErrors.length} page error(s)` : "") +
            (truncation.hit ? ` — truncated: ${truncation.reasons.join("; ")}` : "");

      const fullReport = {
        run_id: runId,
        url: args.url,
        origin,
        started_at: startedAt,
        budget: {
          max_pages: args.max_pages,
          max_depth: args.max_depth,
          max_time_ms: args.max_time_ms,
        },
        interact_forms: args.interact_forms,
        pages,
        page_errors: pageErrors,
        flows,
        test_cases: testCases,
        truncated: truncation,
        ...(rootFailed !== undefined ? { root_error: rootFailed } : {}),
      };
      const reportPath = await ctx.store.writeReport(
        runDir,
        "flow-map.json",
        JSON.stringify(fullReport, null, 2),
      );
      let markdownPath: string | undefined;
      if (args.report_format === "markdown") {
        markdownPath = await ctx.store.writeReport(
          runDir,
          "flow-map.md",
          renderFlowMapMarkdown(fullReport),
        );
      }

      const artifacts: ManifestArtifact[] = [
        { type: "flow-map", path: reportPath },
        ...(markdownPath !== undefined
          ? [{ type: "flow-map-md", path: markdownPath }]
          : []),
      ];
      const manifestPath = await writeManifest({
        runDir,
        skill,
        // Discovery produces test-plan artifacts, like /scaffold-e2e → build.
        phase: args.phase ?? "build",
        status,
        summary,
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts,
        metadata: {
          url: args.url,
          pages_visited: pages.length,
          flow_count: flows.length,
          test_case_count: testCases.length,
          destructive_count: destructiveCount,
          truncated: truncation.hit,
        },
      });

      return ok({
        run_id: runId,
        url: args.url,
        origin,
        status,
        pages_visited: pages.length,
        pages: pages.map((p) => ({
          url: p.url,
          title: p.title,
          depth: p.depth,
          links: p.links.length,
          forms: p.forms.length,
          elements_truncated: p.elements_truncated,
        })),
        page_errors: pageErrors,
        flows,
        test_cases: testCases,
        destructive_count: destructiveCount,
        truncated: truncation,
        ...(rootFailed !== undefined ? { root_error: rootFailed } : {}),
        report_path: reportPath,
        ...(markdownPath !== undefined ? { markdown_path: markdownPath } : {}),
        ...(manifestPath !== undefined ? { manifest: manifestPath } : {}),
      });
    });
  },
};

// ---------------------------------------------------------------------------
// In-page extraction — runs via page.evaluate. tsconfig excludes the DOM lib
// (same pattern as audit_seo's extractSeoSnapshot), so we declare a minimal
// structural shape for the DOM subset used here.
// ---------------------------------------------------------------------------

export type RawPageMap = {
  title: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{
    action: string | null;
    method: string;
    fields: Array<{
      name: string;
      type: string;
      label: string | null;
      required: boolean;
    }>;
    submit_text: string | null;
  }>;
  buttons: string[];
  truncated: boolean;
};

function extractPageMap(caps: {
  maxLinks: number;
  maxForms: number;
  maxButtons: number;
}): RawPageMap {
  type El = {
    textContent: string | null;
    getAttribute(name: string): string | null;
    querySelector(s: string): El | null;
    querySelectorAll(s: string): ArrayLike<El>;
  };
  type Doc = {
    title: string;
    querySelector(s: string): El | null;
    querySelectorAll(s: string): ArrayLike<El>;
  };
  const doc = (globalThis as unknown as { document: Doc }).document;
  const toArray = (list: ArrayLike<El>): El[] => {
    const out: El[] = [];
    for (let i = 0; i < list.length; i++) out.push(list[i]!);
    return out;
  };
  // 2000-char cap bounds the payload while keeping enough text for the
  // Node-side destructive classification (display truncation happens there —
  // truncating to display length FIRST would hide a trailing action verb,
  // e.g. a long product-card link ending in "… Cancel order").
  const textOf = (el: El): string =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);

  // Icon-only links carry their accessible name on an attribute or a child
  // (aria-label on the <a> or an inner <svg>, img[alt], title) — fall through
  // those before yielding empty text, or a destructive icon link would
  // classify on the URL alone.
  const accessibleText = (el: El): string => {
    const t = textOf(el);
    if (t !== "") return t;
    for (const attr of ["aria-label", "title"]) {
      const v = el.getAttribute(attr);
      if (v !== null && v.trim() !== "") return v.trim().slice(0, 2000);
    }
    const selectors = ["[aria-label]", "img[alt]", "[title]"];
    const attrs = ["aria-label", "alt", "title"];
    for (let i = 0; i < selectors.length; i++) {
      const child = el.querySelector(selectors[i]!);
      const v = child?.getAttribute(attrs[i]!);
      if (v !== undefined && v !== null && v.trim() !== "") {
        return v.trim().slice(0, 2000);
      }
    }
    return "";
  };

  let truncated = false;

  const allLinks = toArray(doc.querySelectorAll("a[href]"));
  if (allLinks.length > caps.maxLinks) truncated = true;
  const links = allLinks.slice(0, caps.maxLinks).map((a) => ({
    text: accessibleText(a),
    href: a.getAttribute("href") ?? "",
  }));

  const allForms = toArray(doc.querySelectorAll("form"));
  if (allForms.length > caps.maxForms) truncated = true;
  const forms = allForms.slice(0, caps.maxForms).map((form) => {
    const fieldEls = toArray(
      form.querySelectorAll("input, select, textarea"),
    ).slice(0, 30);
    const fields: Array<{
      name: string;
      type: string;
      label: string | null;
      required: boolean;
    }> = [];
    for (const el of fieldEls) {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      // Radios are skipped: a synthetic value would be meaningless (only the
      // markup's own option values are valid) and would corrupt GET submits.
      if (
        type === "hidden" ||
        type === "submit" ||
        type === "button" ||
        type === "radio"
      )
        continue;
      const id = el.getAttribute("id");
      let label: string | null = el.getAttribute("aria-label");
      if (label === null && id !== null) {
        // CSS.escape neutralizes selector metacharacters in a page-supplied
        // id; the try/catch contains any residual invalid-selector throw to
        // this one lookup instead of failing the whole extraction.
        try {
          const esc = (
            globalThis as unknown as { CSS: { escape(s: string): string } }
          ).CSS.escape(id);
          const lab = doc.querySelector(`label[for="${esc}"]`);
          if (lab !== null) label = textOf(lab) || null;
        } catch {
          /* no label lookup for this field */
        }
      }
      if (label === null) {
        label = el.getAttribute("placeholder");
      }
      fields.push({
        name: el.getAttribute("name") ?? "",
        type,
        label: label !== null && label.trim() !== "" ? label.trim() : null,
        required: el.getAttribute("required") !== null,
      });
    }
    const submitEl =
      form.querySelector('button[type="submit"]') ??
      form.querySelector('input[type="submit"]') ??
      form.querySelector("button:not([type])");
    const submitText =
      submitEl !== null
        ? textOf(submitEl) || submitEl.getAttribute("value") || null
        : null;
    return {
      action: form.getAttribute("action"),
      method: form.getAttribute("method") ?? "get",
      fields,
      submit_text: submitText,
    };
  });

  const allButtons = toArray(
    doc.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    ),
  );
  if (allButtons.length > caps.maxButtons) truncated = true;
  const seen = new Set<string>();
  const buttons: string[] = [];
  for (const el of allButtons.slice(0, caps.maxButtons)) {
    const t =
      accessibleText(el) || (el.getAttribute("value") ?? "").trim().slice(0, 2000);
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    buttons.push(t);
  }

  return { title: doc.title, links, forms, buttons, truncated };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderFlowMapMarkdown(report: {
  run_id: string;
  url: string;
  pages: CrawledPage[];
  page_errors: Array<{ url: string; error: string }>;
  flows: DiscoveredFlow[];
  test_cases: ProposedTestCase[];
  truncated: Truncation;
  root_error?: string;
}): string {
  // Crawled titles/link text are untrusted — escape the table syntax or a
  // title containing "|" / newlines shreds every row after it.
  const cell = (s: string): string =>
    s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

  const lines: string[] = [
    `# Flow discovery — ${report.run_id}`,
    "",
    `Target: ${report.url}`,
    "",
  ];
  if (report.root_error !== undefined) {
    lines.push(`**FAILED**: ${report.root_error}`, "");
    return lines.join("\n");
  }

  lines.push("## Pages", "", "| URL | Title | Depth | Links | Forms |", "|---|---|---|---|---|");
  for (const p of report.pages) {
    lines.push(
      `| ${cell(p.url)} | ${cell(p.title) || "—"} | ${p.depth} | ${p.links.length} | ${p.forms.length} |`,
    );
  }
  lines.push("");

  lines.push(
    "## Proposed test cases",
    "",
    "| ID | Priority | Flow | Steps | Expected result | Destructive |",
    "|---|---|---|---|---|---|",
  );
  for (const tc of report.test_cases) {
    lines.push(
      `| ${tc.id} | ${tc.priority} | ${cell(tc.name)} | ${cell(tc.steps.join(" → "))} | ${cell(tc.expected_result)} | ${tc.destructive ? "⚠️ yes" : "no"} |`,
    );
  }
  lines.push("");

  const destructive = report.flows.filter((f) => f.destructive);
  if (destructive.length > 0) {
    lines.push(
      "## Destructive actions (flagged, NOT executed)",
      "",
      ...destructive.map((f) => `- ${cell(f.name)} — entry: ${cell(f.entry_url)}`),
      "",
    );
  }

  if (report.page_errors.length > 0) {
    lines.push(
      "## Page errors",
      "",
      ...report.page_errors.map((e) => `- ${e.url} — ${e.error}`),
      "",
    );
  }

  if (report.truncated.hit) {
    lines.push(
      "## Truncation",
      "",
      ...report.truncated.reasons.map((r) => `- ${r}`),
      "",
      "Raise `max_pages` / `max_depth` / `max_time_ms` to crawl further.",
      "",
    );
  }

  lines.push(
    "---",
    "",
    "Flow step sequences (verify-ready JSON) live in `flow-map.json` next to this file.",
    "",
  );
  return lines.join("\n");
}
