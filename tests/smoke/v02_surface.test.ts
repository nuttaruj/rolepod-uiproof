import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { auditA11yTool } from "../../src/tools/composite/audit_a11y.js";
import { extractUiStateTool } from "../../src/tools/composite/extract_ui_state.js";
import { scaffoldE2eTool } from "../../src/tools/composite/scaffold_e2e.js";
import { verifyUiFlowTool } from "../../src/tools/composite/verify_ui_flow.js";
import { visualDiffTool } from "../../src/tools/composite/visual_diff.js";
import { browserKeyTool } from "../../src/tools/atomic/browser_key.js";
import { browserNavigateTool } from "../../src/tools/atomic/browser_navigate.js";
import { browserOpenTool } from "../../src/tools/atomic/browser_open.js";
import { browserScreenshotTool } from "../../src/tools/atomic/browser_screenshot.js";
import { browserScrollTool } from "../../src/tools/atomic/browser_scroll.js";
import { browserWaitForTool } from "../../src/tools/atomic/browser_wait_for.js";
import { browserCloseTool } from "../../src/tools/atomic/browser_close.js";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import type { ToolContext } from "../../src/tools/types.js";

const EXAMPLE_URL = "https://example.com";
let tmpRoot: string;
let registry: SessionRegistry;
let store: ArtifactStore;
let ctx: ToolContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-v02-"));
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

