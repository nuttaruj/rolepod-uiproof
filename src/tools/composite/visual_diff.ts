import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  ToolNames,
  visualDiffShape,
  type VisualDiffInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { writeManifest, type ManifestArtifact } from "../../util/manifest.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

/**
 * Copy the top-left w×h region of a PNG into a fresh PNG. Uses the static
 * PNG.bitblt — `PNG.sync.read` returns a plain {width,height,data} object
 * without the prototype's instance `bitblt`.
 */
function cropTopLeft(src: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, 0, 0, w, h, 0, 0);
  return out;
}

/**
 * True when a PNG is empty or a single solid colour — the signature of a
 * broken / unloaded page. Refusing to seed a baseline from such a capture
 * stops a bad baseline from poisoning every future diff.
 */
export function isBlankPng(buf: Buffer): boolean {
  const png = PNG.sync.read(buf);
  if (png.width === 0 || png.height === 0) return true;
  const d = png.data;
  const r = d[0];
  const g = d[1];
  const b = d[2];
  const a = d[3];
  for (let i = 4; i < d.length; i += 4) {
    if (d[i] !== r || d[i + 1] !== g || d[i + 2] !== b || d[i + 3] !== a) {
      return false;
    }
  }
  return true;
}

export const visualDiffTool: ToolModule<typeof visualDiffShape> = {
  name: ToolNames.visualDiff,
  description:
    "Pixel-compare the current UI against a named baseline under ./.rolepod-uiproof/baselines/ to find WHERE two UI states differ — a visual regression vs a known-good baseline, or an implementation vs its design/reference (seed the baseline from a reference URL, or drop a design-export PNG at baselines/<baseline_id>.png). First call for a baseline_id seeds the baseline (passed=true, diff_pct=0). Subsequent calls return the diff percentage and an annotated diff image. By default (settle=true) the page is scrolled to trigger scroll-reveal/lazy content, network-idled, and animations frozen before capture — so reveal-heavy pages are not baselined while invisible. Pass `selector` to scope the diff to one element (region-scoped) instead of the full page. A size change vs the baseline is reported gracefully (overlap diff + width/height deltas, dimension_mismatch=true, passed=false) rather than erroring. The diff shows where, not why — follow up with extract_computed_style on the differing region for root cause.",
  inputShape: visualDiffShape,
  build(ctx) {
    return safeHandler(async (args: VisualDiffInput) => {
      const startedAt = new Date().toISOString();
      const { runId, runDir, skill } = await ctx.store.startRun(
        "vdiff",
        { skill: "visual-diff" },
      );
      const session = await ctx.registry.open({
        ...args.open,
        ...(args.viewport ? { viewport: args.viewport } : {}),
      });
      const engine = ctx.registry.engineFor(session.id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "visual_diff currently requires PlaywrightEngine.",
        );
      }

      try {
        if (args.settle) {
          await engine.settle({ id: session.id, platform: session.platform });
        }
        const handle = { id: session.id, platform: session.platform };
        const buf = args.selector
          ? await engine.screenshotElement(handle, args.selector, {
              freezeMotion: args.settle,
            })
          : await engine.screenshot(handle, true, { freezeMotion: args.settle });
        const currentPath = await ctx.store.writeScreenshot(runDir, buf, "current");

        await ctx.store.ensureDir(ctx.store.baselineDir);
        const baselinePath = resolve(
          ctx.store.baselineDir,
          `${args.baseline_id}.png`,
        );

        if (!existsSync(baselinePath)) {
          // Only guard full-page seeds: a broken/unloaded page renders as one
          // solid colour. A region capture (`selector`) of a solid element
          // (a coloured button/box) is legitimately single-colour, so skip it.
          if (!args.selector && isBlankPng(buf)) {
            throw new RolepodMcpError(
              "invalid_input",
              `Refusing to seed baseline "${args.baseline_id}" from a blank / solid-colour full-page capture — verify the URL actually renders content before baselining (a broken or unloaded page must not become the baseline).`,
              { baseline_id: args.baseline_id },
            );
          }
          await ctx.store.writeBytes(
            ctx.store.baselineDir,
            `${args.baseline_id}.png`,
            buf,
          );
          const manifestPath = await writeManifest({
            runDir,
            skill,
            phase: "verify",
            status: "pass",
            summary: `baseline "${args.baseline_id}" seeded from current capture`,
            startedAt,
            finishedAt: new Date().toISOString(),
            artifacts: [
              { type: "baseline", path: baselinePath },
              { type: "screenshot", path: currentPath },
            ],
            metadata: {
              baseline_id: args.baseline_id,
              seeded: true,
              settled: args.settle,
              ...(args.selector ? { selector: args.selector } : {}),
            },
          });
          return ok({
            run_id: runId,
            baseline_id: args.baseline_id,
            diff_pct: 0,
            passed: true,
            baseline_created: true,
            baseline_path: baselinePath,
            current_path: currentPath,
            ...(manifestPath ? { manifest: manifestPath } : {}),
            note: "Baseline did not exist — current capture saved as the new baseline. Re-run to diff against it.",
          });
        }

        const [baselineRaw, currentRaw] = await Promise.all([
          readFile(baselinePath),
          readFile(currentPath),
        ]);
        const baseline = PNG.sync.read(baselineRaw);
        const current = PNG.sync.read(currentRaw);

        const dimensionMismatch =
          baseline.width !== current.width ||
          baseline.height !== current.height;
        // On a size change, diff the overlapping top-left region so the caller
        // gets a usable diff image + measured deltas instead of a hard error.
        // A mismatch still fails the check (a resize is a real visual change) —
        // re-seed the baseline if the new size is intended.
        const cmpWidth = Math.min(baseline.width, current.width);
        const cmpHeight = Math.min(baseline.height, current.height);
        const baselineCmp = dimensionMismatch
          ? cropTopLeft(baseline, cmpWidth, cmpHeight)
          : baseline;
        const currentCmp = dimensionMismatch
          ? cropTopLeft(current, cmpWidth, cmpHeight)
          : current;

        const diff = new PNG({ width: cmpWidth, height: cmpHeight });
        const diffPixels = pixelmatch(
          baselineCmp.data,
          currentCmp.data,
          diff.data,
          cmpWidth,
          cmpHeight,
          { threshold: args.pixel_threshold, includeAA: true },
        );
        const total = cmpWidth * cmpHeight;
        const diffPct = diffPixels / total;
        const passed = !dimensionMismatch && diffPct <= args.threshold_pct;
        const dimensions = {
          baseline: { w: baseline.width, h: baseline.height },
          current: { w: current.width, h: current.height },
          width_delta: current.width - baseline.width,
          height_delta: current.height - baseline.height,
        };

        const diffImagePath = await ctx.store.writeBytes(
          runDir,
          "diff.png",
          PNG.sync.write(diff),
        );

        const artifacts: ManifestArtifact[] = [
          { type: "baseline", path: baselinePath },
          { type: "screenshot", path: currentPath },
          { type: "diff", path: diffImagePath },
        ];
        const manifestPath = await writeManifest({
          runDir,
          skill,
          phase: "verify",
          status: passed ? "pass" : "fail",
          summary: `diff ${(diffPct * 100).toFixed(3)}% vs baseline "${args.baseline_id}" (threshold ${(args.threshold_pct * 100).toFixed(3)}%)${
            dimensionMismatch
              ? ` — DIMENSION MISMATCH baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}; compared ${cmpWidth}x${cmpHeight} overlap`
              : ""
          }`,
          startedAt,
          finishedAt: new Date().toISOString(),
          artifacts,
          metadata: {
            baseline_id: args.baseline_id,
            diff_pct: Number(diffPct.toFixed(6)),
            diff_pixels: diffPixels,
            total_pixels: total,
            threshold_pct: args.threshold_pct,
            settled: args.settle,
            dimension_mismatch: dimensionMismatch,
            width_delta: dimensions.width_delta,
            height_delta: dimensions.height_delta,
            ...(args.selector ? { selector: args.selector } : {}),
          },
        });

        return ok({
          run_id: runId,
          baseline_id: args.baseline_id,
          diff_pct: Number(diffPct.toFixed(6)),
          diff_pixels: diffPixels,
          total_pixels: total,
          passed,
          dimension_mismatch: dimensionMismatch,
          dimensions,
          baseline_path: baselinePath,
          current_path: currentPath,
          diff_image_path: diffImagePath,
          ...(manifestPath ? { manifest: manifestPath } : {}),
        });
      } finally {
        if (args.close_on_finish) {
          await ctx.registry.close(session).catch(() => undefined);
        }
      }
    });
  },
};
