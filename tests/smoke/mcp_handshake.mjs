import { spawn } from "node:child_process";
import { resolve } from "node:path";

const bin = resolve(process.cwd(), "dist/bin/rolepod-uiproof.js");
const child = spawn("node", [bin], { stdio: ["pipe", "pipe", "inherit"] });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

let buf = "";
const pending = new Map();
let nextId = 1;
function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveResp) => {
    pending.set(id, resolveResp);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (err) {
      console.error("parse fail:", err, line);
    }
  }
});

const initResp = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("[init]", JSON.stringify(initResp.result?.serverInfo));

send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

const listResp = await call("tools/list", {});
const names = (listResp.result?.tools ?? []).map((t) => t.name);
console.log("[tools]", names.join(", "));

const expected = [
  // atomic (10 — v0.1-v0.4)
  "browser_open",
  "browser_close",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_scroll",
  "browser_wait_for",
  "browser_screenshot",
  "browser_navigate",
  // atomic (11 — v0.5)
  "browser_hover",
  "browser_drag",
  "browser_fill_form",
  "browser_upload_file",
  "browser_handle_dialog",
  "browser_console",
  "browser_network",
  "browser_set_env",
  "browser_evaluate",
  "browser_pages",
  "browser_switch_page",
  "extract_computed_style",
  // composite (5)
  "verify_ui_flow",
  "audit_a11y",
  "visual_diff",
  "scaffold_e2e",
  "extract_ui_state",
  // v0.7 measurement surface (3)
  "measure_cwv",
  "audit_page_budget",
  "audit_seo",
];
const missing = expected.filter((n) => !names.includes(n));
const extra = names.filter((n) => !expected.includes(n));
if (missing.length || extra.length) {
  if (missing.length) console.error("MISSING:", missing);
  if (extra.length) console.error("UNEXPECTED:", extra);
  process.exit(1);
}
if (names.length !== expected.length) {
  console.error(`COUNT mismatch: advertised ${names.length}, expected ${expected.length}`);
  process.exit(1);
}

// Strict input schema: an unknown top-level key must be rejected, not silently
// stripped (a typo'd param used to drop to a default and mislead).
const strictResp = await call("tools/call", {
  name: "browser_close",
  arguments: { session_id: "nope", bogus_unknown_key: 1 },
});
const strictText = JSON.stringify(strictResp);
if (!/unrecognized|bogus_unknown_key/i.test(strictText)) {
  console.error("STRICT schema not enforced — unknown key was not rejected:", strictText.slice(0, 300));
  process.exit(1);
}
console.log("[strict] unknown top-level key rejected");

console.log("OK");
child.kill("SIGTERM");
setTimeout(() => process.exit(0), 200);
