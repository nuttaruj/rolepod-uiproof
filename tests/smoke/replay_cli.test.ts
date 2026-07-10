import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleComReachable } from "./_net.js";
const ONLINE = await exampleComReachable();
import { runReplay } from "../../src/cli/replay.js";

const EXAMPLE_URL = "https://example.com";
let tmpRoot: string;
let bundlePath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolepod-uiproof-replay-"));
  bundlePath = join(tmpRoot, "replay.json");
  writeFileSync(
    bundlePath,
    JSON.stringify({
      version: 1,
      run_id: "fixture",
      recorded_at: new Date().toISOString(),
      open: { platform: "web", url: EXAMPLE_URL, headless: true },
      steps: [],
      expect: [{ kind: "text_visible", text: "Example Domain" }],
    }),
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!ONLINE)("rolepod-uiproof replay", () => {
  it("exits 0 on a passing replay bundle", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runReplay(bundlePath);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    const out = chunks.join("");
    expect(out).toMatch(/"passed":\s*true/);
  });
});
