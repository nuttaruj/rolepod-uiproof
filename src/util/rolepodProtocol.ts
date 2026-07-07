import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/**
 * Extension Protocol — detection of the parent `rolepod` plugin.
 *
 * # Why a marker file (and not an env var)
 *
 * v0.6.0 attempted to detect the parent via `process.env.ROLEPOD_PARENT === "1"`.
 * That mechanism does not work in Claude Code: the SessionStart hook runs in
 * its own subprocess, and the env vars it sets do not propagate to the Bash
 * tool or to the MCP server subprocess Claude later spawns. So the env was
 * never visible to uiproof, and combined mode never activated.
 *
 * v0.6.1 switches to a filesystem marker that the parent `rolepod` plugin's
 * SessionStart hook writes:
 *
 *   <git-root>/.rolepod/parent-active
 *
 * Content (UTF-8, single trimmed line): the protocol version string. v1 ships
 * `"v1"`. The marker is removed by the parent's Stop hook when no other
 * rolepod sessions hold locks on the same worktree.
 *
 * Detection is read-on-demand by callers — there is no caching. The marker
 * file existsSync check is sub-millisecond and runs at most twice per server
 * boot today (ArtifactStore constructor + checkProtocolCompat).
 */
export interface ParentState {
  /** True iff the marker file exists. */
  active: boolean;
  /** First trimmed line of the marker (the protocol version), or null. */
  protocol: string | null;
  /** Resolved git root (or `cwd` fallback when not in a git work tree). */
  gitRoot: string;
}

export function detectRolepodParent(cwd: string = process.cwd()): ParentState {
  let gitRoot = cwd;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // non-git project — keep cwd. The marker can't exist outside a repo
    // anyway, so this fallback is purely defensive.
  }

  const file = join(gitRoot, ".rolepod", "parent-active");
  if (!existsSync(file)) {
    return { active: false, protocol: null, gitRoot };
  }

  try {
    const protocol = readFileSync(file, "utf8").trim().split(/\r?\n/)[0] ?? null;
    return { active: true, protocol, gitRoot };
  } catch (err) {
    // Marker exists but is unreadable — a directory (EISDIR, e.g. the typo
    // `mkdir -p .rolepod/parent-active`) or no read permission (EACCES).
    // Degrade to standalone instead of crashing the whole server at boot:
    // detectRolepodParent runs inside buildServer before any tool registers,
    // so an unguarded throw here takes down all 30 tools with a raw fs stack.
    log.warn("rolepod parent marker unreadable — treating as standalone", {
      file,
      err: String(err),
    });
    return { active: false, protocol: null, gitRoot };
  }
}

/**
 * Manual-override hint for documentation only — implementation does not call
 * this. Users can force combined mode without a real parent session by
 * touching the marker file:
 *
 *   mkdir -p .rolepod && echo v1 > .rolepod/parent-active
 *
 * And force back to standalone with:
 *
 *   rm -f .rolepod/parent-active
 */
export const MARKER_RELPATH = ".rolepod/parent-active" as const;
