import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

// Gemini's function-declaration converter rejects a tool whose parameter is
// literally named after a JSON-Schema keyword (e.g. `properties`).
const KEYWORDS = new Set([
  "properties", "items", "type", "required", "enum", "format", "description",
  "default", "anyOf", "oneOf", "allOf", "not", "const", "minimum",
  "maximum", "additionalProperties", "$ref",
]);
// `pattern` is deliberately not listed: the wait_for / expect conditions
// already ship a string param named `pattern` (public contract) and Gemini
// accepts it; only `properties` is proven to be rejected.

function collect(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => collect(n, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const props = obj.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const key of Object.keys(props)) {
      if (KEYWORDS.has(key)) out.push(`${path}.properties.${key}`);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "properties" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v)) collect(pv, `${path}.properties.${pk}`, out);
    } else {
      collect(v, `${path}.${k}`, out);
    }
  }
}

describe("tools/list input schemas", () => {
  const handle = buildServer();
  afterAll(async () => {
    await handle.shutdown();
  });

  it("no tool parameter is named after a JSON-Schema keyword", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([handle.mcp.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const t of tools) collect(t.inputSchema, t.name, bad);
    expect(bad).toEqual([]);
    await client.close();
  });
});
