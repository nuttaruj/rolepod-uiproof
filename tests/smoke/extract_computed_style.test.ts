import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { browserScreenshotTool } from "../../src/tools/atomic/browser_screenshot.js";
import { extractComputedStyleTool } from "../../src/tools/atomic/extract_computed_style.js";
import type { ToolContext } from "../../src/tools/types.js";

const FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  body{margin:0}
  #target{
    color: rgb(255, 0, 0);
    font-size: 32px;
    font-weight: 700;
    padding: 10px 20px;
    width: 150px;
    height: 60px;
    background-color: rgb(0, 128, 0);
    border-radius: 8px;
  }
</style></head>
<body><div id="target">hi</div></body>
</html>`;

let tmpRoot: string;
let fixtureUrl: string;
let registry: SessionRegistry;
let store: ArtifactStore;
let ctx: ToolContext;
let sessionId: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-style-"));
  const fixturePath = join(tmpRoot, "styled.html");
  writeFileSync(fixturePath, FIXTURE_HTML, "utf8");
  fixtureUrl = pathToFileURL(fixturePath).href;

  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
  store = new ArtifactStore({ rootDir: join(tmpRoot, "artifacts"), mode: "standalone" });
  ctx = { registry, store };

  const session = await registry.open({ platform: "web", url: fixtureUrl, headless: true });
  sessionId = session.id;
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("extract_computed_style", () => {
  it("reads the computed CSS + bounding box of a matched element", async () => {
    const handler = extractComputedStyleTool.build(ctx);
    const result = await handler({ session_id: sessionId, selector: "#target" });

    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as {
      match_count: number;
      styles: Record<string, string>;
      box: { width: number; height: number };
    };
    expect(body.match_count).toBe(1);
    expect(body.styles.color).toBe("rgb(255, 0, 0)");
    expect(body.styles["font-size"]).toBe("32px");
    expect(body.styles["font-weight"]).toBe("700");
    expect(body.styles["background-color"]).toBe("rgb(0, 128, 0)");
    expect(body.styles["border-radius"]).toBe("8px");
    // getBoundingClientRect includes padding: 150 + 20*2 wide, 60 + 10*2 tall.
    expect(body.box.width).toBeCloseTo(190, 0);
    expect(body.box.height).toBeCloseTo(80, 0);
  });

  it("honours an explicit `css_properties` subset", async () => {
    const handler = extractComputedStyleTool.build(ctx);
    const result = await handler({
      session_id: sessionId,
      selector: "#target",
      css_properties: ["color", "font-size"],
    });
    const body = result.structuredContent as { styles: Record<string, string> };
    expect(Object.keys(body.styles).sort()).toEqual(["color", "font-size"]);
  });

  it("returns invalid_input when the selector matches nothing", async () => {
    const handler = extractComputedStyleTool.build(ctx);
    const result = await handler({ session_id: sessionId, selector: "#does-not-exist" });
    expect(result.isError).toBe(true);
    const body = result.structuredContent as { code: string };
    expect(body.code).toBe("invalid_input");
  });
});

describe("browser_screenshot — element + dimensions", () => {
  it("captures a single element via selector and reports its size", async () => {
    const handler = browserScreenshotTool.build(ctx);
    const result = await handler({
      session_id: sessionId,
      selector: "#target",
      freeze_motion: true,
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as {
      width: number;
      height: number;
      bytes: number;
    };
    expect(body.bytes).toBeGreaterThan(100);
    // #target: 150×60 content + 20/10 padding → 190×80 bounding box.
    expect(body.width).toBe(190);
    expect(body.height).toBe(80);
  });

  it("full-page capture reports non-undefined dimensions", async () => {
    const handler = browserScreenshotTool.build(ctx);
    const result = await handler({
      session_id: sessionId,
      full_page: false,
      freeze_motion: false,
    });
    const body = result.structuredContent as { width: number; height: number };
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
  });

  it("returns invalid_input when a selector matches nothing", async () => {
    const handler = browserScreenshotTool.build(ctx);
    const result = await handler({
      session_id: sessionId,
      selector: "#does-not-exist",
      freeze_motion: false,
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe("invalid_input");
  });
});
