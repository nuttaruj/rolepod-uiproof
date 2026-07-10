import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";

const dirs: string[] = [];
function freshDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `rolepod-mode-${tag}-`));
  dirs.push(d);
  return d;
}

describe("ArtifactStore — with-parent run dir uniqueness", () => {
  it("gives two same-skill runs distinct dirs via a uuid suffix", async () => {
    const store = new ArtifactStore({
      rootDir: freshDir("runid"),
      mode: "with-parent",
    });
    const a = await store.startRun("verify", { skill: "verify-ui" });
    const b = await store.startRun("verify", { skill: "verify-ui" });
    expect(a.runDir).not.toBe(b.runDir);
    // sortable prefix preserved, short uuid appended
    expect(a.runId).toMatch(/-rolepod-uiproof-verify-ui-[0-9a-f]{6}$/);
  });
});

describe("ArtifactStore — mode re-detection (SessionStart race)", () => {
  it("flips to with-parent when the marker appears after construction", async () => {
    const dir = freshDir("race");
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const store = new ArtifactStore(); // unpinned, standalone (no marker yet)
      expect(store.mode).toBe("standalone");

      // Parent's SessionStart hook writes the marker after the server booted.
      mkdirSync(join(dir, ".rolepod"), { recursive: true });
      writeFileSync(join(dir, ".rolepod", "parent-active"), "v1\n", "utf8");

      const run = await store.startRun("verify", { skill: "verify-ui" });
      expect(run.mode).toBe("with-parent");
      expect(store.mode).toBe("with-parent");
      expect(run.runDir).toContain(`${sep}.rolepod${sep}evidence${sep}`);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("does not re-detect when the store is pinned by an explicit rootDir", async () => {
    const dir = freshDir("pinned");
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const pinnedRoot = freshDir("pinned-root");
      const store = new ArtifactStore({ rootDir: pinnedRoot });
      mkdirSync(join(dir, ".rolepod"), { recursive: true });
      writeFileSync(join(dir, ".rolepod", "parent-active"), "v1\n", "utf8");
      const run = await store.startRun("verify", { skill: "verify-ui" });
      expect(store.mode).toBe("standalone");
      expect(run.runDir.startsWith(pinnedRoot)).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
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
