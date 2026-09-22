import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/install-opencode.sh — the one-line opencode install. It merges one
 * `mcp.servers.rolepod-uiproof` entry and one skill-catalog URL into an
 * opencode.json and must leave every other key alone, be idempotent, refuse
 * non-JSON rather than clobber it, and take only its own entries back out on
 * --uninstall. Runs bash, so it skips on the Windows CI lane.
 */
const repoRoot = resolve(__dirname, "..", "..");
const script = resolve(repoRoot, "scripts", "install-opencode.sh");
const version = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version as string;
const CATALOG = "https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/skills/";
const WPLAB = "https://raw.githubusercontent.com/nuttaruj/rolepod-wplab/main/skills/";
// macOS ships bash 3.2 at /bin/bash; `curl … | bash` lands there on a stock
// Mac, so the warning path (the one that expands `$*`) runs under it too.
const STOCK_BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

type Cfg = {
  $schema?: string;
  model?: string;
  mcp?: Record<string, unknown> & { servers?: Record<string, Record<string, unknown>> };
  skills?: string[];
};

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "uiproof-octest-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const run = (args: string[], opts: { target?: string; cwd?: string; env?: Record<string, string>; bash?: string } = {}) =>
  spawnSync(opts.bash ?? "bash", [script, ...args], {
    cwd: opts.cwd ?? tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      // "" reads as unset to the script's `${VAR:-}` / `-n` tests — neutralize
      // whatever the developer's shell exports.
      OPENCODE_CONFIG_DIR: "",
      ROLEPOD_UIPROOF_REF: "",
      ROLEPOD_UIPROOF_OPENCODE_TARGET: "",
      ...(opts.target ? { ROLEPOD_UIPROOF_OPENCODE_TARGET: opts.target } : {}),
      ...opts.env,
    },
  });
const readCfg = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Cfg;
const expectedServer = (spec = `@rolepod/uiproof@${version}`) => ({
  type: "local",
  command: ["npx", "-y", spec],
  environment: { npm_config_audit: "false", npm_config_fund: "false" },
  codemode: false,
});
const globalFile = () => join(tmp, ".config", "opencode", "opencode.json");

