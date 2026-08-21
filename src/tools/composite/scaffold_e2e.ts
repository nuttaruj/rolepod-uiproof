import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  scaffoldE2eShape,
  ToolNames,
  type ScaffoldE2eInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { writeManifest } from "../../util/manifest.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

type Step = { kind: string; [k: string]: unknown };
type Expect = { kind: string; [k: string]: unknown };
type ReplayShape = {
  version: number;
  open?: { url?: string };
  steps?: Step[];
  expect?: Expect[];
};

export const scaffoldE2eTool: ToolModule<typeof scaffoldE2eShape> = {
  name: ToolNames.scaffoldE2e,
  description:
    "Generate a runnable e2e test file (playwright-test, vitest+playwright, pytest+selenium, or a maestro YAML flow) from a scenario description and optional replay bundle from a prior verify_ui_flow run.",
  inputShape: scaffoldE2eShape,
  build(ctx) {
    return safeHandler(async (args: ScaffoldE2eInput) => {
      // Cross-field rules a raw zod shape cannot express: web frameworks
      // need an entry URL; maestro needs an app id (mobile) or URL (web).
      if (args.framework === "maestro") {
        if (!args.app_id && !args.url) {
          throw new RolepodMcpError(
            "invalid_input",
            'framework "maestro" requires `app_id` (mobile app flow) or `url` (web flow).',
          );
        }
      } else if (!args.url) {
        throw new RolepodMcpError(
          "invalid_input",
          `framework "${args.framework}" requires \`url\`.`,
        );
      }

      const startedAt = new Date().toISOString();
      const { runId, runDir, skill } = await ctx.store.startRun(
        "scaffold",
        { skill: "scaffold-e2e" },
      );
      const slug = slugify(args.scenario_nl);
      const bundle = args.recorded_bundle
        ? await loadReplay(args.recorded_bundle)
        : null;
      const ctxObj = { args, slug, bundle };

      let body: string;
      let language: "typescript" | "python" | "yaml";
      let filename: string;
      let dependencies: string[];
      let setupNotes: string;

      // Defense in depth: a user-supplied filename is reduced to a basename
      // so it can never target a directory outside the run dir. ArtifactStore
      // also rejects escaping names.
      const userFilename = args.filename ? basename(args.filename) : undefined;

      switch (args.framework) {
        case "playwright-test":
          body = renderPlaywrightTest(ctxObj);
          language = "typescript";
          filename = userFilename ?? `${slug}.spec.ts`;
          dependencies = ["@playwright/test"];
          setupNotes =
            "Install: `npm i -D @playwright/test && npx playwright install`. Run: `npx playwright test`.";
          break;
        case "vitest+playwright":
          body = renderVitestPlaywright(ctxObj);
          language = "typescript";
          filename = userFilename ?? `${slug}.test.ts`;
          dependencies = ["vitest", "playwright"];
          setupNotes =
            "Install: `npm i -D vitest playwright && npx playwright install chromium`. Run: `npx vitest`.";
          break;
        case "pytest+selenium":
          body = renderPytestSelenium(ctxObj);
          language = "python";
          filename = userFilename ?? `test_${slug}.py`;
          dependencies = ["pytest", "selenium"];
          setupNotes =
            "Install: `pip install pytest selenium`. Ensure a Chrome driver is on PATH. Run: `pytest`.";
          break;
        case "maestro":
          body = renderMaestro(ctxObj);
          language = "yaml";
          filename = userFilename ?? maestroFilename(args.scenario_nl);
          dependencies = [];
          setupNotes =
            "The Maestro CLI is only needed to RUN the flow, not to scaffold it. " +
            "Install: `curl -fsSL \"https://get.maestro.mobile.dev\" | bash` (see maestro.dev). " +
            "Run: `maestro test <flow.yaml>` against a connected device/simulator — hand-off only, never auto-run.";
          break;
        default:
          throw new RolepodMcpError(
            "invalid_input",
            `Unknown framework "${args.framework}".`,
          );
      }

      const path = await ctx.store.writeReport(runDir, filename, body);

      const manifestPath = await writeManifest({
        runDir,
        skill,
        phase: "build",
        status: "pass",
        summary: `generated ${args.framework} test "${filename}" from ${bundle ? "replay bundle" : "scenario"}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts: [{ type: "test_file", path }],
        metadata: {
          framework: args.framework,
          language,
          from_replay_bundle: Boolean(bundle),
        },
      });

      return ok({
        run_id: runId,
        test_file_path: path,
        language,
        dependencies,
        setup_notes: setupNotes,
        from_replay_bundle: Boolean(bundle),
        ...(manifestPath ? { manifest: manifestPath } : {}),
      });
    });
  },
};

async function loadReplay(bundlePath: string): Promise<ReplayShape> {
  const raw = await readFile(resolve(bundlePath), "utf8");
  return JSON.parse(raw) as ReplayShape;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "scenario"
  );
}

type RenderCtx = {
  args: ScaffoldE2eInput;
  slug: string;
  bundle: ReplayShape | null;
};

function renderPlaywrightTest(c: RenderCtx): string {
  const url = c.bundle?.open?.url ?? c.args.url;
  const stepLines = c.bundle?.steps?.length
    ? c.bundle.steps.map(playwrightStepLine).join("\n")
    : `  // TODO: implement steps for: ${c.args.scenario_nl}`;
  const expectLines = c.bundle?.expect?.length
    ? c.bundle.expect.map(playwrightExpectLine).join("\n")
    : `  // TODO: add expectations`;
  return [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test(${JSON.stringify(c.args.scenario_nl)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(url)});`,
    stepLines,
    expectLines,
    `});`,
    ``,
  ].join("\n");
}

function renderVitestPlaywright(c: RenderCtx): string {
  const url = c.bundle?.open?.url ?? c.args.url;
  const stepLines = c.bundle?.steps?.length
    ? c.bundle.steps.map(playwrightStepLine).join("\n")
    : `    // TODO: implement steps for: ${c.args.scenario_nl}`;
  const expectLines = c.bundle?.expect?.length
    ? c.bundle.expect.map(playwrightExpectLine).join("\n")
    : `    // TODO: add expectations`;
  return [
    `import { test } from "vitest";`,
    `import { chromium, expect } from "playwright/test";`,
    ``,
    `test(${JSON.stringify(c.args.scenario_nl)}, async () => {`,
    `  const browser = await chromium.launch();`,
    `  const page = await browser.newPage();`,
    `  try {`,
    `    await page.goto(${JSON.stringify(url)});`,
    indent(stepLines, 2),
    indent(expectLines, 2),
    `  } finally {`,
    `    await browser.close();`,
    `  }`,
    `});`,
    ``,
  ].join("\n");
}

function renderPytestSelenium(c: RenderCtx): string {
  const url = c.bundle?.open?.url ?? c.args.url;
  const stepLines = c.bundle?.steps?.length
    ? c.bundle.steps.map(seleniumStepLine).join("\n")
    : `    # TODO: implement steps for: ${c.args.scenario_nl}`;
  const expectLines = c.bundle?.expect?.length
    ? c.bundle.expect.map(seleniumExpectLine).join("\n")
    : `    # TODO: add expectations`;
  return [
    `import pytest`,
    `from selenium import webdriver`,
    `from selenium.webdriver.common.by import By`,
    `from selenium.webdriver.common.keys import Keys`,
    ``,
    `def test_${slugifyPy(c.args.scenario_nl)}():`,
    `    """${pyDocstring(c.args.scenario_nl)}"""`,
    `    driver = webdriver.Chrome()`,
    `    try:`,
    `        driver.get(${JSON.stringify(url)})`,
    indent(stepLines, 2),
    indent(expectLines, 2),
    `    finally:`,
    `        driver.quit()`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// maestro — YAML flow codegen (mobile-first; web via `url` config)
//
// TC-ID traceability contract (brief/14-maestro-scaffold.md): the case id
// (`TC<n>`) and priority (`P1`/`P2`) found in `scenario_nl` are carried into
// the filename (`TC2_<slug>.yaml`), the header comment, and Maestro `tags`,
// so check-work can grep them exactly as it does for the web frameworks.
// ---------------------------------------------------------------------------

/** Uppercased `TC<n>` token found in the scenario, or null. */
export function extractTcId(s: string): string | null {
  const m = /\bTC\d+\b/i.exec(s);
  return m ? m[0].toUpperCase() : null;
}

/** Uppercased `P1`/`P2` priority token found in the scenario, or null. */
export function extractPriority(s: string): string | null {
  const m = /\bP[12]\b/i.exec(s);
  return m ? m[0].toUpperCase() : null;
}

export function maestroFilename(scenario: string): string {
  const tc = extractTcId(scenario);
  const prio = extractPriority(scenario);
  let rest = scenario;
  // Strip the tokens so the slug doesn't repeat them in lowercase.
  if (tc) rest = rest.replace(new RegExp(`\\b${tc}\\b`, "gi"), " ");
  if (prio) rest = rest.replace(new RegExp(`\\b${prio}\\b`, "gi"), " ");
  const slug = slugify(rest);
  return tc ? `${tc}_${slug}.yaml` : `${slug}.yaml`;
}

/** Wait budgets for the generated extendedWaitUntil/waitForAnimationToEnd. */
const MAESTRO_WAIT_TIMEOUT_MS = 10000;
const MAESTRO_IDLE_FALLBACK_MS = 1000;

/**
 * Double-quoted YAML scalar. JSON strings are valid YAML flow scalars, so
 * JSON.stringify gives injection-safe quoting (quotes, newlines, `#`, `-`).
 * U+2028/U+2029 are escaped by hand: YAML 1.1 parsers (Maestro's JVM side)
 * treat LS/PS as line breaks, and JSON.stringify leaves them literal.
 */
function yamlStr(s: string): string {
  return JSON.stringify(s).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
}

/** Untrusted text destined for a YAML comment — a newline would end it. */
function yamlComment(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function renderMaestro(c: RenderCtx): string {
  const tc = extractTcId(c.args.scenario_nl);
  const prio = extractPriority(c.args.scenario_nl);
  const scenarioLine = yamlComment(c.args.scenario_nl);
  const idLabel = [tc, prio ? `[${prio}]` : null].filter(Boolean).join(" ");

  const lines: string[] = [
    idLabel ? `# ${idLabel} — ${scenarioLine}` : `# ${scenarioLine}`,
    `# Generated by rolepod-uiproof scaffold_e2e (maestro). Hand-off only — run manually:`,
    `#   maestro test <this file>`,
  ];

  // Config document: mobile flows target an app id, web flows a URL.
  // Same source preference as the web renderers: recorded bundle wins.
  if (c.args.app_id) {
    lines.push(`appId: ${yamlStr(c.args.app_id)}`);
  } else {
    lines.push(`url: ${yamlStr(c.bundle?.open?.url ?? c.args.url ?? "")}`);
  }
  const tags = [tc, prio].filter((t): t is string => t !== null);
  if (tags.length > 0) {
    lines.push(`tags:`);
    for (const t of tags) lines.push(`  - ${t}`);
  }
  lines.push(`---`);
  lines.push(`- launchApp`);

  if (c.bundle?.steps?.length) {
    for (const step of c.bundle.steps) lines.push(maestroStepLine(step));
  } else {
    lines.push(`# TODO: implement steps for: ${scenarioLine}`);
  }
  if (c.bundle?.expect?.length) {
    for (const exp of c.bundle.expect) lines.push(maestroExpectLine(exp));
  } else {
    lines.push(`# TODO: add assertions (assertVisible / assertNotVisible)`);
  }
  lines.push(``);
  return lines.join("\n");
}

function maestroStepLine(step: Step): string {
  switch (step.kind) {
    case "click":
      return `- tapOn: ${yamlStr(String(step.query))}`;
    case "type":
      return [
        `- tapOn: ${yamlStr(String(step.query))}`,
        `- inputText: ${yamlStr(String(step.text))}`,
      ].join("\n");
    case "key": {
      const key = maestroKeyName(String(step.key));
      return key
        ? `- pressKey: ${key}`
        : `# key "${yamlComment(String(step.key))}" has no Maestro pressKey equivalent`;
    }
    case "navigate":
      return `- openLink: ${yamlStr(String(step.url))}`;
    case "wait_for": {
      const cond = (step.condition ?? {}) as { kind?: string; text?: string; query?: string; ms?: number };
      if (cond.kind === "text_visible" || cond.kind === "ref_exists") {
        const target = cond.kind === "text_visible" ? cond.text : cond.query;
        return [
          `- extendedWaitUntil:`,
          `    visible: ${yamlStr(String(target ?? ""))}`,
          `    timeout: ${MAESTRO_WAIT_TIMEOUT_MS}`,
        ].join("\n");
      }
      if (cond.kind === "idle") {
        return [
          `- waitForAnimationToEnd:`,
          `    timeout: ${Number(cond.ms) || MAESTRO_IDLE_FALLBACK_MS}`,
        ].join("\n");
      }
      return `# wait_for: ${yamlComment(JSON.stringify(cond))} — Maestro auto-waits; use extendedWaitUntil if needed`;
    }
    case "hover":
      return `# hover ${yamlStr(String(step.query))} — no Maestro equivalent (touch devices have no cursor)`;
    case "drag":
      return [
        `# drag ${yamlStr(String(step.from_query))} → ${yamlStr(String(step.to_query))} — translate to a swipe:`,
        `# - swipe:`,
        `#     start: "50%, 70%"`,
        `#     end: "50%, 30%"`,
      ].join("\n");
    case "fill_form": {
      const fields = Array.isArray(step.fields)
        ? (step.fields as Array<{ query: string; value: unknown; kind?: string }>)
        : [];
      return fields
        .map((f) => {
          const label = yamlStr(f.query);
          if (f.kind === "checkbox" || f.kind === "radio") {
            return `- tapOn: ${label}`;
          }
          if (f.kind === "select") {
            return [
              `- tapOn: ${label}`,
              `- tapOn: ${yamlStr(String(f.value))}`,
            ].join("\n");
          }
          return [
            `- tapOn: ${label}`,
            `- inputText: ${yamlStr(String(f.value))}`,
          ].join("\n");
        })
        .join("\n");
    }
    case "upload":
      return [
        `# upload ${yamlStr(String(step.query))} — push the file to the device gallery first, then pick it:`,
        `# - addMedia:`,
        `#     - ${yamlStr(String(step.file_path))}`,
      ].join("\n");
    case "dialog":
      return `# dialog (${yamlComment(String(step.action))}) — tapOn the dialog button's visible label, e.g. \`- tapOn: "OK"\``;
    case "set_env":
      return `# set_env — device-level configuration; set it on the emulator/simulator or via maestro --device`;
    case "switch_page":
      return `# switch_page — no tab/window model on mobile; split into a separate flow file`;
    case "evaluate":
      return `# evaluate — browser JS does not apply on mobile; see Maestro runScript/evalScript for flow-level JS`;
    case "scroll": {
      const dir = String(step.direction ?? "down");
      if (dir === "down") return `- scroll`;
      // Touch semantics: scrolling content down means the finger swipes up.
      const swipe: Record<string, string> = { up: "DOWN", left: "RIGHT", right: "LEFT" };
      return [`- swipe:`, `    direction: ${swipe[dir] ?? "UP"}`].join("\n");
    }
    case "settle":
      return `# settle — web-only convenience; Maestro auto-waits after each command`;
    default:
      return `# unsupported step kind: ${yamlComment(String(step.kind))}`;
  }
}

function maestroExpectLine(exp: Expect): string {
  switch (exp.kind) {
    case "text_visible":
      return `- assertVisible: ${yamlStr(String(exp.text))}`;
    case "text_absent":
      return `- assertNotVisible: ${yamlStr(String(exp.text))}`;
    case "ref_in_state": {
      const q = yamlStr(String(exp.query));
      if (exp.state === "enabled") {
        return [`- assertVisible:`, `    text: ${q}`, `    enabled: true`].join("\n");
      }
      if (exp.state === "focused") {
        return [`- assertVisible:`, `    text: ${q}`, `    focused: true`].join("\n");
      }
      return `- assertVisible: ${q}`;
    }
    case "url_matches":
      return `# url_matches ${yamlStr(String(exp.pattern))} — Maestro has no URL assertion; assert on-screen content instead`;
    case "no_console_errors":
      return `# no_console_errors — no console capture in Maestro; check app logs out-of-band`;
    case "no_failed_requests":
      return `# no_failed_requests — no network capture in Maestro; verify via backend logs or a proxy`;
    case "request_made":
      return `# request_made ${yamlStr(String(exp.url_pattern))} — no network capture in Maestro`;
    case "response_status":
      return `# response_status ${yamlStr(String(exp.url_pattern))} == ${Number(exp.status)} — no network capture in Maestro`;
    default:
      return `# unsupported expect kind: ${yamlComment(String(exp.kind))}`;
  }
}

function maestroKeyName(k: string): string | null {
  const map: Record<string, string> = {
    Enter: "Enter",
    Backspace: "Backspace",
    Home: "Home",
  };
  return map[k] ?? null;
}

function playwrightStepLine(step: Step): string {
  switch (step.kind) {
    case "click":
      return `  await page.getByText(${JSON.stringify(step.query)}, { exact: false }).first().click();`;
    case "type":
      return `  await page.getByRole("textbox", { name: ${JSON.stringify(step.query)} }).fill(${JSON.stringify(step.text)});`;
    case "key":
      return `  await page.keyboard.press(${JSON.stringify(step.key)});`;
    case "navigate":
      return `  await page.goto(${JSON.stringify(step.url)});`;
    case "wait_for":
      return `  // wait_for: ${JSON.stringify(step.condition)} — translate to page.waitForXxx()`;
    case "hover":
      return `  await page.getByText(${JSON.stringify(step.query)}, { exact: false }).first().hover();`;
    case "drag":
      return [
        `  await page`,
        `    .getByText(${JSON.stringify(step.from_query)}, { exact: false })`,
        `    .first()`,
        `    .dragTo(page.getByText(${JSON.stringify(step.to_query)}, { exact: false }).first());`,
      ].join("\n");
    case "fill_form": {
      const fields = Array.isArray(step.fields) ? (step.fields as Array<{ query: string; value: unknown; kind?: string }>) : [];
      return fields
        .map((f) => {
          const q = JSON.stringify(f.query);
          if (f.kind === "select") {
            return `  await page.getByLabel(${q}).selectOption(${JSON.stringify(String(f.value))});`;
          }
          if (f.kind === "checkbox" || f.kind === "radio") {
            const checked = typeof f.value === "boolean"
              ? f.value
              : String(f.value) === "true" || String(f.value) === "on";
            return `  await page.getByLabel(${q}).setChecked(${checked});`;
          }
          return `  await page.getByLabel(${q}).fill(${JSON.stringify(String(f.value))});`;
        })
        .join("\n");
    }
    case "upload":
      return `  await page.getByLabel(${JSON.stringify(step.query)}).setInputFiles(${JSON.stringify(step.file_path)});`;
    case "dialog":
      return [
        `  page.once("dialog", async (dialog) => {`,
        step.action === "accept"
          ? `    await dialog.accept();`
          : step.action === "accept_with_text"
            ? `    await dialog.accept(${JSON.stringify(step.text ?? "")});`
            : `    await dialog.dismiss();`,
        `  });`,
      ].join("\n");
    case "set_env": {
      const lines: string[] = [];
      if (step.viewport && typeof step.viewport === "object") {
        const v = step.viewport as { width: number; height: number };
        lines.push(`  await page.setViewportSize({ width: ${v.width}, height: ${v.height} });`);
      }
      if (step.offline !== undefined) {
        lines.push(`  await page.context().setOffline(${Boolean(step.offline)});`);
      }
      if (step.geolocation) {
        lines.push(`  await page.context().setGeolocation(${JSON.stringify(step.geolocation)});`);
      }
      if (step.color_scheme || step.reduced_motion) {
        const opts: Record<string, unknown> = {};
        if (step.color_scheme) opts.colorScheme = step.color_scheme;
        if (step.reduced_motion) opts.reducedMotion = step.reduced_motion;
        lines.push(`  await page.emulateMedia(${JSON.stringify(opts)});`);
      }
      if (step.extra_headers) {
        lines.push(`  await page.context().setExtraHTTPHeaders(${JSON.stringify(step.extra_headers)});`);
      }
      if (step.network_throttle || step.cpu_throttle !== undefined) {
        lines.push(`  // network/cpu throttle requires CDP — see Playwright docs (chromium only)`);
      }
      return lines.length > 0 ? lines.join("\n") : `  // set_env: nothing to apply`;
    }
    case "switch_page":
      return `  const allPages = page.context().pages(); /* switch to index ${step.index} */ if (allPages[${step.index}]) await allPages[${step.index}].bringToFront();`;
    case "evaluate":
      return `  await page.evaluate(${JSON.stringify(step.script)});`;
    default:
      return `  // unsupported step kind: ${step.kind}`;
  }
}

function playwrightExpectLine(exp: Expect): string {
  switch (exp.kind) {
    case "text_visible":
      return `  await expect(page.getByText(${JSON.stringify(exp.text)}, { exact: false }).first()).toBeVisible();`;
    case "text_absent":
      return `  await expect(page.getByText(${JSON.stringify(exp.text)}, { exact: false }).first()).toHaveCount(0);`;
    case "url_matches":
      return `  await expect(page).toHaveURL(new RegExp(${JSON.stringify(exp.pattern)}));`;
    case "ref_in_state":
      return `  // ref_in_state ${JSON.stringify(exp.query)} → ${String(exp.state)} — translate as needed`;
    case "no_console_errors":
      return [
        `  // no_console_errors — collect via page.on('console') before the steps, then:`,
        `  // expect(consoleErrors).toEqual([]);`,
      ].join("\n");
    case "no_failed_requests":
      return [
        `  // no_failed_requests — collect via page.on('requestfailed'/'response') before the steps, then:`,
        `  // expect(failedRequests).toEqual([]);`,
      ].join("\n");
    case "request_made":
      return `  await page.waitForRequest(new RegExp(${JSON.stringify(exp.url_pattern)}));`;
    case "response_status":
      return `  await page.waitForResponse((r) => new RegExp(${JSON.stringify(exp.url_pattern)}).test(r.url()) && r.status() === ${Number(exp.status)});`;
    default:
      return `  // unsupported expect kind: ${exp.kind}`;
  }
}

function seleniumStepLine(step: Step): string {
  switch (step.kind) {
    case "click":
      return `    driver.find_element(By.XPATH, f"//*[contains(text(), \\"${escapePy(String(step.query))}\\")]").click()`;
    case "type":
      return `    driver.find_element(By.XPATH, f"//*[@aria-label=\\"${escapePy(String(step.query))}\\" or @placeholder=\\"${escapePy(String(step.query))}\\"]").send_keys(${JSON.stringify(step.text)})`;
    case "key":
      return `    driver.switch_to.active_element.send_keys(Keys.${pyKeyName(String(step.key))})`;
    case "navigate":
      return `    driver.get(${JSON.stringify(step.url)})`;
    case "wait_for":
      return `    # wait_for: ${JSON.stringify(step.condition)} — translate to WebDriverWait`;
    case "hover":
      return [
        `    from selenium.webdriver.common.action_chains import ActionChains`,
        `    target = driver.find_element(By.XPATH, f"//*[contains(text(), \\"${escapePy(String(step.query))}\\")]")`,
        `    ActionChains(driver).move_to_element(target).perform()`,
      ].join("\n");
    case "drag":
      return [
        `    from selenium.webdriver.common.action_chains import ActionChains`,
        `    src = driver.find_element(By.XPATH, f"//*[contains(text(), \\"${escapePy(String(step.from_query))}\\")]")`,
        `    dst = driver.find_element(By.XPATH, f"//*[contains(text(), \\"${escapePy(String(step.to_query))}\\")]")`,
        `    ActionChains(driver).drag_and_drop(src, dst).perform()`,
      ].join("\n");
    case "fill_form": {
      const fields = Array.isArray(step.fields)
        ? (step.fields as Array<{ query: string; value: unknown; kind?: string }>)
        : [];
      return fields
        .map((f) => {
          const q = escapePy(f.query);
          if (f.kind === "select") {
            return [
              `    from selenium.webdriver.support.ui import Select`,
              `    Select(driver.find_element(By.XPATH, f"//*[@aria-label=\\"${q}\\"]")).select_by_visible_text(${JSON.stringify(String(f.value))})`,
            ].join("\n");
          }
          if (f.kind === "checkbox" || f.kind === "radio") {
            const checked =
              typeof f.value === "boolean"
                ? f.value
                : String(f.value) === "true";
            return `    el = driver.find_element(By.XPATH, f"//*[@aria-label=\\"${q}\\"]"); el.click() if el.is_selected() != ${checked ? "True" : "False"} else None`;
          }
          return `    driver.find_element(By.XPATH, f"//*[@aria-label=\\"${q}\\"]").send_keys(${JSON.stringify(String(f.value))})`;
        })
        .join("\n");
    }
    case "upload":
      return `    driver.find_element(By.XPATH, f"//*[@aria-label=\\"${escapePy(String(step.query))}\\"]").send_keys(${JSON.stringify(step.file_path)})`;
    case "dialog":
      return [
        `    alert = driver.switch_to.alert`,
        step.action === "accept"
          ? `    alert.accept()`
          : step.action === "accept_with_text"
            ? `    alert.send_keys(${JSON.stringify(step.text ?? "")}); alert.accept()`
            : `    alert.dismiss()`,
      ].join("\n");
    case "set_env": {
      const lines: string[] = [];
      if (step.viewport && typeof step.viewport === "object") {
        const v = step.viewport as { width: number; height: number };
        lines.push(`    driver.set_window_size(${v.width}, ${v.height})`);
      }
      lines.push(`    # set_env partially supported in Selenium — see selenium docs for offline/geolocation/colorScheme via CDP`);
      return lines.join("\n");
    }
    case "switch_page":
      return `    driver.switch_to.window(driver.window_handles[${step.index}])`;
    case "evaluate":
      return `    driver.execute_script(${JSON.stringify(step.script)})`;
    default:
      return `    # unsupported step kind: ${step.kind}`;
  }
}

function seleniumExpectLine(exp: Expect): string {
  switch (exp.kind) {
    case "text_visible":
      return `    assert ${JSON.stringify(exp.text)} in driver.page_source`;
    case "text_absent":
      return `    assert ${JSON.stringify(exp.text)} not in driver.page_source`;
    case "url_matches":
      return `    import re; assert re.search(${JSON.stringify(exp.pattern)}, driver.current_url)`;
    case "ref_in_state":
      return `    # ref_in_state ${JSON.stringify(exp.query)} → ${String(exp.state)}`;
    case "no_console_errors":
      return [
        `    # no_console_errors — read browser logs via driver.get_log("browser")`,
        `    errors = [l for l in driver.get_log("browser") if l.get("level") == "SEVERE"]`,
        `    assert errors == [], f"console errors: {errors}"`,
      ].join("\n");
    case "no_failed_requests":
      return `    # no_failed_requests — selenium has no built-in network capture. Enable selenium-wire or BiDi for this.`;
    case "request_made":
      return `    # request_made ${JSON.stringify(exp.url_pattern)} — use selenium-wire (driver.requests) or BiDi`;
    case "response_status":
      return `    # response_status ${JSON.stringify(exp.url_pattern)} == ${Number(exp.status)} — use selenium-wire (driver.requests) or BiDi`;
    default:
      return `    # unsupported expect kind: ${exp.kind}`;
  }
}

function slugifyPy(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "scenario"
  );
}

function escapePy(s: string): string {
  // Values here are interpolated into single-line Python f-strings (XPath).
  // Braces must be doubled or Python treats them as replacement fields;
  // control chars would break the single-line string literal.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function pyDocstring(s: string): string {
  // Body of a triple-quoted docstring: escape backslashes and double-quotes so
  // an embedded `"""` cannot terminate the string early.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pyKeyName(k: string): string {
  const map: Record<string, string> = {
    Enter: "ENTER",
    Tab: "TAB",
    Escape: "ESCAPE",
    Backspace: "BACK_SPACE",
    ArrowUp: "ARROW_UP",
    ArrowDown: "ARROW_DOWN",
    ArrowLeft: "ARROW_LEFT",
    ArrowRight: "ARROW_RIGHT",
  };
  return map[k] ?? `RETURN  # unknown key: ${k}`;
}

function indent(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}
