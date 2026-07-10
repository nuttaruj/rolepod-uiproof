import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRolepodParent } from "../../src/util/rolepodProtocol.js";

/**
 * The parent marker is read at boot inside buildServer before any tool
 * registers. An unreadable marker (a directory → EISDIR, or no read perm →
 * EACCES) must degrade to standalone, not crash the whole server. The tmp
 * dirs below are not git repos, so gitRoot falls back to the passed cwd and
 * the marker lookup is fully controlled.
 */

const dirs: string[] = [];
function freshDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `rolepod-marker-${tag}-`));
  dirs.push(d);
  return d;
}

describe("detectRolepodParent — marker robustness", () => {
  it("degrades to standalone when the marker is a directory (EISDIR)", () => {
    const dir = freshDir("eisdir");
    mkdirSync(join(dir, ".rolepod", "parent-active"), { recursive: true });
    const state = detectRolepodParent(dir);
    expect(state.active).toBe(false);
    expect(state.protocol).toBeNull();
  });

  it("reads a valid marker file", () => {
    const dir = freshDir("ok");
    mkdirSync(join(dir, ".rolepod"), { recursive: true });
    writeFileSync(join(dir, ".rolepod", "parent-active"), "v1\n", "utf8");
    const state = detectRolepodParent(dir);
    expect(state.active).toBe(true);
    expect(state.protocol).toBe("v1");
  });

  it("is inactive when no marker exists", () => {
    const dir = freshDir("none");
    const state = detectRolepodParent(dir);
    expect(state.active).toBe(false);
    expect(state.protocol).toBeNull();
  });
});

process.once("beforeExit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
