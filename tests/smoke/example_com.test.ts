import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { verifyUiFlowTool } from "../../src/tools/composite/verify_ui_flow.js";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import type { ToolContext } from "../../src/tools/types.js";

const EXAMPLE_URL = "https://example.com";

let tmpRoot: string;
let registry: SessionRegistry;
let store: ArtifactStore;
let ctx: ToolContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-smoke-"));
  const engine = new PlaywrightEngine();
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", engine);
  // Pin standalone so a stray .rolepod/ in the cwd can't flip run_id format.
  store = new ArtifactStore({ rootDir: join(tmpRoot, "artifacts"), mode: "standalone" });
  ctx = { registry, store };
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!ONLINE)("PlaywrightEngine — direct", () => {
  let leftoverSession: { id: string; platform: "web" } | null = null;

  afterEach(async () => {
    if (leftoverSession) {
      await registry.close(leftoverSession).catch(() => undefined);
      leftoverSession = null;
    }
  });

  it("opens example.com, snapshots, screenshots, closes", async () => {
    const session = await registry.open({ platform: "web", url: EXAMPLE_URL, headless: true });
    leftoverSession = { id: session.id, platform: "web" };

    const engine = registry.engineFor(session.id);
    const snap = await engine.snapshot({ id: session.id, platform: "web" });
    expect(snap.url_or_screen).toMatch(/example\.com/);
    expect(snap.tree.role).toBeTruthy();

    const flat = flattenNames(snap.tree);
    expect(flat.some((n) => /example domain/i.test(n))).toBe(true);
    expect(flat.some((n) => /learn more/i.test(n))).toBe(true);

    const shot = await engine.screenshot({ id: session.id, platform: "web" });
    expect(shot.byteLength).toBeGreaterThan(1000);
  });

  it("rejects platform='ios' in v0.1", async () => {
    await expect(
      registry.open({ platform: "ios", bundle_id: "com.example.app" }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
  });

  it("returns stale_ref when using a ref after a state change", async () => {
    const session = await registry.open({ platform: "web", url: EXAMPLE_URL, headless: true });
    leftoverSession = { id: session.id, platform: "web" };

    const engine = registry.engineFor(session.id);
    const snap = await engine.snapshot({ id: session.id, platform: "web" });
    const linkRef = findRefByName(snap.tree, /learn more/i);
    expect(linkRef).not.toBeNull();

    // bump generation via a no-op state change (navigate to same URL)
    await engine.navigate({ id: session.id, platform: "web" }, EXAMPLE_URL);
    await expect(
      engine.click({ id: session.id, platform: "web" }, linkRef!),
    ).rejects.toMatchObject({ code: "stale_ref" });
  });
});

describe.skipIf(!ONLINE)("verify_ui_flow — composite", () => {
  it("passes when expected text is on the page", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "assert",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [],
      expect: [
        { kind: "text_visible", text: "Example Domain" },
        { kind: "text_visible", text: "Learn more" },
      ],
      capture: ["screenshot"],
      close_on_finish: true,
      minimize: false,
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.passed).toBe(true);
    expect(body.run_id).toMatch(/^verify_/);
    const evidence = body.evidence_paths as { screenshots: string[]; replay_bundle?: string };
    expect(evidence.screenshots.length).toBeGreaterThan(0);
    expect(evidence.replay_bundle).toMatch(/replay\.json$/);
  });

  it("fails on a missing-text assertion with a clear reason", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "assert",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [],
      expect: [{ kind: "text_visible", text: "this string does not appear" }],
      capture: ["screenshot"],
      close_on_finish: true,
      minimize: false,
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.passed).toBe(false);
    expect(String(body.failure_reason)).toMatch(/this string does not appear/);
  });

  it("assert mode with an empty expect fails instead of silently passing", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "assert",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [],
      expect: [],
      capture: ["screenshot"],
      close_on_finish: true,
      minimize: false,
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.passed).toBe(false);
    expect(String(body.failure_reason)).toMatch(/no expectations/i);
  });

  it("wait_for ref_exists resolves a non-button element (role-agnostic)", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "assert",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      // "Example Domain" is an <h1>, not a button — the old button-only
      // ref_exists would time out here.
      steps: [{ kind: "wait_for", condition: { kind: "ref_exists", query: "Example Domain" } }],
      expect: [{ kind: "text_visible", text: "Example Domain" }],
      capture: ["screenshot"],
      close_on_finish: true,
      minimize: false,
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.passed).toBe(true);
  });

  it("mode='reproduce' minimize=false runs without minimization metadata", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "reproduce",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [],
      expect: [{ kind: "text_visible", text: "Example Domain" }],
      close_on_finish: true,
      minimize: false,
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.mode).toBe("reproduce");
    expect(body.passed).toBe(true);
    expect(body.minimized).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function flattenNames(node: { name?: string; children?: unknown[] }): string[] {
  const out: string[] = [];
  const visit = (n: { name?: string; children?: unknown[] }) => {
    if (n.name) out.push(n.name);
    if (n.children) {
      for (const c of n.children as Array<{ name?: string; children?: unknown[] }>) {
        visit(c);
      }
    }
  };
  visit(node);
  return out;
}

function findRefByName(
  node: { ref: string; name?: string; children?: unknown[] },
  re: RegExp,
): string | null {
  if (node.name && re.test(node.name)) return node.ref;
  if (node.children) {
    for (const c of node.children as Array<{
      ref: string;
      name?: string;
      children?: unknown[];
    }>) {
      const hit = findRefByName(c, re);
      if (hit) return hit;
    }
  }
  return null;
}
