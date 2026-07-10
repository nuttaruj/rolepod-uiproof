import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { auditA11yTool } from "../../src/tools/composite/audit_a11y.js";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import type { ToolContext } from "../../src/tools/types.js";

const EXAMPLE_URL = "https://example.com";
let tmpRoot: string;
let registry: SessionRegistry;
let store: ArtifactStore;
let ctx: ToolContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-scope-"));
  const engine = new PlaywrightEngine();
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", engine);
  store = new ArtifactStore({ rootDir: join(tmpRoot, "artifacts") });
  ctx = { registry, store };
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!ONLINE)("audit_a11y scope={ref}", () => {
  it("returns unknown_ref for a bogus ref", async () => {
    const handler = auditA11yTool.build(ctx);
    const result = await handler({
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      level: "wcag-aa",
      scope: { ref: "e999999" },
      report_format: "json",
      close_on_finish: true,
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe("unknown_ref");
  });
});
