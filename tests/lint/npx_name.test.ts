import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * The npm package is scoped: `@rolepod/uiproof`. The bare `npx rolepod-uiproof`
 * 404s on the real registry and is squattable, so no user-facing file may ship
 * it — every invocation must be `npx @rolepod/uiproof …`.
 */

const repoRoot = resolve(__dirname, "..", "..");
// Build the needle from parts so this test file itself doesn't trip the scan.
const BAD = `npx ${"rolepod-uiproof"}`;

const ROOTS = ["README.md", "src", "docs", ".github"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
// The plan doc intentionally quotes the bad form while describing the bug.
const SKIP_PATHS = [join("docs", "rolepod", "plans")];
const EXTS = [".md", ".ts", ".mjs", ".json", ".yml", ".yaml"];

function walk(rel: string, out: string[]): void {
  const abs = resolve(repoRoot, rel);
  const st = statSync(abs);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(rel.split("/").pop() ?? "")) return;
    if (SKIP_PATHS.some((p) => rel === p || rel.startsWith(p + "/"))) return;
    for (const entry of readdirSync(abs)) walk(join(rel, entry), out);
  } else if (EXTS.some((e) => rel.endsWith(e))) {
    out.push(rel);
  }
}

describe("npx invocation name (scoped package)", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s uses the scoped @rolepod/uiproof", (rel) => {
    const raw = readFileSync(resolve(repoRoot, rel), "utf8");
    expect(raw.includes(BAD)).toBe(false);
  });
});
