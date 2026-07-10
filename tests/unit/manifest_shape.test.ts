import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest, ROLEPOD_PROTOCOL_VERSION } from "../../src/util/manifest.js";

describe("writeManifest (Extension Protocol v1)", () => {
  it("emits the v1 shape the parent check-work skill parses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolepod-manifest-"));
    const p = await writeManifest({
      runDir: dir,
      skill: "verify-ui",
      phase: "verify",
      status: "pass",
      summary: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      artifacts: [{ type: "screenshot", path: "/x/final.png" }],
      metadata: { url: "https://x" },
    });
    expect(p).toBeDefined();
    const m = JSON.parse(readFileSync(p!, "utf8")) as Record<string, unknown>;
    expect(m.protocol).toBe(ROLEPOD_PROTOCOL_VERSION);
    expect(m.plugin).toBe("rolepod-uiproof");
    expect(m.skill).toBe("verify-ui");
    expect(m.phase).toBe("verify");
    expect(m.status).toBe("pass");
    expect(m.artifacts).toEqual([{ type: "screenshot", path: "/x/final.png" }]);
    expect(m.metadata).toEqual({ url: "https://x" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("is best-effort: returns undefined when the run dir is unwritable", async () => {
    const p = await writeManifest({
      runDir: "/nonexistent-rolepod-dir/deep/xyz",
      skill: "s",
      phase: "verify",
      status: "pass",
      summary: "",
      startedAt: "t",
      finishedAt: "t",
      artifacts: [],
    });
    expect(p).toBeUndefined();
  });
});
