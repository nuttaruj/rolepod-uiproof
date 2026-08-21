import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAll } from "js-yaml";
import { ArtifactStore } from "../../src/artifact/ArtifactStore.js";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import {
  extractPriority,
  extractTcId,
  maestroFilename,
  scaffoldE2eTool,
} from "../../src/tools/composite/scaffold_e2e.js";
import { scaffoldE2eSchema } from "../../src/schema/tools.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * Unit tests for the `maestro` framework in `scaffold_e2e`
 * (brief/14-maestro-scaffold.md). No browser and no Maestro CLI are
 * involved — the scaffold only writes YAML.
 */

type Step = Record<string, unknown>;
type Expect = Record<string, unknown>;

const tmp = mkdtempSync(join(tmpdir(), "rolepod-uiproof-maestro-"));

function makeContext(): ToolContext {
  // No engine registered — the scaffold never opens a browser.
  return {
    registry: new SessionRegistry({}),
    store: new ArtifactStore({ rootDir: tmp }),
  };
}

async function writeBundle(steps: Step[], expectArr: Expect[] = []): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const path = resolve(tmp, `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      run_id: "test",
      recorded_at: new Date().toISOString(),
      open: { platform: "web", url: "https://example.com" },
      steps,
      expect: expectArr,
    }),
    "utf8",
  );
  return path;
}

type ScaffoldArgs = {
  framework: string;
  scenario_nl: string;
  url?: string;
  app_id?: string;
  recorded_bundle?: string;
  filename?: string;
};

async function run(args: ScaffoldArgs): Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
}> {
  const ctx = makeContext();
  const handler = scaffoldE2eTool.build(ctx);
  const out = await handler(args as never);
  const first = out.content[0]!;
  if (first.type !== "text") throw new Error(`expected text content, got ${first.type}`);
  const payload = JSON.parse(first.text) as Record<string, unknown>;
  return { ok: !out.isError, payload };
}

async function generate(
  scenario: string,
  steps: Step[],
  expectArr: Expect[] = [],
  extra: Partial<ScaffoldArgs> = {},
): Promise<{ file: string; body: string }> {
  const bundlePath = await writeBundle(steps, expectArr);
  const { ok, payload } = await run({
    framework: "maestro",
    scenario_nl: scenario,
    app_id: "com.example.app",
    recorded_bundle: bundlePath,
    ...extra,
  });
  expect(ok, JSON.stringify(payload)).toBe(true);
  const file = String(payload.test_file_path);
  return { file, body: readFileSync(file, "utf8") };
}

/** Parse the two-document Maestro file (config + command list). */
function parseFlow(body: string): { config: Record<string, unknown>; commands: unknown[] } {
  const docs = loadAll(body).filter((d) => d !== null && d !== undefined);
  expect(docs.length).toBe(2);
  return {
    config: docs[0] as Record<string, unknown>,
    commands: docs[1] as unknown[],
  };
}

describe("scaffold_e2e — schema (maestro)", () => {
  it("accepts framework maestro with app_id and no url", () => {
    const parsed = scaffoldE2eSchema.safeParse({
      framework: "maestro",
      scenario_nl: "TC1 login works",
      app_id: "com.example.app",
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts the three web frameworks unchanged", () => {
    for (const framework of ["playwright-test", "vitest+playwright", "pytest+selenium"]) {
      const parsed = scaffoldE2eSchema.safeParse({
        framework,
        scenario_nl: "x",
        url: "https://example.com",
      });
      expect(parsed.success, framework).toBe(true);
    }
  });
});

describe("scaffold_e2e — cross-field validation", () => {
  it("rejects a web framework without url", async () => {
    const { ok, payload } = await run({
      framework: "playwright-test",
      scenario_nl: "no url",
    });
    expect(ok).toBe(false);
    expect(JSON.stringify(payload)).toContain("invalid_input");
  });

  it("rejects maestro with neither app_id nor url", async () => {
    const { ok, payload } = await run({
      framework: "maestro",
      scenario_nl: "no target",
    });
    expect(ok).toBe(false);
    expect(JSON.stringify(payload)).toContain("invalid_input");
  });
});

describe("scaffold_e2e — TC-ID traceability helpers", () => {
  it("extracts TC id and priority case-insensitively", () => {
    expect(extractTcId("tc12: edge case [p2]")).toBe("TC12");
    expect(extractPriority("tc12: edge case [p2]")).toBe("P2");
    expect(extractTcId("no id here")).toBeNull();
    expect(extractPriority("no priority")).toBeNull();
  });

  it("builds a TC-prefixed filename without repeating the id in the slug", () => {
    expect(maestroFilename("TC2 [P1] minimum boundary")).toBe("TC2_minimum-boundary.yaml");
    expect(maestroFilename("plain scenario")).toBe("plain-scenario.yaml");
  });
});

describe("scaffold_e2e — maestro flow output", () => {
  it("carries TC id + priority in filename, header comment, and tags", async () => {
    const { file, body } = await generate("TC2 [P1] user logs in with minimum password", []);
    expect(file.endsWith("TC2_user-logs-in-with-minimum-password.yaml")).toBe(true);
    expect(body).toContain("# TC2 [P1] —");
    const { config } = parseFlow(body);
    expect(config.appId).toBe("com.example.app");
    expect(config.tags).toEqual(["TC2", "P1"]);
  });

  it("uses url config for web flows when no app_id is given", async () => {
    // No bundle → the args url is the flow target.
    const { ok, payload } = await run({
      framework: "maestro",
      scenario_nl: "TC9 web checkout",
      url: "https://shop.example.com/checkout",
    });
    expect(ok).toBe(true);
    const noBundle = parseFlow(readFileSync(String(payload.test_file_path), "utf8"));
    expect(noBundle.config.url).toBe("https://shop.example.com/checkout");
    expect(noBundle.config.appId).toBeUndefined();

    // With a bundle, the recorded url wins — same preference as the web renderers.
    const { body } = await generate("TC9 web checkout", [], [], {
      app_id: undefined,
      url: "https://shop.example.com/checkout",
    });
    expect(parseFlow(body).config.url).toBe("https://example.com");
  });

  it("transcribes core steps and asserts to Maestro commands", async () => {
    const { body } = await generate(
      "TC3 [P2] fill and submit",
      [
        { kind: "click", query: "Login" },
        { kind: "type", query: "Email", text: "a@b.co" },
        { kind: "key", key: "Enter" },
        { kind: "navigate", url: "https://example.com/next" },
        { kind: "scroll", direction: "down" },
        {
          kind: "fill_form",
          fields: [
            { query: "Name", value: "Alice" },
            { query: "Subscribe", value: true, kind: "checkbox" },
          ],
        },
        { kind: "wait_for", condition: { kind: "text_visible", text: "Done" } },
      ],
      [
        { kind: "text_visible", text: "Welcome" },
        { kind: "text_absent", text: "Error" },
      ],
    );
    const { commands } = parseFlow(body);
    expect(commands).toContainEqual("launchApp");
    expect(commands).toContainEqual({ tapOn: "Login" });
    expect(commands).toContainEqual({ inputText: "a@b.co" });
    expect(commands).toContainEqual({ pressKey: "Enter" });
    expect(commands).toContainEqual({ openLink: "https://example.com/next" });
    expect(commands).toContainEqual("scroll");
    expect(commands).toContainEqual({ inputText: "Alice" });
    expect(commands).toContainEqual({ tapOn: "Subscribe" });
    expect(commands).toContainEqual({
      extendedWaitUntil: { visible: "Done", timeout: 10000 },
    });
    expect(commands).toContainEqual({ assertVisible: "Welcome" });
    expect(commands).toContainEqual({ assertNotVisible: "Error" });
  });

  it("comments out web-only step/expect kinds instead of failing", async () => {
    const { body } = await generate(
      "TC4 unsupported kinds",
      [
        { kind: "hover", query: "Menu" },
        { kind: "switch_page", index: 1 },
        { kind: "evaluate", script: "return 1;" },
      ],
      [{ kind: "response_status", url_pattern: "/api", status: 200 }],
    );
    // Still parses — unsupported kinds degrade to comments, not YAML.
    const { commands } = parseFlow(body);
    expect(commands).toEqual(["launchApp"]);
    expect(body).toContain("# hover");
    expect(body).toContain("# switch_page");
    expect(body).toContain("# evaluate");
    expect(body).toContain("# response_status");
  });

  it("degrades a wait_for with a missing condition to a comment, not a crash", async () => {
    const { body } = await generate("TC7 malformed bundle", [
      { kind: "wait_for" },
    ]);
    const { commands } = parseFlow(body);
    expect(commands).toEqual(["launchApp"]);
    expect(body).toContain("# wait_for:");
  });

  it("escapes U+2028/U+2029 so YAML 1.1 parsers cannot see a line break", async () => {
    const evil = "before\u2028- tapOn: injected";
    const { body } = await generate("TC8 ls-ps escaping", [
      { kind: "click", query: evil },
    ]);
    // The literal LS char must never reach the file — only the \u escape.
    expect(body.includes("\u2028")).toBe(false);
    expect(body).toContain("\\u2028");
    const { commands } = parseFlow(body);
    expect(commands).toContainEqual({ tapOn: evil });
  });

  it("quotes hostile text safely — no YAML injection", async () => {
    const evil = 'he said "hi"\n- tapOn: injected\n# not a comment';
    const { body } = await generate("TC5 escaping", [
      { kind: "click", query: evil },
    ]);
    const { commands } = parseFlow(body);
    expect(commands).toContainEqual({ tapOn: evil });
    expect(commands).not.toContainEqual({ tapOn: "injected" });
  });

  it("reports yaml language, no dependencies, and a maestro run pointer", async () => {
    const bundlePath = await writeBundle([]);
    const { ok, payload } = await run({
      framework: "maestro",
      scenario_nl: "TC6 envelope",
      app_id: "com.example.app",
      recorded_bundle: bundlePath,
    });
    expect(ok).toBe(true);
    expect(payload.language).toBe("yaml");
    expect(payload.dependencies).toEqual([]);
    expect(String(payload.setup_notes)).toContain("maestro test");
    expect(String(payload.setup_notes)).toContain("get.maestro.mobile.dev");
  });
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
