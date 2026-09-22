#!/usr/bin/env bash
# rolepod-uiproof → opencode. opencode reads MCP servers and skill sources from
# opencode.json — ~/.config/opencode/opencode.json globally, <project>/.opencode/opencode.json
# per project (opencode.ai/v2/docs/config) — and has no marketplace, so this script
# merges one server entry and one skill-catalog URL into that file. Nothing is copied:
# the server comes from npm at launch (npx, version pinned below) and the skills from
# skills/index.json in this repo, which opencode fetches and caches itself.
#
# From a checkout:
#   scripts/install-opencode.sh [--project] [--uninstall]
# Without one (install and update are the same command):
#   curl -fsSL https://raw.githubusercontent.com/nuttaruj/rolepod-uiproof/main/scripts/install-opencode.sh | bash -s -- [--project] [--uninstall]
#
# Flags:
#   --project    write $PWD/.opencode/opencode.json instead of ~/.config/opencode/opencode.json
#   --uninstall  remove the rolepod-uiproof server entry and catalog URL; nothing else is touched
# Env:
#   ROLEPOD_UIPROOF_OPENCODE_TARGET  opencode config dir to write into (overrides both scopes)
#   ROLEPOD_UIPROOF_REF              release tag to pin, vX.Y.Z → npx @rolepod/uiproof@X.Y.Z and the
#                                    catalog at that tag (default: the spec below, catalog on main)
set -euo pipefail

REPO="nuttaruj/rolepod-uiproof"
RAW="https://raw.githubusercontent.com/$REPO/main/scripts/install-opencode.sh"
# Pinned like every other spawn config; tests/unit/version_lockstep.test.ts keeps it on package.json.
PACKAGE_SPEC="@rolepod/uiproof@0.22.0"
SERVER="rolepod-uiproof"

SCOPE=global
MODE=install
for a in "$@"; do
  case "$a" in
    --project)   SCOPE=project ;;
    --uninstall) MODE=uninstall ;;
    -h|--help)
      cat <<'USAGE'
usage: install-opencode.sh [--project] [--uninstall]
  --project    write $PWD/.opencode/opencode.json (default: ~/.config/opencode/opencode.json)
  --uninstall  remove the rolepod-uiproof server entry + skill catalog from that file
env: ROLEPOD_UIPROOF_OPENCODE_TARGET=<config dir>  ROLEPOD_UIPROOF_REF=<release tag, vX.Y.Z>
USAGE
      exit 0 ;;
    *) echo "install-opencode.sh: unknown flag: $a (try --help)" >&2; exit 2 ;;
  esac
done

# How this run was invoked — a checkout of this repo, or the curl form when piped.
CHECKOUT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -d "$here/skills" ] && grep -q '"name": "@rolepod/uiproof"' "$here/package.json" 2>/dev/null; then CHECKOUT="$here"; fi
fi

if [ -n "${ROLEPOD_UIPROOF_OPENCODE_TARGET:-}" ]; then
  TARGET="$ROLEPOD_UIPROOF_OPENCODE_TARGET"
elif [ "$SCOPE" = project ]; then
  TARGET="$PWD/.opencode"
else
  TARGET="$HOME/.config/opencode"
  if [ -n "${OPENCODE_CONFIG_DIR:-}" ] && [ "$OPENCODE_CONFIG_DIR" != "$TARGET" ]; then
    echo "  ! OPENCODE_CONFIG_DIR=$OPENCODE_CONFIG_DIR — opencode started from this shell reads that directory as well (higher priority than $TARGET)." >&2
    echo "    Installing into $TARGET. To install there instead:" >&2
    if [ -n "$CHECKOUT" ]; then
      echo "      ROLEPOD_UIPROOF_OPENCODE_TARGET=\"\$OPENCODE_CONFIG_DIR\" ${BASH_SOURCE[0]} ${*:-}" >&2
    else
      echo "      curl -fsSL $RAW | ROLEPOD_UIPROOF_OPENCODE_TARGET=\"\$OPENCODE_CONFIG_DIR\" bash -s -- ${*:-}" >&2
    fi
  fi
fi
FILE="$TARGET/opencode.json"

# The MCP server runs on Node ≥20, so node is also what edits the JSON here.
command -v node >/dev/null 2>&1 || { echo "install-opencode.sh: node is required (the MCP server runs on it)" >&2; exit 1; }

# ── what to write ────────────────────────────────────────────────────────
REF="${ROLEPOD_UIPROOF_REF:-}"
if [ -n "$REF" ]; then
  SPEC="@rolepod/uiproof@${REF#v}"
  CATALOG_REF="$REF"
else
  SPEC="$PACKAGE_SPEC"
  CATALOG_REF="main"
