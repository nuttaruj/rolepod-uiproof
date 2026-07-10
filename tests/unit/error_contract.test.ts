import { describe, expect, it } from "vitest";
import { ok, failure, safeHandler } from "../../src/tools/result.js";
import { RolepodMcpError } from "../../src/util/errors.js";

type Body = Record<string, unknown>;

describe("MCP result contract", () => {
  it("ok packs text content + structuredContent, no error flag", () => {
    const r = ok({ a: 1 });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(r.content[0]!.type).toBe("text");
  });

  it("failure preserves a RolepodMcpError code + detail", () => {
    const r = failure(new RolepodMcpError("stale_ref", "boom", { ref: "e1" }));
    expect(r.isError).toBe(true);
    const b = r.structuredContent as Body;
    expect(b.code).toBe("stale_ref");
    expect(b.detail).toEqual({ ref: "e1" });
  });

  it("failure degrades a plain Error to engine_error", () => {
    const r = failure(new Error("plain boom"));
    expect(r.isError).toBe(true);
    const b = r.structuredContent as Body;
    expect(b.code).toBe("engine_error");
    expect(b.message).toBe("plain boom");
  });

  it("safeHandler converts a thrown typed error into a structured failure", async () => {
    const h = safeHandler(async () => {
      throw new RolepodMcpError("invalid_input", "bad");
    });
    const r = await h({});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Body).code).toBe("invalid_input");
  });

  it("safeHandler passes a successful result through unchanged", async () => {
    const h = safeHandler(async () => ok({ done: true }));
    const r = await h({});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ done: true });
  });
});
