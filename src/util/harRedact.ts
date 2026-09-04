import { readFile, writeFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

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
 * Playwright trace.zip: the only member carrying request/response headers
 * is `trace.network` — JSONL of `{"type":"resource-snapshot","snapshot":
 * <HAR entry>}`. Scrub each line with the same rules as the HAR and
 * rewrite the archive; every other member (screenshots, DOM snapshots,
 * stacks) is copied through untouched.
 */
export async function redactTraceFile(path: string): Promise<number> {
  const zipped = await readFile(path);
  const files = unzipSync(new Uint8Array(zipped));
  const NETWORK = "trace.network";
  const raw = files[NETWORK];
  if (!raw) return 0;
  let n = 0;
  const lines = strFromU8(raw).split("\n");
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return line;
    }
    const snap = (obj as { snapshot?: HarEntry }).snapshot;
    if (!snap || typeof snap !== "object") return line;
    const before = n;
    n += scrubMessage(snap.request);
    n += scrubMessage(snap.response);
    return n > before ? JSON.stringify(obj) : line;
  });
  if (n === 0) return 0;
  files[NETWORK] = strToU8(out.join("\n"));
  await writeFile(path, zipSync(files));
  return n;
}

/**
 * One-line notice attached to tool results that surface HAR / trace paths.
 * Headers and cookies are scrubbed in both, but bodies are not: the HAR
 * embeds response bodies and the trace carries DOM snapshots + screenshots
 * of whatever was on screen — anything an authenticated page rendered
 * (admin markup, nonces, personal data) is still in there.
 */
export const ARTIFACT_CREDENTIALS_NOTE =
  "network.har and trace.zip have Cookie/Set-Cookie/Authorization headers and cookies redacted (best-effort — a warning is logged if redaction fails). Response bodies, DOM snapshots and screenshots are NOT redacted: they contain whatever an authenticated page rendered. Share only with people cleared to see those pages.";
