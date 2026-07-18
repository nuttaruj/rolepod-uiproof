import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Single-version invariant. package.json, every plugin/marketplace manifest,
 * SERVER_VERSION, and every `@rolepod/uiproof@<v>` spawn pin (configs + README)
 * must all read the same version. This catches the split that shipped once
 * (npm `0.10.0` vs plugin `0.12.0`).
 */

const repoRoot = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");
const version = JSON.parse(read("package.json")).version as string;

const MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/marketplace.json",
  "gemini-extension.json",
  "plugins/rolepod-uiproof/.claude-plugin/plugin.json",
  "plugins/rolepod-uiproof/.codex-plugin/plugin.json",
];

// Files that carry `@rolepod/uiproof@<v>` pinned spawn specs.
// NOTE: the root .mcp.json is intentionally absent — inside this repo the
// dev server runs the local build (`node dist/bin/…`), because `npm exec`
// treats an npx spec matching the repo's own name@version as "already
// installed" and never fetches it, so a pinned spawn can't work here.
const PIN_FILES = [
  ".cursor/mcp.json",
  "gemini-extension.json",
  ".claude-plugin/plugin.json",
  "plugins/rolepod-uiproof/.mcp.json",
  "plugins/rolepod-uiproof/.claude-plugin/plugin.json",
  "README.md",
];

describe("version lockstep", () => {
  it.each(MANIFESTS)("%s declares the package version", (rel) => {
    const raw = read(rel);
    expect(raw).toContain(`"version": "${version}"`);
    // no stale version left behind
    expect(raw).not.toMatch(/"version":\s*"0\.1[0-2]\.0"/);
  });

  it("SERVER_VERSION matches package.json", () => {
    expect(read("src/server.ts")).toContain(
      `SERVER_VERSION = "${version}"`,
    );
  });

  it.each(PIN_FILES)("%s pins @rolepod/uiproof to the package version", (rel) => {
    const raw = read(rel);
    const pins = raw.match(/@rolepod\/uiproof@[0-9]+\.[0-9]+\.[0-9]+/g) ?? [];
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin).toBe(`@rolepod/uiproof@${version}`);
    }
  });
});
