import { readFile, writeFile } from "node:fs/promises";

/**
 * HAR credential redaction.
 *
 * Playwright's `recordHar` (mode `full`, which we need for transfer sizes
 * in audit_page_budget) writes every request/response header verbatim,
 * including `Cookie`, `Set-Cookie` and `Authorization`. A HAR captured
 * during an authenticated session therefore IS the session — anyone who
 * reads the artifact can replay it until the cookie expires.
 *
 * `redactHar` scrubs those header values in place and empties the
 * structured `cookies` arrays. Sizes, timings and `_transferSize` are left
 * untouched so budget classification keeps working.
 */

export const REDACTED = "[redacted by rolepod-uiproof]";

const SENSITIVE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
]);

type HarHeader = { name?: unknown; value?: unknown };
type HarMessage = { headers?: unknown; cookies?: unknown };
type HarEntry = { request?: HarMessage; response?: HarMessage };

function scrubMessage(msg: HarMessage | undefined): number {
  if (!msg || typeof msg !== "object") return 0;
  let n = 0;
  if (Array.isArray(msg.headers)) {
    for (const h of msg.headers as HarHeader[]) {
      if (
        h &&
        typeof h.name === "string" &&
        SENSITIVE_HEADERS.has(h.name.toLowerCase()) &&
        h.value !== REDACTED
      ) {
        h.value = REDACTED;
        n++;
      }
    }
  }
  if (Array.isArray(msg.cookies) && msg.cookies.length > 0) {
    n += msg.cookies.length;
    msg.cookies = [];
  }
  return n;
}

/** Mutates `har` in place. Returns how many header/cookie values were scrubbed. */
export function redactHar(har: unknown): number {
  if (!har || typeof har !== "object") return 0;
  const entries = (har as { log?: { entries?: unknown } }).log?.entries;
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries as HarEntry[]) {
    if (!e || typeof e !== "object") continue;
    n += scrubMessage(e.request);
    n += scrubMessage(e.response);
  }
  return n;
}

/** Read → redact → rewrite a HAR file. Returns the scrub count. */
export async function redactHarFile(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  const har: unknown = JSON.parse(raw);
  const n = redactHar(har);
  if (n > 0) await writeFile(path, JSON.stringify(har), "utf8");
  return n;
}

/**
 * One-line notice attached to tool results that surface HAR / trace paths.
 * The HAR is scrubbed; the Playwright trace is not (it is a zip of raw
 * network + DOM snapshots), so the agent must still treat it as a credential.
 */
export const ARTIFACT_CREDENTIALS_NOTE =
  "network.har has Cookie/Set-Cookie/Authorization headers redacted. trace.zip (if present) is NOT redacted and may contain the session's auth cookies — treat it as a credential; do not attach it to issues, PRs, or shared drives.";
