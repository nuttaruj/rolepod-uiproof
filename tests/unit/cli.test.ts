import { describe, expect, it } from "vitest";
import { runInstallMobile } from "../../src/cli/install_mobile.js";

describe("install:mobile CLI", () => {
  it("--checklist prints a non-empty checklist and exits 0 without installing", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runInstallMobile(["--checklist"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const output = chunks.join("");
    expect(output).toMatch(/install:mobile/);
    expect(output).toMatch(/appium/);
    expect(output).toMatch(/Verify/);
    expect(output).toMatch(/ROLEPOD_NO_AUTO_APPIUM/);
  });
});
