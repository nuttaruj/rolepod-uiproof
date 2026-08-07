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
