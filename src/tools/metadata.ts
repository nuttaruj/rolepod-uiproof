import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolNames, type ToolName } from "../schema/tools.js";

/**
 * Per-tool display metadata exposed via MCP `registerTool`.
 *
 * - `title`: human-readable label shown in client UIs (Claude Code, Cursor, etc.)
 * - `annotations`: trust-and-safety hints. Per spec these are advisory only —
 *   clients still gate on user consent — but they let well-behaved clients
 *   auto-approve read-only calls and prompt harder on destructive ones.
 *
 * `destructiveHint`/`idempotentHint` are only meaningful when `readOnlyHint`
 * is false, so we omit them for read-only tools.
 */
export type ToolMetadata = {
  title: string;
  annotations: ToolAnnotations;
};

export const toolMetadata: Record<ToolName, ToolMetadata> = {
  // ---------- atomic ----------
  [ToolNames.browserOpen]: {
    title: "Open Browser/Mobile Session",
    annotations: {
      title: "Open Browser/Mobile Session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserClose]: {
    title: "Close Session",
    annotations: {
      title: "Close Session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserSnapshot]: {
    title: "Capture Accessibility Snapshot",
    annotations: {
      title: "Capture Accessibility Snapshot",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.browserClick]: {
    title: "Click Element",
    annotations: {
      title: "Click Element",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserType]: {
    title: "Type Text",
    annotations: {
      title: "Type Text",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserKey]: {
    title: "Press Key",
    annotations: {
      title: "Press Key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserScroll]: {
    title: "Scroll Viewport",
    annotations: {
      title: "Scroll Viewport",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.browserWaitFor]: {
    title: "Wait For Condition",
    annotations: {
      title: "Wait For Condition",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.browserScreenshot]: {
    title: "Take Screenshot",
    annotations: {
      title: "Take Screenshot",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.browserNavigate]: {
    title: "Navigate URL",
    annotations: {
      title: "Navigate URL",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  // ---------- composite ----------
  [ToolNames.verifyUiFlow]: {
    title: "Verify UI Flow",
    annotations: {
      title: "Verify UI Flow",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.auditA11y]: {
    title: "Audit Accessibility (axe-core)",
    annotations: {
      title: "Audit Accessibility (axe-core)",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.visualDiff]: {
    title: "Visual Diff vs Baseline",
    annotations: {
      title: "Visual Diff vs Baseline",
      // Writes to ./.rolepod-uiproof/{baselines,artifacts}/ but only adds files —
      // never destroys an existing baseline silently.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.scaffoldE2e]: {
    title: "Scaffold E2E Test File",
    annotations: {
      title: "Scaffold E2E Test File",
      // Writes a test file to the local repo.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  [ToolNames.extractUiState]: {
    title: "Extract UI State (NL Query)",
    annotations: {
      title: "Extract UI State (NL Query)",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },

  // ---------- v0.5 atomic additions ----------
  [ToolNames.browserHover]: {
    title: "Hover Element",
    annotations: {
      title: "Hover Element",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.browserDrag]: {
    title: "Drag Element",
    annotations: {
      title: "Drag Element",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserFillForm]: {
    title: "Fill Form (Batch)",
    annotations: {
      title: "Fill Form (Batch)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserUploadFile]: {
    title: "Upload File",
    annotations: {
      title: "Upload File",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserHandleDialog]: {
    title: "Pre-arm Dialog Handler",
    annotations: {
      title: "Pre-arm Dialog Handler",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  [ToolNames.browserConsole]: {
    title: "Inspect Console Logs",
    annotations: {
      title: "Inspect Console Logs",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserNetwork]: {
    title: "Inspect Network Requests",
    annotations: {
      title: "Inspect Network Requests",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserSetEnv]: {
    title: "Set Browser Environment",
    annotations: {
      title: "Set Browser Environment",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserEvaluate]: {
    title: "Evaluate JavaScript (gated; arbitrary code execution)",
    annotations: {
      title: "Evaluate JavaScript",
      // Arbitrary code execution in the page context. Gated by
      // ROLEPOD_ALLOW_EVAL=1 server-side. Always treat as destructive.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  [ToolNames.browserPages]: {
    title: "List Open Pages",
    annotations: {
      title: "List Open Pages",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserSwitchPage]: {
    title: "Switch Active Page",
    annotations: {
      title: "Switch Active Page",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.browserSaveState]: {
    title: "Save Session State",
    annotations: {
      title: "Save Session State",
      // Writes a credential-bearing file to disk (overwrites if present).
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  [ToolNames.extractComputedStyle]: {
    title: "Extract Computed CSS",
    annotations: {
      title: "Extract Computed CSS",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },

  // ---------- v0.7 measurement surface ----------
  [ToolNames.measureCwv]: {
    title: "Measure Core Web Vitals (LCP/INP/CLS)",
    annotations: {
      title: "Measure Core Web Vitals",
      // Opens its own browser, observes PerformanceObserver, writes metrics
      // + manifest to artifacts/. Read-only for the target page.
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.auditPageBudget]: {
    title: "Audit Page Weight Budget (HAR)",
    annotations: {
      title: "Audit Page Weight Budget",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  [ToolNames.auditSeo]: {
    title: "Audit On-Page SEO (DOM + meta)",
    annotations: {
      title: "Audit On-Page SEO",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },

  // ---------- v0.16 black-box discovery ----------
  [ToolNames.discoverFlows]: {
    title: "Discover UI Flows (Black-Box Crawl)",
    annotations: {
      title: "Discover UI Flows",
      // GET-navigation crawl; destructive-classified actions are never
      // executed. Not readOnlyHint:true because opt-in `interact_forms`
      // submits GET forms (dummy data) — still non-mutating by design,
      // but the crawl autonomously issues requests the caller didn't list.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
};
