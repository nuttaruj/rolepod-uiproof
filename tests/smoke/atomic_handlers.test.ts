import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { browserOpenTool } from "../../src/tools/atomic/browser_open.js";
import { browserSnapshotTool } from "../../src/tools/atomic/browser_snapshot.js";
import { browserClickTool } from "../../src/tools/atomic/browser_click.js";
import { browserTypeTool } from "../../src/tools/atomic/browser_type.js";
import { browserKeyTool } from "../../src/tools/atomic/browser_key.js";
import { browserScreenshotTool } from "../../src/tools/atomic/browser_screenshot.js";
import { browserConsoleTool } from "../../src/tools/atomic/browser_console.js";
import { browserNetworkTool } from "../../src/tools/atomic/browser_network.js";
import { browserEvaluateTool } from "../../src/tools/atomic/browser_evaluate.js";
import { browserSetEnvTool } from "../../src/tools/atomic/browser_set_env.js";
import { browserPagesTool } from "../../src/tools/atomic/browser_pages.js";
import { extractComputedStyleTool } from "../../src/tools/atomic/extract_computed_style.js";
import { browserCloseTool } from "../../src/tools/atomic/browser_close.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Handler-level coverage for the atomic tools that previously had none — driven
 * against a LOCAL file:// fixture so it runs deterministically offline (no
 * example.com dependency). Chromium is bundled, so this needs no network.
 */

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>#box{color:rgb(10,20,30)}</style></head>
<body>
  <h1>Fixture Page</h1>
  <button id="btn">Click Me</button>
  <input id="name" aria-label="Full name" />
  <p id="box">Styled Box</p>
  <script>console.log("fixture-console-marker");</script>
</body></html>`;

let tmpRoot: string;
let fixtureUrl: string;
let registry: SessionRegistry;
let ctx: ToolContext;

// ROLEPOD_ALLOW_EVAL gate for the evaluate handler.
const prevEval = process.env.ROLEPOD_ALLOW_EVAL;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-atomic-"));
  const file = join(tmpRoot, "fixture.html");
  writeFileSync(file, HTML, "utf8");
  fixtureUrl = pathToFileURL(file).href;
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
  ctx = {
    registry,
    store: new ArtifactStore({ rootDir: join(tmpRoot, "artifacts"), mode: "standalone" }),
  };
  process.env.ROLEPOD_ALLOW_EVAL = "1";
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevEval === undefined) delete process.env.ROLEPOD_ALLOW_EVAL;
  else process.env.ROLEPOD_ALLOW_EVAL = prevEval;
});

function body(r: { isError?: boolean; structuredContent?: unknown }): Record<string, unknown> {
  expect(r.isError).not.toBe(true);
  return r.structuredContent as Record<string, unknown>;
}

function findRef(tree: unknown, pred: (n: Record<string, unknown>) => boolean): string | null {
  const n = tree as Record<string, unknown>;
  if (pred(n)) return n.ref as string;
  for (const c of (n.children as unknown[]) ?? []) {
    const hit = findRef(c, pred);
    if (hit) return hit;
  }
  return null;
}

describe("atomic tool handlers — offline fixture", () => {
  it("drives open → snapshot → interact → observe → close without network", async () => {
    const open = body(await browserOpenTool.build(ctx)({ platform: "web", url: fixtureUrl, headless: true } as never));
    const sessionId = open.session_id as string;
    expect(sessionId).toBeTruthy();

    const snap = body(await browserSnapshotTool.build(ctx)({ session_id: sessionId } as never));
    const tree = snap.tree;
    const inputRef = findRef(tree, (n) => String(n.role).includes("textbox") || String(n.name).includes("Full name"));
    const btnRef = findRef(tree, (n) => String(n.role).includes("button") || String(n.name).includes("Click Me"));
    expect(inputRef).toBeTruthy();
    expect(btnRef).toBeTruthy();

    // interaction handlers
    body(await browserTypeTool.build(ctx)({ session_id: sessionId, ref: inputRef!, text: "Ada" } as never));
    body(await browserKeyTool.build(ctx)({ session_id: sessionId, key: "Tab" } as never));
    // re-snapshot after DOM-mutating type() before clicking (refs invalidated)
    const snap2 = body(await browserSnapshotTool.build(ctx)({ session_id: sessionId } as never));
    const btnRef2 = findRef(snap2.tree, (n) => String(n.name).includes("Click Me"));
    body(await browserClickTool.build(ctx)({ session_id: sessionId, ref: btnRef2! } as never));

    // observation handlers
    body(await browserScreenshotTool.build(ctx)({ session_id: sessionId } as never));
    const consoleRes = body(await browserConsoleTool.build(ctx)({ session_id: sessionId, levels: ["log"] } as never));
    expect(JSON.stringify(consoleRes)).toMatch(/fixture-console-marker/);
    body(await browserNetworkTool.build(ctx)({ session_id: sessionId } as never));
    body(await browserPagesTool.build(ctx)({ session_id: sessionId } as never));

    const evalRes = body(await browserEvaluateTool.build(ctx)({ session_id: sessionId, script: "return 1 + 1;" } as never));
    expect(JSON.stringify(evalRes)).toMatch(/2/);

    const styleRes = body(await extractComputedStyleTool.build(ctx)({ session_id: sessionId, selector: "#box", properties: ["color"] } as never));
    expect(JSON.stringify(styleRes)).toMatch(/rgb\(10, 20, 30\)/);

    body(await browserSetEnvTool.build(ctx)({ session_id: sessionId, viewport: { width: 800, height: 600 } } as never));

    body(await browserCloseTool.build(ctx)({ session_id: sessionId } as never));
  });
});
