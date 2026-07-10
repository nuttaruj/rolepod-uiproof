import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import { SessionRegistry } from "../../src/session/SessionRegistry.js";

const EXAMPLE_URL = "https://example.com";

let tmpRoot: string;
let registry: SessionRegistry;
let engine: PlaywrightEngine;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-life-"));
  engine = new PlaywrightEngine();
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", engine);
});

afterAll(async () => {
  await registry.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!ONLINE)("open() failure does not leak a browser", () => {
  it("rejects when the initial navigation fails (closed port)", async () => {
    // Port 1 is never listening → goto rejects; the engine must close the
    // browser it launched rather than leak it.
    await expect(
      registry.open({ platform: "web", url: "http://127.0.0.1:1/", headless: true }),
    ).rejects.toBeDefined();
  });
});

describe.skipIf(!ONLINE)("closed pages are pruned from the session", () => {
  it("removes a closed popup and keeps activePageIndex valid", async () => {
    const session = await registry.open({ platform: "web", url: EXAMPLE_URL, headless: true });
    const page = engine.getPageForSession(session.id);
    const popup = await page.context().newPage();
    await popup.goto(EXAMPLE_URL);
    await delay(100); // let context "page" listener register the popup
    expect(engine.listPages(session.id).length).toBe(2);

    await popup.close();
    await delay(100); // let page "close" listener prune it
    const pages = engine.listPages(session.id);
    expect(pages.length).toBe(1);
    expect(pages[0]!.active).toBe(true);

    await registry.close({ id: session.id, platform: "web" });
  });
});

describe.skipIf(!ONLINE)("handle_dialog arms and returns immediately (non-wait)", () => {
  it("accepts the next confirm() without blocking and records last_dialog", async () => {
    const session = await registry.open({ platform: "web", url: EXAMPLE_URL, headless: true });
    const page = engine.getPageForSession(session.id);

    const armed = await engine.handleDialog(session.id, { action: "accept" });
    expect(armed.armed).toBe(true);

    const confirmed = await page.evaluate(
      () => (globalThis as unknown as { confirm(m: string): boolean }).confirm("proceed?"),
    );
    expect(confirmed).toBe(true); // armed accept → confirm() returns true

    // A follow-up call surfaces the handled dialog.
    const after = await engine.handleDialog(session.id, { action: "dismiss" });
    expect(after.last_dialog?.handled).toBe(true);
    expect(after.last_dialog?.message).toMatch(/proceed/);

    await registry.close({ id: session.id, platform: "web" });
  });
});