describe.skipIf(process.platform === "win32")("scripts/install-opencode.sh", () => {
  it("parses (bash -n), prints --help, and rejects an unknown flag", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
    const h = run(["--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("--uninstall");
    const r = run(["--nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("creates ~/.config/opencode/opencode.json when there is none", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    const cfg = readCfg(globalFile());
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.mcp?.servers?.["rolepod-uiproof"]).toEqual(expectedServer());
    expect(cfg.skills).toEqual([CATALOG]);
    expect(existsSync(`${globalFile()}.rolepod-uiproof-bak`)).toBe(false);
    expect(r.stdout).toContain("opencode service restart");
  });

  it("warns about an exported OPENCODE_CONFIG_DIR and still installs (stock bash)", () => {
    const r = run([], { env: { OPENCODE_CONFIG_DIR: join(tmp, "orca") }, bash: STOCK_BASH });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("OPENCODE_CONFIG_DIR=");
    expect(r.stderr).toContain('ROLEPOD_UIPROOF_OPENCODE_TARGET="$OPENCODE_CONFIG_DIR"');
    expect(readCfg(globalFile()).mcp?.servers?.["rolepod-uiproof"]).toEqual(expectedServer());
    expect(existsSync(join(tmp, "orca"))).toBe(false);
  });

  it("merges into an existing config, keeps everything else, backs it up, and is idempotent", () => {
    const target = join(tmp, "cfg");
    mkdirSync(target, { recursive: true });
    const file = join(target, "opencode.json");
    const before: Cfg = {
      $schema: "https://opencode.ai/config.json",
      model: "omniroute/omni-speed",
      mcp: {
        servers: { "rolepod-wplab": { type: "local", command: ["rolepod-wplab"] } },
        "rolepod-uiproof": { type: "local", command: ["npx", "-y", "@rolepod/uiproof"], enabled: true }, // stale v1 shape
      },
      skills: [WPLAB, "https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/v0.20.0/skills/"],
    };
    writeFileSync(file, JSON.stringify(before, null, 2));
    expect(run([], { target }).status).toBe(0);
    const once = readFileSync(file, "utf8");
    const cfg = readCfg(file);
    expect(cfg.model).toBe("omniroute/omni-speed");
    expect(cfg.mcp?.servers?.["rolepod-wplab"]).toEqual(before.mcp!.servers!["rolepod-wplab"]);
    expect(cfg.mcp?.["rolepod-uiproof"]).toBeUndefined();
    expect(cfg.mcp?.servers?.["rolepod-uiproof"]).toEqual(expectedServer());
    // the old pinned catalog is replaced, not duplicated; foreign sources stay
    expect(cfg.skills).toEqual([WPLAB, CATALOG]);
    expect(JSON.parse(readFileSync(`${file}.rolepod-uiproof-bak`, "utf8"))).toEqual(before);

    expect(run([], { target }).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("treats an empty or BOM-prefixed file as a fresh config", () => {
    const target = join(tmp, "empty");
    mkdirSync(target);
    const file = join(target, "opencode.json");
    writeFileSync(file, "");
    expect(run([], { target }).status).toBe(0);
    expect(readCfg(file).$schema).toBe("https://opencode.ai/config.json");
    writeFileSync(file, "﻿" + JSON.stringify({ model: "x" }));
    expect(run([], { target }).status).toBe(0);
    expect(readCfg(file).model).toBe("x");
  });

  it("--project writes $PWD/.opencode/opencode.json", () => {
    const proj = join(tmp, "proj");
    mkdirSync(proj);
    expect(run(["--project"], { cwd: proj }).status).toBe(0);
    const cfg = readCfg(join(proj, ".opencode", "opencode.json"));
    expect(cfg.mcp?.servers?.["rolepod-uiproof"]).toEqual(expectedServer());
    expect(existsSync(globalFile())).toBe(false);
  });

  it("--project inside this checkout spawns the local build instead of npx", () => {
    const target = join(tmp, "dev");
    const r = run(["--project"], { cwd: repoRoot, target });
    expect(r.status, r.stderr).toBe(0);
    const cfg = readCfg(join(target, "opencode.json"));
    expect(cfg.mcp?.servers?.["rolepod-uiproof"]?.command).toEqual([
      "node",
      resolve(repoRoot, "dist", "bin", "rolepod-uiproof.js"),
    ]);
    expect(r.stdout).toContain("local build");
  });

  it("ROLEPOD_UIPROOF_REF pins both the npm spec and the catalog", () => {
    const target = join(tmp, "pinned");
    expect(run([], { target, env: { ROLEPOD_UIPROOF_REF: "v0.19.0" } }).status).toBe(0);
    const cfg = readCfg(join(target, "opencode.json"));
    expect(cfg.mcp?.servers?.["rolepod-uiproof"]).toEqual(expectedServer("@rolepod/uiproof@0.19.0"));
    expect(cfg.skills).toEqual(["https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/v0.19.0/skills/"]);
    // a branch ref with a slash is still recognised as ours on the next install
    expect(run([], { target, env: { ROLEPOD_UIPROOF_REF: "feature/x" } }).status).toBe(0);
    expect(run([], { target }).status).toBe(0);
    expect(readCfg(join(target, "opencode.json")).skills).toEqual([CATALOG]);
  });

  it("--uninstall removes only our entries (both shapes) and prunes containers it emptied", () => {
    const target = join(tmp, "un");
    mkdirSync(target);
    const file = join(target, "opencode.json");
    const others = {
      model: "x",
      mcp: { servers: { "rolepod-wplab": { type: "local", command: ["w"] } } },
      skills: [WPLAB],
    };
    writeFileSync(file, JSON.stringify(others));
    expect(run([], { target }).status).toBe(0);
    expect(run(["--uninstall"], { target }).status).toBe(0);
    expect(readCfg(file)).toEqual(others);

    // a v1-shaped entry left by an older opencode is removed too
    writeFileSync(file, JSON.stringify({ ...others, mcp: { ...others.mcp, "rolepod-uiproof": { type: "local", command: ["x"] } } }));
    expect(run(["--uninstall"], { target }).status).toBe(0);
    expect(readCfg(file)).toEqual(others);

    // only ours present → mcp and skills disappear entirely
    const solo = join(tmp, "solo");
    expect(run([], { target: solo }).status).toBe(0);
    expect(run(["--uninstall"], { target: solo }).status).toBe(0);
    expect(readCfg(join(solo, "opencode.json"))).toEqual({ $schema: "https://opencode.ai/config.json" });

    // nothing installed → success, no file or dir created
    const none = join(tmp, "none");
    const r = run(["--uninstall"], { target: none });
    expect(r.status).toBe(0);
    expect(existsSync(none)).toBe(false);
  });

  it.each([
    ["a comment", '{\n  // a comment\n  "model": "x",\n}\n', "not plain JSON"],
    ["a top-level array", "[]\n", "top level is not an object"],
    ["a non-object mcp", '{"mcp": "nope"}\n', '"mcp" is not an object'],
    ["a non-object mcp.servers", '{"mcp": {"servers": []}}\n', '"mcp.servers" is not an object'],
    ["a non-array skills", '{"skills": "x"}\n', '"skills" is not an array'],
  ])("refuses a file with %s and leaves it untouched", (_what, raw, message) => {
    const target = join(tmp, "bad");
    mkdirSync(target, { recursive: true });
    const file = join(target, "opencode.json");
    writeFileSync(file, raw);
    const r = run([], { target });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(existsSync(`${file}.rolepod-uiproof-bak`)).toBe(false);
  });
});
