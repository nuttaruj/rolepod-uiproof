import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";

/**
 * A headless session must NOT announce `HeadlessChrome/` — production edge
 * rules 403 on it (observed on a Plesk/nginx wp-admin POST, 2026-09-04).
 * Asserted at the wire, against a local server that records the request
 * headers, so it covers what the target actually sees rather than
 * `navigator.userAgent`. An explicit `user_agent` must still win.
 */

let server: Server;
let baseUrl: string;
let registry: SessionRegistry;
const seen: Array<Record<string, string | string[] | undefined>> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>ua</title><h1>ua probe</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  registry = new SessionRegistry({ idleTimeoutMs: 0 });
  registry.register("web", new PlaywrightEngine());
});

afterAll(async () => {
  await registry.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("default user agent (headless chromium)", () => {
  it("presents the headed Chrome UA on the wire, version intact", async () => {
    seen.length = 0;
    const session = await registry.open({ platform: "web", url: `${baseUrl}/default`, headless: true });
    try {
      const ua = String(seen[0]?.["user-agent"] ?? "");
      expect(ua).not.toContain("HeadlessChrome/");
      expect(ua).toMatch(/ Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/);
      expect(ua).toMatch(/^Mozilla\/5\.0 \(/);
    } finally {
      await registry.close(session);
    }
  });

  it("honours an explicit user_agent verbatim", async () => {
    seen.length = 0;
    const session = await registry.open({
      platform: "web",
      url: `${baseUrl}/explicit`,
      headless: true,
      user_agent: "rolepod-uiproof-probe/1.0 HeadlessChrome/0.0.0.0",
    });
    try {
      expect(seen[0]?.["user-agent"]).toBe("rolepod-uiproof-probe/1.0 HeadlessChrome/0.0.0.0");
    } finally {
      await registry.close(session);
    }
  });
});
