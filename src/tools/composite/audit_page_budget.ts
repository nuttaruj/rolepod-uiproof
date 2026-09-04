import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  DEFAULT_BUDGET,
  compareToBudget,
  summarizeHar,
  type Budget,
  type HarFile,
} from "../../engine/harClassifier.js";
import type { OpenOptions, Session } from "../../engine/Engine.js";
import {
  auditPageBudgetShape,
  ToolNames,
  type AuditPageBudgetInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ARTIFACT_CREDENTIALS_NOTE } from "../../util/harRedact.js";
import {
  writeManifest,
  type ManifestArtifact,
  type ManifestStatus,
} from "../../util/manifest.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const auditPageBudgetTool: ToolModule<typeof auditPageBudgetShape> = {
  name: ToolNames.auditPageBudget,
  description:
    "Audit a page's weight against a declared budget. Loads the URL, records a HAR, classifies entries by asset category (js/css/image/font/other), tags third-party requests, and compares totals to budget. Returns violations + graduated pass/warn/fail status.",
  inputShape: auditPageBudgetShape,
  build(ctx) {
    return safeHandler(async (args: AuditPageBudgetInput) => {
      const startedAt = new Date().toISOString();
      const budget: Budget = { ...DEFAULT_BUDGET, ...(args.budget ?? {}) };

      const { runId, runDir, skill } = await ctx.store.startRun(
        "audit_page_budget",
        { skill: "audit-page-budget" },
      );
      const harPath = resolvePath(runDir, "network.har");

      const openOpts: OpenOptions = {
        platform: "web",
        browser: args.browser ?? "chromium",
        viewport: args.viewport,
        capture: { har: { path: harPath } },
      };
      const session = await ctx.registry.open(openOpts);
      const sessionHandle: Session = { id: session.id, platform: session.platform };
      const engine = ctx.registry.engineFor(session.id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "audit_page_budget requires PlaywrightEngine.",
        );
      }

      let idleReached = true;
      try {
        const page = engine.getPageForSession(session.id);
        await engine.navigate(sessionHandle, args.url);
        if (args.wait_for_idle_ms > 0) {
          try {
            await page.waitForLoadState("networkidle", {
              timeout: args.wait_for_idle_ms,
            });
          } catch {
            // Network never went idle within the window — the HAR is a partial
            // capture (requests still in flight), so the measurement can't be
            // trusted to confirm a pass. Flagged below.
            idleReached = false;
          }
        }
      } finally {
        if (args.close_on_finish) {
          await ctx.registry.close(session).catch(() => undefined);
        }
      }

      // HAR is flushed at context close. If close_on_finish is false the
      // file may not exist yet — surface the error rather than report
      // misleading zeros.
      let harText: string;
      try {
        harText = await readFile(harPath, "utf8");
      } catch (err) {
        throw new RolepodMcpError(
          "har_unavailable",
          `Could not read HAR file at ${harPath}. Ensure close_on_finish=true so Playwright flushes the recording.`,
          { harPath, cause: err instanceof Error ? err.message : String(err) },
        );
      }
      const har: HarFile = JSON.parse(harText);

      const summary = summarizeHar(har, {
        pageUrl: args.url,
        thirdPartyHostnames: args.third_party_hostnames,
      });
      const report = compareToBudget(summary, budget);
      // A partial measurement (network never went idle) cannot confirm a pass;
      // downgrade pass → warn so a still-loading page never reports "within
      // budget" on incomplete data.
      const status: ManifestStatus =
        !idleReached && report.status === "pass" ? "warn" : report.status;

      const reportPayload = {
        run_id: runId,
        url: args.url,
        budget,
        partial: !idleReached,
        // Budget is compared against transfer bytes (wire size); decoded bytes
        // are reported too for reference.
        totals_transfer_bytes: {
          total: summary.total.transferBytes,
          js: summary.by_category.js.transferBytes,
          css: summary.by_category.css.transferBytes,
          image: summary.by_category.image.transferBytes,
          font: summary.by_category.font.transferBytes,
          other: summary.by_category.other.transferBytes,
          third_party: summary.third_party.transferBytes,
        },
        totals_bytes: {
          total: summary.total.bytes,
          js: summary.by_category.js.bytes,
          css: summary.by_category.css.bytes,
          image: summary.by_category.image.bytes,
          font: summary.by_category.font.bytes,
          other: summary.by_category.other.bytes,
          third_party: summary.third_party.bytes,
        },
        request_count: summary.total.requests,
        violations: report.violations,
      };
      const budgetReportPath = await ctx.store.writeReport(
        runDir,
        "budget.json",
        JSON.stringify(reportPayload, null, 2),
      );

      const artifacts: ManifestArtifact[] = [
        { type: "page-budget", path: budgetReportPath },
        { type: "har", path: harPath },
      ];
      const manifestPath = await writeManifest({
        runDir,
        skill,
        phase: "verify",
        status,
        summary: buildSummary(reportPayload, status),
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts,
        metadata: {
          url: args.url,
          budget,
          partial: !idleReached,
          violations: report.violations,
          totals_transfer_bytes: reportPayload.totals_transfer_bytes,
          totals_bytes: reportPayload.totals_bytes,
          request_count: reportPayload.request_count,
        },
      });

      return ok({
        run_id: runId,
        url: args.url,
        partial: !idleReached,
        totals_transfer_bytes: reportPayload.totals_transfer_bytes,
        totals_bytes: reportPayload.totals_bytes,
        request_count: reportPayload.request_count,
        violations: report.violations,
        status,
        report_path: budgetReportPath,
        har_path: harPath,
        har_note: ARTIFACT_CREDENTIALS_NOTE,
        ...(manifestPath ? { manifest: manifestPath } : {}),
      });
    });
  },
};

function buildSummary(
  payload: {
    totals_transfer_bytes: { total: number };
    request_count: number;
    partial: boolean;
    violations: Array<{ category: string; over_pct: number }>;
  },
  status: ManifestStatus,
): string {
  const totalKb = Math.round(payload.totals_transfer_bytes.total / 1024);
  const reqs = payload.request_count;
  const prefix = payload.partial ? "PARTIAL (network never idled) — " : "";
  if (status === "pass") {
    return `${prefix}Page budget: ${totalKb}KB across ${reqs} requests — within budget.`;
  }
  if (payload.violations.length === 0) {
    return `${prefix}Page budget: ${totalKb}KB / ${reqs} requests — measurement incomplete, treat as unconfirmed.`;
  }
  const worst = payload.violations
    .slice()
    .sort((a, b) => b.over_pct - a.over_pct)
    .slice(0, 3)
    .map((v) => `${v.category} +${v.over_pct}%`)
    .join(", ");
  return `Page budget: ${totalKb}KB / ${reqs} requests — ${payload.violations.length} violation(s) (${worst}).`;
}
