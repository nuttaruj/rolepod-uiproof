import { describe, expect, it } from "vitest";
import {
  auditA11ySchema,
  verifyUiFlowSchema,
  visualDiffSchema,
} from "../../src/schema/tools.js";

describe("schema defaults", () => {
  it("visual_diff threshold_pct defaults to 0.01 (1%), not the old lax 0.1", () => {
    const parsed = visualDiffSchema.parse({
      open: { url: "https://example.com" },
      baseline_id: "home",
    });
    expect(parsed.threshold_pct).toBe(0.01);
  });
});

describe("manifest phase hint", () => {
  it("verify_ui_flow accepts a phase hint and leaves it undefined by default", () => {
    const base = { open: { url: "https://example.com" } };
    expect(verifyUiFlowSchema.parse(base).phase).toBeUndefined();
    expect(
      verifyUiFlowSchema.parse({ ...base, phase: "debug" }).phase,
    ).toBe("debug");
  });

  it("audit_a11y accepts a phase hint and leaves it undefined by default", () => {
    const base = { open: { url: "https://example.com" } };
    expect(auditA11ySchema.parse(base).phase).toBeUndefined();
    expect(
      auditA11ySchema.parse({ ...base, phase: "review" }).phase,
    ).toBe("review");
  });

  it("rejects a phase outside the Extension Protocol vocabulary", () => {
    expect(() =>
      verifyUiFlowSchema.parse({
        open: { url: "https://example.com" },
        phase: "shipping",
      }),
    ).toThrow();
  });
});

describe("browser_open storage_state", () => {
  it("accepts an absolute storageState path and leaves it undefined by default", async () => {
    const { browserOpenSchema } = await import("../../src/schema/tools.js");
    expect(browserOpenSchema.parse({}).storage_state).toBeUndefined();
    expect(
      browserOpenSchema.parse({ storage_state: "/tmp/wp-admin.storage.json" }).storage_state,
    ).toBe("/tmp/wp-admin.storage.json");
    expect(() => browserOpenSchema.parse({ storage_state: "" })).toThrow();
  });
});

describe("browser_save_state schema", () => {
  it("requires session_id, path optional", async () => {
    const { browserSaveStateSchema } = await import("../../src/schema/tools.js");
    expect(browserSaveStateSchema.parse({ session_id: "s1" }).path).toBeUndefined();
    expect(
      browserSaveStateSchema.parse({ session_id: "s1", path: "/tmp/state.json" }).path,
    ).toBe("/tmp/state.json");
    expect(() => browserSaveStateSchema.parse({})).toThrow();
  });
});

describe("browser_find schema", () => {
  it("requires session_id + query, defaults limit to 10, caps at 50", async () => {
    const { browserFindSchema } = await import("../../src/schema/tools.js");
    const parsed = browserFindSchema.parse({ session_id: "s1", query: "Install Now" });
    expect(parsed.limit).toBe(10);
    expect(parsed.role).toBeUndefined();
    expect(
      browserFindSchema.parse({ session_id: "s1", query: "Install", role: "button", limit: 3 }).role,
    ).toBe("button");
    expect(() => browserFindSchema.parse({ session_id: "s1" })).toThrow();
    expect(() => browserFindSchema.parse({ session_id: "s1", query: "" })).toThrow();
    expect(() => browserFindSchema.parse({ session_id: "s1", query: "x", limit: 51 })).toThrow();
  });
});