fi
CATALOG="https://raw.githubusercontent.com/$REPO/$CATALOG_REF/skills/"
LAUNCH=npx
LAUNCH_ARG="$SPEC"
DEV_NOTE=""
# Inside a checkout of this very repo, `npx @rolepod/uiproof@<v>` resolves to the
# local package and fails (no node_modules bin) — the same trap .mcp.json avoids.
# A per-project install there points at the checkout's build instead.
if [ -n "$CHECKOUT" ] && [ "$SCOPE" = project ] && [ "$PWD" = "$CHECKOUT" ]; then
  LAUNCH=node
  LAUNCH_ARG="$CHECKOUT/dist/bin/rolepod-uiproof.js"
  DEV_NOTE="    (checkout: the server runs the local build — npm run build first)"
fi

# ── merge / remove, leaving every other key alone ────────────────────────
# Refuses a file that is not plain JSON (comments, trailing commas) rather than
# rewriting it; opencode itself re-serializes this file on `opencode mcp add`.
[ "$MODE" = uninstall ] || mkdir -p "$TARGET"
node - "$FILE" "$MODE" "$SERVER" "$LAUNCH" "$LAUNCH_ARG" "$CATALOG" <<'JS'
const fs = require("fs");
const [file, mode, server, launch, launchArg, catalog] = process.argv.slice(2);
const die = (m) => { console.error(`install-opencode.sh: ${m}`); process.exit(1); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ours = (u) =>
  typeof u === "string" &&
  /^https:\/\/raw\.githubusercontent\.com\/nuttaruj\/rolepod-uiproof\/.+\/skills\/?$/.test(u);
const exists = fs.existsSync(file);
let raw = "";
let cfg = {};
if (exists) {
  raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (raw.trim()) {
    try { cfg = JSON.parse(raw); } catch (e) { die(`${file} is not plain JSON (${e.message}) — edit it by hand; nothing written`); }
  }
  if (!isObj(cfg)) die(`${file}: top level is not an object; nothing written`);
}
if (cfg.mcp !== undefined && !isObj(cfg.mcp)) die(`${file}: "mcp" is not an object; nothing written`);
if (cfg.mcp?.servers !== undefined && !isObj(cfg.mcp.servers)) die(`${file}: "mcp.servers" is not an object; nothing written`);
if (cfg.skills !== undefined && !Array.isArray(cfg.skills)) die(`${file}: "skills" is not an array; nothing written`);
const write = () => {
  if (exists) fs.copyFileSync(file, `${file}.rolepod-uiproof-bak`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
};
if (mode === "uninstall") {
  if (!exists) { console.log(`  ✓ nothing to remove — ${file} does not exist`); process.exit(0); }
  let removed = false;
  if (cfg.mcp?.servers && server in cfg.mcp.servers) {
    delete cfg.mcp.servers[server]; removed = true;
    if (!Object.keys(cfg.mcp.servers).length) delete cfg.mcp.servers;
  }
  if (cfg.mcp && server in cfg.mcp) { delete cfg.mcp[server]; removed = true; } // v1-shaped entry
  if (cfg.mcp && !Object.keys(cfg.mcp).length) delete cfg.mcp;
  if (cfg.skills) {
    const kept = cfg.skills.filter((u) => !ours(u));
    if (kept.length !== cfg.skills.length) removed = true;
    if (kept.length) cfg.skills = kept; else delete cfg.skills;
  }
  if (!removed) { console.log(`  ✓ nothing to remove — ${server} is not in ${file}`); process.exit(0); }
  write();
  console.log(`  ✓ ${server} removed from ${file}; other servers and skill sources untouched`);
  process.exit(0);
}
if (!raw.trim()) cfg = { $schema: "https://opencode.ai/config.json", ...cfg };
cfg.mcp = cfg.mcp ?? {};
if (server in cfg.mcp) delete cfg.mcp[server]; // stale v1-shaped entry
cfg.mcp.servers = cfg.mcp.servers ?? {};
cfg.mcp.servers[server] = {
  type: "local",
  command: launch === "node" ? ["node", launchArg] : ["npx", "-y", launchArg],
  // Cold `npx` runs `npm audit` against the registry (190-320 s measured) —
  // past opencode's 30 s startup timeout. Off, the cold start is seconds.
  environment: { npm_config_audit: "false", npm_config_fund: "false" },
  // opencode's default Code Mode hides MCP tools behind execute/query; the
  // skills call them by name, so expose them directly.
  codemode: false,
};
cfg.skills = [...(cfg.skills ?? []).filter((u) => !ours(u)), catalog];
write();
console.log(`  ✓ ${server} (${launchArg}) → ${file}`);
console.log(`    mcp.servers.${server} + skills catalog ${catalog}${exists ? `; previous file kept as ${file}.rolepod-uiproof-bak` : ""}`);
JS
[ -z "$DEV_NOTE" ] || echo "$DEV_NOTE"
[ "$MODE" = uninstall ] || echo "    restart opencode (opencode service restart); the first prompt in a project connects the server — \`opencode mcp list\` shows it"
