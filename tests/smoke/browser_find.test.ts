import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { browserClickTool } from "../../src/tools/atomic/browser_click.js";
import { browserCloseTool } from "../../src/tools/atomic/browser_close.js";
import { browserFindTool } from "../../src/tools/atomic/browser_find.js";
import { browserOpenTool } from "../../src/tools/atomic/browser_open.js";
import { browserWaitForTool } from "../../src/tools/atomic/browser_wait_for.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * `browser_find` and `wait_for { ref_exists }` exist so the Lead can act on an
 * element WITHOUT a full snapshot. The contract that matters is therefore
 * not just "returns refs" but "the returned ref is clickable next" — a ref
 * that comes back stale or unknown would cost the snapshot anyway.
 */

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Plugins</title></head>
<body>
  <nav><a href="#">Installed Plugins</a><a href="#">Add New</a></nav>
  <h1>Add Plugins</h1>
  <p>Install Now is available for every result below.</p>
  <a href="#" id="details">Install Now (details)</a>
  <button id="install" onclick="document.getElementById('out').textContent='installed-ok'">Install Now</button>
  <button id="replace">Replace current with uploaded</button>
  <input aria-label="Search plugins" />
  <p id="out"></p>
</body></html>`;

let tmpRoot: string;
let fixtureUrl: string;
let ctx: ToolContext;
let sessionId: string;

type Body = Record<string, unknown>;
const body = (r: { structuredContent?: unknown }) => r.structuredContent as Body;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-find-"));
  const file = join(tmpRoot, "plugins.html");
  writeFileSync(file, HTML, "utf8");
  fixtureUrl = pathToFileURL(file).href;
  const registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
  ctx = {
    registry,
    store: new ArtifactStore({ rootDir: join(tmpRoot, "artifacts"), mode: "standalone" }),
  };
  const opened = body(await browserOpenTool.build(ctx)({ platform: "web", url: fixtureUrl, headless: true }));
  sessionId = String(opened.session_id);
});

afterAll(async () => {
  await browserCloseTool.build(ctx)({ session_id: sessionId }).catch(() => undefined);
  await ctx.registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("browser_find", () => {
  it("ranks the exact button first, reports substring hits, and the ref clicks", async () => {
    const find = browserFindTool.build(ctx);
    const res = body(await find({ session_id: sessionId, query: "Install Now", limit: 10 }));
    const matches = res.matches as Array<{ ref: string; role: string; name?: string; exact: boolean }>;
    expect(matches[0]).toMatchObject({ role: "button", name: "Install Now", exact: true });
    expect(matches.some((m) => m.role === "link" && m.exact === false)).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.truncated).toBe(false);
    expect(res.hint).toBeUndefined();

    // The whole point: act on the ref with no snapshot in between.
    const clicked = await browserClickTool.build(ctx)({ session_id: sessionId, ref: matches[0]!.ref });
    expect(clicked.isError).not.toBe(true);
    const waited = body(
      await browserWaitForTool.build(ctx)({
        session_id: sessionId,
        condition: { kind: "text_visible", text: "installed-ok" },
      }),
    );
    expect(waited.matched).toBe(true);
    expect(waited.matches).toBeUndefined();
  });

  it("filters by role and truncates to limit while keeping the total", async () => {
    const find = browserFindTool.build(ctx);
    const links = body(await find({ session_id: sessionId, query: "install now", role: "link", limit: 10 }));
    const linkMatches = links.matches as Array<{ role: string }>;
    expect(linkMatches).toHaveLength(1);
    expect(linkMatches[0]!.role).toBe("link");

    const capped = body(await find({ session_id: sessionId, query: "Install", limit: 1 }));
    expect((capped.matches as unknown[]).length).toBe(1);
    expect(capped.truncated).toBe(true);
    expect(Number(capped.total)).toBeGreaterThan(1);
  });

  it("returns an empty list plus a hint when nothing matches", async () => {
    const res = body(await browserFindTool.build(ctx)({ session_id: sessionId, query: "Deactivate", limit: 10 }));
    expect(res.matches).toEqual([]);
    expect(res.total).toBe(0);
    expect(String(res.hint)).toMatch(/browser_snapshot/);
  });
});

describe("browser_wait_for ref_exists", () => {
  it("returns fresh matches for the query and the ref is clickable next", async () => {
    const waited = body(
      await browserWaitForTool.build(ctx)({
        session_id: sessionId,
        condition: { kind: "ref_exists", query: "Replace current with uploaded" },
      }),
    );
    expect(waited.matched).toBe(true);
    const matches = waited.matches as Array<{ ref: string; role: string; name?: string }>;
    expect(matches[0]).toMatchObject({ role: "button", name: "Replace current with uploaded" });
    const clicked = await browserClickTool.build(ctx)({ session_id: sessionId, ref: matches[0]!.ref });
    expect(clicked.isError).not.toBe(true);
  });
});
