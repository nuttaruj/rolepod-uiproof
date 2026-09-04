#!/usr/bin/env node
// Emit dist/schemas/tools.json — JSON-Schema definitions for every
// tool exposed by the MCP server. Run via `npm run
// build:schemas` after `npm run build`.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "..", "dist", "index.js");

const lib = await import(distEntry);
const { ToolNames } = lib;

const pairs = [
  ["browserOpen", lib.browserOpenSchema],
  ["browserClose", lib.browserCloseSchema],
  ["browserSnapshot", lib.browserSnapshotSchema],
  ["browserClick", lib.browserClickSchema],
  ["browserType", lib.browserTypeSchema],
  ["browserKey", lib.browserKeySchema],
  ["browserScroll", lib.browserScrollSchema],
  ["browserWaitFor", lib.browserWaitForSchema],
  ["browserScreenshot", lib.browserScreenshotSchema],
  ["browserNavigate", lib.browserNavigateSchema],
  ["browserHover", lib.browserHoverSchema],
  ["browserDrag", lib.browserDragSchema],
  ["browserFillForm", lib.browserFillFormSchema],
  ["browserUploadFile", lib.browserUploadFileSchema],
  ["browserHandleDialog", lib.browserHandleDialogSchema],
  ["browserConsole", lib.browserConsoleSchema],
  ["browserNetwork", lib.browserNetworkSchema],
  ["browserSetEnv", lib.browserSetEnvSchema],
  ["browserEvaluate", lib.browserEvaluateSchema],
  ["browserPages", lib.browserPagesSchema],
  ["browserSwitchPage", lib.browserSwitchPageSchema],
  ["browserSaveState", lib.browserSaveStateSchema],
  ["browserFind", lib.browserFindSchema],
  ["extractComputedStyle", lib.extractComputedStyleSchema],
  ["verifyUiFlow", lib.verifyUiFlowSchema],
  ["auditA11y", lib.auditA11ySchema],
  ["visualDiff", lib.visualDiffSchema],
  ["scaffoldE2e", lib.scaffoldE2eSchema],
  ["extractUiState", lib.extractUiStateSchema],
  // v0.7 measurement surface
  ["measureCwv", lib.measureCwvSchema],
  ["auditPageBudget", lib.auditPageBudgetSchema],
  ["auditSeo", lib.auditSeoSchema],
  // v0.16 black-box discovery
  ["discoverFlows", lib.discoverFlowsSchema],
];

const tools = {};
for (const [key, schema] of pairs) {
  const toolName = ToolNames[key];
  if (!toolName) {
    console.error(`Missing ToolNames entry for ${key}`);
    process.exit(1);
  }
  // zod v4 native converter. The external `zod-to-json-schema` package only
  // understands zod v3 internals and silently emits an empty `{$schema}` for
  // every zod-v4 schema — see the non-empty guard below.
  tools[toolName] = z.toJSONSchema(schema, { unrepresentable: "any" });
}

// Parity guard: every registered tool MUST have an exported schema. Catches a
// new tool added to ToolNames but not to the `pairs` list above (otherwise the
// export silently under-emits and consumers never see the tool's schema).
const missing = Object.values(ToolNames).filter((name) => !(name in tools));
if (missing.length > 0) {
  console.error(`Schema export missing for tool(s): ${missing.join(", ")}`);
  process.exit(1);
}

// Non-empty guard: a converter/zod-version mismatch can produce a schema with
// no properties for every tool while still passing the parity check above.
// Every tool takes at least one input, so an empty `properties` is a
// broken export — fail loudly rather than ship useless schemas.
const emptyTools = Object.entries(tools)
  .filter(([, schema]) => Object.keys(schema?.properties ?? {}).length === 0)
  .map(([name]) => name);
if (emptyTools.length > 0) {
  console.error(
    `Schema export produced empty (property-less) schemas for: ${emptyTools.join(", ")}. ` +
      `Likely a zod / JSON-Schema converter version mismatch.`,
  );
  process.exit(1);
}

const out = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  rolepod_mcp_version: lib.SERVER_VERSION,
  tools,
};

const outDir = resolve(here, "..", "dist", "schemas");
await mkdir(outDir, { recursive: true });
const outPath = resolve(outDir, "tools.json");
await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`Wrote ${Object.keys(tools).length} schemas → ${outPath}`);
