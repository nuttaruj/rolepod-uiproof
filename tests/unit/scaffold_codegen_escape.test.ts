import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import { PlaywrightEngine } from "../../src/engine/PlaywrightEngine.js";
import { scaffoldE2eTool } from "../../src/tools/composite/scaffold_e2e.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Correctness/security: the pytest+selenium generator interpolates user text
 * into Python f-strings (XPath) and a triple-quoted docstring. Unescaped
 * braces make the f-string a SyntaxError / NameError; an unescaped `"""`
 * breaks out of the docstring. Both must be escaped so the emitted file is
 * always valid Python.
 */

const tmp = mkdtempSync(join(tmpdir(), "rolepod-uiproof-escape-"));

function makeContext(): ToolContext {
  const registry = new SessionRegistry({});
  registry.register("web", new PlaywrightEngine());
  return { registry, store: new ArtifactStore({ rootDir: tmp }) };
}

async function generatePy(
  scenario: string,
  steps: Record<string, unknown>[],
): Promise<string> {
  const ctx = makeContext();
  const { writeFile } = await import("node:fs/promises");
  const bundlePath = resolve(
    tmp,
    `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await writeFile(
    bundlePath,
    JSON.stringify({
      version: 1,
      run_id: "t",
      recorded_at: new Date().toISOString(),
      open: { platform: "web", url: "https://example.com" },
      steps,
      expect: [],
    }),
    "utf8",
  );
  const handler = scaffoldE2eTool.build(ctx);
  const out = await handler({
    framework: "pytest+selenium",
    scenario_nl: scenario,
    url: "https://example.com",
    recorded_bundle: bundlePath,
  });
  const first = out.content[0]!;
  if (first.type !== "text") throw new Error("expected text content");
  const { test_file_path } = JSON.parse(first.text) as {
    test_file_path: string;
  };
  return readFileSync(test_file_path, "utf8");
}

describe("scaffold_e2e — pytest codegen escaping", () => {
  it("doubles f-string braces from user text (no bare {field})", async () => {
    const code = await generatePy("brace test", [
      { kind: "click", query: "Total {amount}" },
    ]);
    const line = code
      .split("\n")
      .find((l) => l.includes("contains(text()"));
    expect(line).toBeDefined();
    // f-string must double user braces so they are literal, not fields
    expect(line).toContain("{{amount}}");
    // and must NOT leave a single-brace field that Python would evaluate
    expect(line).not.toContain("Total {amount}");
  });

  it("escapes a triple-quote in the docstring so it cannot break out", async () => {
    const code = await generatePy('close """ then code', []);
    // The docstring line must contain the escaped form, not a raw `"""`
    // that would terminate the string mid-body.
    const docLine = code
      .split("\n")
      .find((l) => l.trimStart().startsWith('"""') && l.trimEnd().endsWith('"""'));
    expect(docLine).toBeDefined();
    expect(docLine).toContain('close \\"\\"\\" then code');
    // the docstring body between the delimiters holds no bare triple-quote
    const body = docLine!.trim().slice(3, -3);
    expect(body).not.toContain('"""');
  });

  it("escapes double-quotes in XPath text", async () => {
    const code = await generatePy("quote test", [
      { kind: "click", query: 'a "quoted" label' },
    ]);
    const line = code
      .split("\n")
      .find((l) => l.includes("contains(text()"));
    expect(line).toBeDefined();
    expect(line).toContain('\\"quoted\\"');
  });
});

process.once("beforeExit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
