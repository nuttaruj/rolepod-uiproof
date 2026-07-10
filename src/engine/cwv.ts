import type { Page } from "playwright";

/**
 * Core Web Vitals injection + collection helpers.
 *
 * The injection script attaches three PerformanceObservers that populate
 * `window.__rolepodCwv` while the page runs. Composites add the script
 * via `context.addInitScript(...)` BEFORE the first navigation so the
 * observers see early entries (in particular the LCP `buffered: true`
 * replay).
 *
 * Scope: chromium only. Firefox/WebKit ship partial coverage of the
 * `event`, `layout-shift`, and `largest-contentful-paint` performance
 * entry types — composites hard-fail when called against them.
 */

export const CWV_INJECTION_SCRIPT = `
(() => {
  if (window.__rolepodCwv) return;
  const state = { lcp: 0, cls: 0, inp: 0, samples: [] };
  window.__rolepodCwv = state;

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        const v = last.renderTime || last.loadTime || last.startTime || 0;
        if (v > state.lcp) state.lcp = v;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) state.cls += e.value || 0;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const d = e.duration || 0;
        if (d > state.inp) state.inp = d;
        if (state.samples.length < 50) {
          state.samples.push({ name: e.name, duration: d });
        }
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch (_) {}
})();
`;

export type CwvMetrics = {
  lcp: number;
  inp: number;
  cls: number;
  samples: Array<{ name: string; duration: number }>;
};

export type CwvVerdict = "good" | "needs-improvement" | "poor" | "unmeasured";

export type CwvThresholds = {
  lcp_ms: number;
  inp_ms: number;
  cls: number;
};

export const DEFAULT_CWV_THRESHOLDS: CwvThresholds = {
  lcp_ms: 2500,
  inp_ms: 200,
  cls: 0.1,
};

export async function readCwvMetrics(page: Page): Promise<CwvMetrics> {
  return await page.evaluate(() => {
    const g = globalThis as unknown as { __rolepodCwv?: CwvMetrics };
    return g.__rolepodCwv ?? { lcp: 0, inp: 0, cls: 0, samples: [] };
  });
}

/**
 * Classify a single metric. The "needs-improvement" band is exactly the
 * range between `good` and 2× `good` per web.dev convention — keeps the
 * three CWV in one consistent shape.
 */
export function classifyMetric(
  kind: "lcp" | "inp" | "cls",
  value: number,
  thresholds: CwvThresholds,
  hadInteraction: boolean = true,
): CwvVerdict {
  if (kind === "inp" && !hadInteraction) return "unmeasured";
  // A real LCP paint is always > 0ms; lcp <= 0 means the observer never fired
  // (SPA served instantly from cache, a background tab, or a page that never
  // painted its main content). Classifying that as "good" is a false pass —
  // the metric is simply unmeasured.
  if (kind === "lcp" && value <= 0) return "unmeasured";
  const t =
    kind === "lcp" ? thresholds.lcp_ms : kind === "inp" ? thresholds.inp_ms : thresholds.cls;
  if (value <= t) return "good";
  if (value <= t * 2) return "needs-improvement";
  return "poor";
}

export type CwvOverall = "pass" | "warn" | "fail";

export function computeOverallVerdict(verdicts: {
  lcp: CwvVerdict;
  inp: CwvVerdict;
  cls: CwvVerdict;
}): CwvOverall {
  const all = [verdicts.lcp, verdicts.inp, verdicts.cls];
  if (all.includes("poor")) return "fail";
  if (all.includes("needs-improvement")) return "warn";
  // LCP is the headline metric; if it was never measured we cannot claim a
  // pass. (INP is legitimately unmeasured without an interaction, and CLS 0 is
  // a real value, so only LCP forces a warn here.)
  if (verdicts.lcp === "unmeasured") return "warn";
  return "pass";
}
