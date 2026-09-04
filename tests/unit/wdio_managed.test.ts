import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pickEsmEntry,
  resolveManagedWebdriverio,
} from "../../src/engine/appiumProvision.js";

describe("pickEsmEntry", () => {
  it("prefers exports['.'].import (webdriverio v9 layout)", () => {
    expect(
      pickEsmEntry({
        main: "./build/index.cjs",
        exports: {
          ".": { types: "./build/index.d.ts", import: "./build/node.js", require: "./build/index.cjs" },
        },
      }),
    ).toBe("./build/node.js");
  });
  it("handles string exports, nested default, module, main, and nothing", () => {
    expect(pickEsmEntry({ exports: "./x.js" })).toBe("./x.js");
    expect(pickEsmEntry({ exports: { import: { default: "./y.js" } } })).toBe("./y.js");
    expect(pickEsmEntry({ module: "./m.js", main: "./c.cjs" })).toBe("./m.js");
    expect(pickEsmEntry({ main: "./c.cjs" })).toBe("./c.cjs");
    expect(pickEsmEntry({})).toBeNull();
  });
});

describe("resolveManagedWebdriverio", () => {
  it("returns null when the managed dir is empty, the entry path when installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiproof-wdio-"));
    expect(resolveManagedWebdriverio(root)).toBeNull();
    const pkgDir = join(root, "node_modules", "webdriverio");
    await mkdir(join(pkgDir, "build"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "webdriverio", exports: { ".": { import: "./build/node.js" } } }),
    );
    // entry declared but file missing → null (half-installed)
    expect(resolveManagedWebdriverio(root)).toBeNull();
    await writeFile(join(pkgDir, "build", "node.js"), "export const remote = () => {};");
    expect(resolveManagedWebdriverio(root)).toBe(join(pkgDir, "build", "node.js"));
  });
});
