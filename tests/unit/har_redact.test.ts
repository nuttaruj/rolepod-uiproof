import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REDACTED, redactHar, redactHarFile } from "../../src/util/harRedact.js";

function sampleHar() {
  return {
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "GET",
            url: "https://example.test/wp-admin/",
            headers: [
              { name: "Cookie", value: "wordpress_logged_in_abc=admin|123|sig" },
              { name: "Accept", value: "text/html" },
              { name: "Authorization", value: "Bearer secret" },
            ],
            cookies: [{ name: "wordpress_logged_in_abc", value: "admin|123|sig" }],
          },
          response: {
            status: 200,
            headers: [
              { name: "set-cookie", value: "wordpress_sec_abc=xyz; HttpOnly" },
              { name: "Content-Type", value: "text/html" },
            ],
            cookies: [{ name: "wordpress_sec_abc", value: "xyz" }],
            _transferSize: 4321,
            bodySize: 4000,
          },
          timings: { wait: 12 },
        },
      ],
    },
  };
}

describe("redactHar", () => {
  it("scrubs cookie/set-cookie/authorization headers and cookies arrays, keeps sizes", () => {
    const har = sampleHar();
    const n = redactHar(har);
    const e = har.log.entries[0]!;
    expect(n).toBe(5); // 3 headers + 2 cookie entries
    expect(e.request.headers[0]!.value).toBe(REDACTED);
    expect(e.request.headers[1]!.value).toBe("text/html");
    expect(e.request.headers[2]!.value).toBe(REDACTED);
    expect(e.request.cookies).toEqual([]);
    expect(e.response.headers[0]!.value).toBe(REDACTED);
    expect(e.response.headers[1]!.value).toBe("text/html");
    expect(e.response.cookies).toEqual([]);
    expect(e.response._transferSize).toBe(4321);
    expect(e.response.bodySize).toBe(4000);
    expect(e.timings.wait).toBe(12);
  });

  it("is idempotent and tolerant of malformed input", () => {
    const har = sampleHar();
    redactHar(har);
    expect(redactHar(har)).toBe(0);
    expect(redactHar(null)).toBe(0);
    expect(redactHar({ log: {} })).toBe(0);
    expect(redactHar({ log: { entries: [null, 1, { request: "x" }] } })).toBe(0);
  });

  it("redactHarFile rewrites the file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uiproof-har-"));
    const p = join(dir, "network.har");
    await writeFile(p, JSON.stringify(sampleHar()), "utf8");
    const n = await redactHarFile(p);
    expect(n).toBe(5);
    const back = await readFile(p, "utf8");
    expect(back).not.toContain("wordpress_logged_in_abc=admin");
    expect(back).not.toContain("Bearer secret");
    expect(back).not.toContain("wordpress_sec_abc=xyz");
    expect(back).toContain(REDACTED);
  });
});
