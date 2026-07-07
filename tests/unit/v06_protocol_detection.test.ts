import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRolepodParent } from "../../src/util/rolepodProtocol.js";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";

/**
 * Unit tests for the v0.6.1 marker-file detection mechanism.
 *
 * Each test runs inside a fresh tmpdir that is initialized as a real git
 * repo (so `git rev-parse --show-toplevel` returns the tmpdir itself
 * instead of bubbling up to the project's git root and writing into our
 * actual `.rolepod/` directory).
 */

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  // Resolve symlinks (macOS /var → /private/var) so the value matches what
  // `process.cwd()` returns after `chdir` and what `git rev-parse` reports.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "rolepod-uiproof-v061-")));
  // git init so `git rev-parse --show-toplevel` resolves to tmp itself.
  execSync("git init -q", { cwd: tmp });
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("detectRolepodParent", () => {
  it("returns active=false when no marker file", () => {
    const result = detectRolepodParent();
    expect(result.active).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.gitRoot).toBe(tmp);
  });

  it("returns active=true with protocol when marker exists", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");

    const result = detectRolepodParent();
    expect(result.active).toBe(true);
    expect(result.protocol).toBe("v1");
    expect(result.gitRoot).toBe(tmp);
  });

  it("reads first trimmed line when marker has multiple lines", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(
      join(tmp, ".rolepod", "parent-active"),
      "v1\nextra-metadata-ignored\n",
    );

    const result = detectRolepodParent();
    expect(result.protocol).toBe("v1");
  });

  it("strips trailing whitespace from protocol value", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "  v1  \n");

    const result = detectRolepodParent();
    expect(result.protocol).toBe("v1");
  });

  it("returns protocol verbatim when not v1 (caller handles mismatch warn)", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v2\n");

    const result = detectRolepodParent();
    expect(result.active).toBe(true);
    expect(result.protocol).toBe("v2");
  });

  it("resolves git root from a subdirectory", () => {
    const sub = join(tmp, "deep", "nested");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");

    const result = detectRolepodParent(sub);
    expect(result.active).toBe(true);
    expect(result.gitRoot).toBe(tmp); // not `sub`
  });

  it("falls back to cwd when not in a git work tree", () => {
    // Remove .git so `git rev-parse --show-toplevel` fails.
    rmSync(join(tmp, ".git"), { recursive: true, force: true });

    const result = detectRolepodParent(tmp);
    expect(result.active).toBe(false);
    expect(result.gitRoot).toBe(tmp); // cwd fallback
  });
});

describe("ArtifactStore integration with marker", () => {
  it("uses standalone path when no marker", async () => {
    const store = new ArtifactStore();
    expect(store.mode).toBe("standalone");
    expect(store.rootDir).toBe(resolve(tmp, ".rolepod-uiproof", "artifacts"));

    const run = await store.startRun("test", { skill: "verify-ui" });
    expect(run.mode).toBe("standalone");
    expect(run.runDir.startsWith(resolve(tmp, ".rolepod-uiproof", "artifacts"))).toBe(true);
    // Standalone uses prefix_ts_uuid format.
    expect(run.runId).toMatch(/^test_\d+T\d+_[0-9a-f]+$/);
  });

  it("uses with-parent path under git root when marker exists", async () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");

    const store = new ArtifactStore();
    expect(store.mode).toBe("with-parent");
    expect(store.rootDir).toBe(resolve(tmp, ".rolepod", "evidence"));

    const run = await store.startRun("test", { skill: "verify-ui" });
    expect(run.mode).toBe("with-parent");
    expect(run.runDir).toBe(
      resolve(tmp, ".rolepod", "evidence", run.runId),
    );
    // With-parent uses ts-rolepod-uiproof-{skill}-{uuid6}; the uuid keeps
    // same-second same-skill runs from clobbering each other's evidence.
    expect(run.runId).toMatch(/^\d+T\d+-rolepod-uiproof-verify-ui-[0-9a-f]{6}$/);
  });

  it("anchors with-parent path at git root even when constructed from a subdir", async () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");
    const sub = join(tmp, "deep", "nested");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);

    const store = new ArtifactStore();
    expect(store.mode).toBe("with-parent");
    // Critical assertion — must land at git root, not subdir cwd.
    expect(store.rootDir).toBe(resolve(tmp, ".rolepod", "evidence"));
  });

  it("baseline dir stays at standalone path even in with-parent mode", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");

    const store = new ArtifactStore();
    // Baselines are config, not evidence — should not move to .rolepod tree.
    expect(store.baselineDir).toBe(
      resolve(tmp, ".rolepod-uiproof", "baselines"),
    );
  });

  it("explicit opts.mode overrides marker detection", () => {
    mkdirSync(join(tmp, ".rolepod"), { recursive: true });
    writeFileSync(join(tmp, ".rolepod", "parent-active"), "v1\n");

    const store = new ArtifactStore({ mode: "standalone" });
    expect(store.mode).toBe("standalone");
    expect(store.rootDir).toBe(resolve(tmp, ".rolepod-uiproof", "artifacts"));
  });
});