// ---------------------------------------------------------------------------
// new atomic tools — surface check
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("new atomic tools", () => {
  it("browser_key + browser_scroll + browser_wait_for + browser_screenshot + browser_navigate work in sequence", async () => {
    const open = browserOpenTool.build(ctx);
    const opened = await open({ platform: "web", url: EXAMPLE_URL, headless: true });
    const sid = (opened.structuredContent as { session_id: string }).session_id;

    try {
      const press = browserKeyTool.build(ctx);
      const pressed = await press({ session_id: sid, key: "Tab" });
      expect((pressed.structuredContent as { pressed: boolean }).pressed).toBe(true);

      const scroll = browserScrollTool.build(ctx);
      const scrolled = await scroll({ session_id: sid, direction: "down", amount: 100 });
      expect((scrolled.structuredContent as { scrolled: boolean }).scrolled).toBe(true);

      const wait = browserWaitForTool.build(ctx);
      const waited = await wait({
        session_id: sid,
        condition: { kind: "text_visible", text: "Example Domain" },
        timeout_ms: 5000,
      });
      expect((waited.structuredContent as { matched: boolean }).matched).toBe(true);

      const shot = browserScreenshotTool.build(ctx);
      const shotResult = await shot({ session_id: sid, freeze_motion: false });
      expect((shotResult.structuredContent as { bytes: number }).bytes).toBeGreaterThan(
        1000,
      );

      const nav = browserNavigateTool.build(ctx);
      const navRes = await nav({ session_id: sid, url: EXAMPLE_URL });
      expect((navRes.structuredContent as { navigated: boolean }).navigated).toBe(true);
    } finally {
      const close = browserCloseTool.build(ctx);
      await close({ session_id: sid }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// audit_a11y — example.com is mostly clean but axe always returns a result
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("audit_a11y", () => {
  it("runs an axe audit and writes a report", async () => {
    const handler = auditA11yTool.build(ctx);
    const result = await handler({
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      level: "wcag-aa",
      scope: "page",
      report_format: "json",
      close_on_finish: true,
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as {
      run_id: string;
      counts: Record<string, number>;
      issues: unknown[];
      report_path: string;
    };
    expect(body.run_id).toMatch(/^audit_/);
    expect(body.counts).toMatchObject({
      critical: expect.any(Number),
      serious: expect.any(Number),
      moderate: expect.any(Number),
      minor: expect.any(Number),
    });
    expect(existsSync(body.report_path)).toBe(true);
  });

  // Note: v0.2 returned not_implemented_in_v02 for scope={ref}. v0.3
  // implements it. Positive + negative scope={ref} cases live in
  // tests/smoke/scope_ref.test.ts.
});

// ---------------------------------------------------------------------------
// visual_diff — first call seeds, second matches
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("visual_diff", () => {
  it("seeds a baseline on first call then diffs near-zero on second", async () => {
    const handler = visualDiffTool.build(ctx);
    const baselineId = `smoke-${Date.now()}`;
    const viewport = { width: 800, height: 600 };

    const first = await handler({
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      baseline_id: baselineId,
      viewport,
      threshold_pct: 0.05,
      pixel_threshold: 0.1,
      close_on_finish: true,
      settle: false,
    });
    const seed = first.structuredContent as {
      diff_pct: number;
      passed: boolean;
      note?: string;
    };
    expect(seed.passed).toBe(true);
    expect(seed.diff_pct).toBe(0);
    expect(seed.note).toMatch(/Baseline did not exist/);

    const second = await handler({
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      baseline_id: baselineId,
      viewport,
      threshold_pct: 0.05,
      pixel_threshold: 0.1,
      close_on_finish: true,
      settle: false,
    });
    const diff = second.structuredContent as {
      diff_pct: number;
      passed: boolean;
      diff_image_path: string;
    };
    expect(diff.passed).toBe(true);
    expect(diff.diff_pct).toBeLessThanOrEqual(0.05);
    expect(existsSync(diff.diff_image_path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scaffold_e2e — pure codegen, no browser
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("scaffold_e2e", () => {
  it("generates a playwright-test file from a scenario", async () => {
    const handler = scaffoldE2eTool.build(ctx);
    const result = await handler({
      framework: "playwright-test",
      scenario_nl: "user opens example and sees title",
      url: EXAMPLE_URL,
    });
    const body = result.structuredContent as {
      test_file_path: string;
      language: string;
      dependencies: string[];
    };
    expect(body.language).toBe("typescript");
    expect(body.dependencies).toContain("@playwright/test");
    expect(existsSync(body.test_file_path)).toBe(true);
    const code = readFileSync(body.test_file_path, "utf8");
    expect(code).toMatch(/@playwright\/test/);
    expect(code).toMatch(/await page\.goto\(/);
  });

  it("transcribes a replay bundle into runnable code", async () => {
    const bundlePath = join(tmpRoot, "replay-fixture.json");
    const bundle = {
      version: 1,
      run_id: "fixture",
      recorded_at: new Date().toISOString(),
      open: { platform: "web", url: EXAMPLE_URL },
      steps: [
        { kind: "navigate", url: EXAMPLE_URL },
        { kind: "click", query: "Learn more" },
      ],
      expect: [{ kind: "text_visible", text: "Example Domain" }],
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bundlePath, JSON.stringify(bundle));

    const handler = scaffoldE2eTool.build(ctx);
    const result = await handler({
      framework: "playwright-test",
      scenario_nl: "replay example",
      url: EXAMPLE_URL,
      recorded_bundle: bundlePath,
    });
    const body = result.structuredContent as {
      test_file_path: string;
      from_replay_bundle: boolean;
    };
    expect(body.from_replay_bundle).toBe(true);
    const code = readFileSync(body.test_file_path, "utf8");
    expect(code).toMatch(/Learn more/);
    expect(code).toMatch(/Example Domain/);
  });

  it("supports pytest+selenium", async () => {
    const handler = scaffoldE2eTool.build(ctx);
    const result = await handler({
      framework: "pytest+selenium",
      scenario_nl: "user opens example",
      url: EXAMPLE_URL,
    });
    const body = result.structuredContent as {
      language: string;
      test_file_path: string;
    };
    expect(body.language).toBe("python");
    const code = readFileSync(body.test_file_path, "utf8");
    expect(code).toMatch(/from selenium import webdriver/);
  });
});

// ---------------------------------------------------------------------------
// extract_ui_state
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("extract_ui_state", () => {
  it("returns matched subtree and refs for a question about the heading", async () => {
    const handler = extractUiStateTool.build(ctx);
    const result = await handler({
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      question_nl: "What is the page heading about example",
      close_on_finish: true,
    });
    const body = result.structuredContent as {
      matched_refs: string[];
      confidence: string;
      value: { name?: string; children?: unknown[]; role: string };
    };
    expect(body.matched_refs.length).toBeGreaterThan(0);
    expect(["high", "medium", "low"]).toContain(body.confidence);
    expect(body.value).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// verify_ui_flow mode='reproduce' + minimization
// ---------------------------------------------------------------------------

describe.skipIf(!ONLINE)("verify_ui_flow mode='reproduce' with minimization", () => {
  it("removes redundant steps and writes replay-minimized.json", async () => {
    const handler = verifyUiFlowTool.build(ctx);
    const result = await handler({
      mode: "reproduce",
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [
        { kind: "key", key: "Tab" },
        { kind: "key", key: "Tab" },
        { kind: "key", key: "Tab" },
      ],
      expect: [{ kind: "text_visible", text: "Example Domain" }],
      capture: ["screenshot"],
      close_on_finish: true,
      minimize: true,
    });
    const body = result.structuredContent as {
      passed: boolean;
      mode: string;
      minimized?: {
        original_step_count: number;
        minimized_step_count: number;
        steps_removed: number[];
        replay_bundle: string;
      };
    };
    expect(body.passed).toBe(true);
    expect(body.mode).toBe("reproduce");
    expect(body.minimized).toBeDefined();
    expect(body.minimized!.original_step_count).toBe(3);
    expect(body.minimized!.minimized_step_count).toBeLessThan(3);
    expect(existsSync(body.minimized!.replay_bundle)).toBe(true);
  });
});
