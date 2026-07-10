import { describe, expect, it } from "vitest";
import { visualDiffSchema } from "../../src/schema/tools.js";

describe("schema defaults", () => {
  it("visual_diff threshold_pct defaults to 0.01 (1%), not the old lax 0.1", () => {
    const parsed = visualDiffSchema.parse({
      open: { url: "https://example.com" },
      baseline_id: "home",
    });
    expect(parsed.threshold_pct).toBe(0.01);
  });
});
