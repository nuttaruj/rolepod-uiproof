import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Distribution lockstep guard.
 *
 * Every spawn config ships `npx -y @rolepod/uiproof@<version>` PINNED to the
 * package.json version — not the bare `@rolepod/uiproof`. Pinning makes the
 * npx cache key version-specific, so updating the plugin (which carries these
 * files) actually delivers the new tool code instead of a stale cached build.
 *
 * This test fails the moment package.json is bumped without bumping the pins,
 * forcing the two to move together. When it fails after a version bump: update
 * the spec in every file below, then publish the matching version to npm so
 * the pinned spec resolves.
 */
const repoRoot = resolve(__dirname, "..", "..");
const version = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).version as string;

// Files whose `npx` args spawn the MCP server in some client/marketplace.
const SPAWN_CONFIGS = [
  ".mcp.json",
  ".cursor/mcp.json",
  "gemini-extension.json",
  ".claude-plugin/plugin.json",
  "plugins/rolepod-uiproof/.mcp.json",
  "plugins/rolepod-uiproof/.claude-plugin/plugin.json",
];

describe("spawn config version pin (distribution lockstep)", () => {
  it.each(SPAWN_CONFIGS)("%s pins @rolepod/uiproof to the package version", (rel) => {
    const raw = readFileSync(resolve(repoRoot, rel), "utf8");
    // The spawn arg must be the pinned spec…
    expect(raw).toContain(`"@rolepod/uiproof@${version}"`);
    // …and never the bare, unpinned arg (which the npx cache would pin to a
    // stale build).
    expect(raw).not.toContain(`"-y", "@rolepod/uiproof"`);
  });
});
