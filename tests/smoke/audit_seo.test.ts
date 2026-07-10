import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { auditSeoTool } from "../../src/tools/composite/audit_seo.js";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import type { ToolContext } from "../../src/tools/types.js";

let tmpRoot: string;
let registry: SessionRegistry;
let ctx: ToolContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-seo-"));
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
  ctx = {
    registry,
    store: new ArtifactStore({ rootDir: join(tmpRoot, "artifacts"), mode: "standalone" }),
  };
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!ONLINE)("audit_seo — status capture + render", () => {
  it("captures HTTP status and final URL for a real page", async () => {
    const handler = auditSeoTool.build(ctx);
    const result = await handler({
      url: "https://example.com",
      browser: "chromium",
      report_format: "json",
      close_on_finish: true,
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.http_status).toBe(200);
    expect(String(body.final_url)).toMatch(/example\.com/);
    // example.com has no meta description → the audit produces findings, not a
    // false clean pass, and it is not blocked by an http_status finding.
    expect(Array.isArray(body.findings)).toBe(true);
    expect((body.findings as unknown[]).some((f) => (f as { check: string }).check === "http_status")).toBe(false);
  });
});
