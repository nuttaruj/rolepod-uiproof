/**
 * HAR (HTTP Archive) post-processing for page-weight budgets.
 *
 * Playwright writes a HAR file at context shutdown when `recordHar` is
 * set. This module reads the JSON, classifies entries by asset category
 * (js / css / image / font / other), and compares totals against a
 * declared budget.
 *
 * No external dependency — HAR is plain JSON.
 */

export type AssetCategory = "js" | "css" | "image" | "font" | "other";

export type HarEntry = {
  request?: { url?: string; method?: string };
  response?: {
    status?: number;
    content?: { size?: number; mimeType?: string };
    _transferSize?: number;
  };
  _transferSize?: number;
};

export type HarFile = {
  log?: {
    entries?: HarEntry[];
  };
};

export type CategoryTotals = {
  bytes: number;
  transferBytes: number;
  requests: number;
};

export type HarSummary = {
  total: CategoryTotals;
  by_category: Record<AssetCategory, CategoryTotals>;
  third_party: CategoryTotals;
};

export type Budget = {
  total_kb: number;
  js_kb: number;
  css_kb: number;
  image_kb: number;
  font_kb: number;
  third_party_kb: number;
  request_count: number;
};

export const DEFAULT_BUDGET: Budget = {
  total_kb: 1500,
  js_kb: 300,
  css_kb: 100,
  image_kb: 500,
  font_kb: 100,
  third_party_kb: 200,
  request_count: 100,
};

export type BudgetViolation = {
  category: string;
  actual_kb: number;
  budget_kb: number;
  over_pct: number;
};

export type BudgetStatus = "pass" | "warn" | "fail";

export type BudgetReport = {
  summary: HarSummary;
  violations: BudgetViolation[];
  status: BudgetStatus;
};

export function classifyEntry(entry: HarEntry): AssetCategory {
  const mime = entry.response?.content?.mimeType?.toLowerCase() ?? "";
  const url = entry.request?.url?.toLowerCase() ?? "";

  if (mime.includes("javascript") || mime.includes("ecmascript")) return "js";
  if (mime.includes("css")) return "css";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("font/") || mime.includes("woff") || mime.includes("ttf") || mime.includes("otf")) {
    return "font";
  }

  // URL-based fallback when MIME is missing/generic
  if (/\.(js|mjs|cjs)(\?|$)/.test(url)) return "js";
  if (/\.css(\?|$)/.test(url)) return "css";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/.test(url)) return "image";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(url)) return "font";

  return "other";
}

export function entryBytes(entry: HarEntry): { size: number; transfer: number } {
  const size = entry.response?.content?.size ?? 0;
  const transfer =
    entry.response?._transferSize ??
    entry._transferSize ??
    (size > 0 ? size : 0);
  return { size: Math.max(0, size), transfer: Math.max(0, transfer) };
}

/**
 * Common two-level public suffixes where the registrable domain is the last
 * three labels (e.g. `bbc.co.uk`). Not exhaustive — a cheap stand-in for a
 * full public-suffix list, enough to stop sibling subdomains being misread.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "or.jp", "ne.jp",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "com.mx",
  "co.in", "co.kr", "com.cn", "com.sg", "com.hk", "com.tw",
]);

/**
 * Best-effort registrable domain (eTLD+1) without a public-suffix-list
 * dependency. `www.site.com` and `cdn.site.com` both resolve to `site.com`.
 */
export function registrableDomain(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? last3 : last2;
}

export function isThirdParty(
  entry: HarEntry,
  pageHostname: string,
  thirdPartyHostnames: string[] | undefined,
): boolean {
  const url = entry.request?.url;
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  // Same registrable domain (eTLD+1) → first-party, so sibling subdomains such
  // as `www.` and `cdn.` on one site are not misreported as third-party.
  if (pageHostname && registrableDomain(host) === registrableDomain(pageHostname)) {
    return false;
  }
  if (thirdPartyHostnames && thirdPartyHostnames.length > 0) {
    return thirdPartyHostnames.some((h) => host === h || host.endsWith(`.${h}`));
  }
  return true;
}

export function summarizeHar(
  har: HarFile,
  opts: { pageUrl: string; thirdPartyHostnames?: string[] },
): HarSummary {
  const entries = har.log?.entries ?? [];
  let pageHostname = "";
  try {
    pageHostname = new URL(opts.pageUrl).hostname;
  } catch {
    /* leave empty — third-party detection falls back to "everything is third-party" */
  }

  const blank: CategoryTotals = { bytes: 0, transferBytes: 0, requests: 0 };
  const summary: HarSummary = {
    total: { ...blank },
    by_category: {
      js: { ...blank },
      css: { ...blank },
      image: { ...blank },
      font: { ...blank },
      other: { ...blank },
    },
    third_party: { ...blank },
  };

  for (const entry of entries) {
    const cat = classifyEntry(entry);
    const { size, transfer } = entryBytes(entry);
    summary.total.bytes += size;
    summary.total.transferBytes += transfer;
    summary.total.requests += 1;
    summary.by_category[cat].bytes += size;
    summary.by_category[cat].transferBytes += transfer;
    summary.by_category[cat].requests += 1;
    if (isThirdParty(entry, pageHostname, opts.thirdPartyHostnames)) {
      summary.third_party.bytes += size;
      summary.third_party.transferBytes += transfer;
      summary.third_party.requests += 1;
    }
  }
  return summary;
}

const BYTES_PER_KB = 1024;

export function compareToBudget(summary: HarSummary, budget: Budget): BudgetReport {
  const violations: BudgetViolation[] = [];

  // Compare against transfer size (what actually crossed the wire, gzip/brotli
  // included) — not the decoded content.size, which over-reports on every
  // compressed site and produces false budget failures.
  const checks: Array<[string, number, number]> = [
    ["total", summary.total.transferBytes, budget.total_kb],
    ["js", summary.by_category.js.transferBytes, budget.js_kb],
    ["css", summary.by_category.css.transferBytes, budget.css_kb],
    ["image", summary.by_category.image.transferBytes, budget.image_kb],
    ["font", summary.by_category.font.transferBytes, budget.font_kb],
    ["third_party", summary.third_party.transferBytes, budget.third_party_kb],
  ];

  for (const [category, bytes, budgetKb] of checks) {
    const actualKb = bytes / BYTES_PER_KB;
    if (actualKb > budgetKb) {
      violations.push({
        category,
        actual_kb: round(actualKb, 1),
        budget_kb: budgetKb,
        over_pct: round((actualKb / budgetKb - 1) * 100, 1),
      });
    }
  }

  if (summary.total.requests > budget.request_count) {
    violations.push({
      category: "request_count",
      actual_kb: summary.total.requests,
      budget_kb: budget.request_count,
      over_pct: round((summary.total.requests / budget.request_count - 1) * 100, 1),
    });
  }

  const status = classifyBudgetStatus(violations);
  return { summary, violations, status };
}

function classifyBudgetStatus(violations: BudgetViolation[]): BudgetStatus {
  if (violations.length === 0) return "pass";
  // > 50% over budget on any category → fail
  if (violations.some((v) => v.over_pct > 50)) return "fail";
  return "warn";
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
