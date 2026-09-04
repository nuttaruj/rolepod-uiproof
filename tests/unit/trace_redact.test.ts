import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { REDACTED, redactTraceFile } from "../../src/util/harRedact.js";

const COOKIE = "wordpress_logged_in_abc=admin%7C123%7Csig";

function networkLine(url: string) {
  return JSON.stringify({
    type: "resource-snapshot",
    snapshot: {
      pageref: "page@1",
      request: {
        method: "GET",
        url,
        headers: [
          { name: "Cookie", value: COOKIE },
          { name: "Accept", value: "text/html" },
        ],
        cookies: [{ name: "wordpress_logged_in_abc", value: "admin|123|sig" }],
      },
      response: {
        status: 200,
        headers: [{ name: "Set-Cookie", value: "wordpress_sec=xyz" }],
        cookies: [],
        _transferSize: 999,
      },
    },
  });
}

async function makeTrace(dir: string, withNetwork = true) {
  const files: Record<string, Uint8Array> = {
    "trace.trace": strToU8('{"type":"context-options","browserName":"chromium"}\n'),
    "resources/page@1-1.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  };
  if (withNetwork) {
    files["trace.network"] = strToU8(
      [networkLine("http://site.test/wp-admin/"), "", networkLine("http://site.test/api")].join(
        "\n",
      ),
    );
  }
  const p = join(dir, "trace.zip");
  await writeFile(p, zipSync(files));
  return p;
}

describe("redactTraceFile", () => {
  it("scrubs headers/cookies in trace.network and leaves other members intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uiproof-trace-"));
    const p = await makeTrace(dir);
    const n = await redactTraceFile(p);
    // per entry: Cookie + Set-Cookie headers + 1 request cookie = 3; two entries
    expect(n).toBe(6);

    const files = unzipSync(new Uint8Array(await readFile(p)));
    expect(Object.keys(files).sort()).toEqual(
      ["resources/page@1-1.jpeg", "trace.network", "trace.trace"].sort(),
    );
    const net = strFromU8(files["trace.network"]!);
    expect(net).not.toContain(COOKIE);
    expect(net).not.toContain("wordpress_sec=xyz");
    expect(net).toContain(REDACTED);
    expect(net).toContain("_transferSize");
    expect(net.split("\n")).toHaveLength(3); // blank line preserved
    expect(strFromU8(files["trace.trace"]!)).toContain("context-options");
    expect(Array.from(files["resources/page@1-1.jpeg"]!)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("is a no-op on a trace with no network member and idempotent otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uiproof-trace-"));
    const bare = await makeTrace(dir, false);
    expect(await redactTraceFile(bare)).toBe(0);
    const full = await makeTrace(await mkdtemp(join(tmpdir(), "uiproof-trace-")));
    await redactTraceFile(full);
    expect(await redactTraceFile(full)).toBe(0);
  });
});
