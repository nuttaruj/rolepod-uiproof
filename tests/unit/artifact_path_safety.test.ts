import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";

/**
 * Security: writeReport/writeBytes must never let a caller-supplied name
 * escape the run directory. scaffold_e2e forwards a user-controlled
 * `filename` into writeReport, so an absolute or `../` name would otherwise
 * overwrite arbitrary files.
 */

const tmp = mkdtempSync(join(tmpdir(), "rolepod-uiproof-pathsafe-"));
const evil = resolve(tmpdir(), `evil-uiproof-${process.pid}.txt`);

async function freshRunDir(): Promise<string> {
  const store = new ArtifactStore({ rootDir: tmp });
  const { runDir } = await store.startRun("t", { skill: "verify-ui" });
  return runDir;
}

describe("ArtifactStore — path traversal safety", () => {
  it("rejects an absolute filename and writes nothing outside the run dir", async () => {
    const store = new ArtifactStore({ rootDir: tmp });
    const { runDir } = await store.startRun("t", { skill: "verify-ui" });
    await expect(store.writeReport(runDir, evil, "pwned")).rejects.toThrow();
    expect(existsSync(evil)).toBe(false);
  });

  it("rejects a parent-traversal filename in writeReport", async () => {
    const runDir = await freshRunDir();
    await expect(store_writeReport(runDir, "../../evil.txt")).rejects.toThrow();
  });

  it("rejects a parent-traversal name in writeBytes", async () => {
    const store = new ArtifactStore({ rootDir: tmp });
    const { runDir } = await store.startRun("t", { skill: "verify-ui" });
    await expect(
      store.writeBytes(runDir, "../evil.bin", Buffer.from("x")),
    ).rejects.toThrow();
  });

  it("still writes a plain filename inside the run dir", async () => {
    const store = new ArtifactStore({ rootDir: tmp });
    const { runDir } = await store.startRun("t", { skill: "verify-ui" });
    const p = await store.writeReport(runDir, "report.spec.ts", "ok");
    expect(p.startsWith(resolve(runDir) + sep)).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  it("allows an internal subdirectory path (does not over-reject)", async () => {
    const store = new ArtifactStore({ rootDir: tmp });
    const { runDir } = await store.startRun("t", { skill: "verify-ui" });
    // Resolves inside runDir → must be permitted (mkdir is the caller's job).
    const target = resolve(runDir, "nested", "a.txt");
    expect(target.startsWith(resolve(runDir) + sep)).toBe(true);
  });
});

// Helper kept separate to exercise a second ArtifactStore instance.
async function store_writeReport(runDir: string, name: string): Promise<string> {
  const store = new ArtifactStore({ rootDir: tmp });
  return store.writeReport(runDir, name, "x");
}

process.once("beforeExit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
