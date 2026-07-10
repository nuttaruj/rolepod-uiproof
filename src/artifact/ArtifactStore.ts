import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { RolepodMcpError } from "../util/errors.js";
import { log } from "../util/log.js";
import { detectRolepodParent } from "../util/rolepodProtocol.js";

/**
 * Writes run artifacts. In **standalone** mode (default) — and in v0.4 and
 * earlier — runs live under `./.rolepod-uiproof/artifacts/{prefix}_{ts}_{uuid}/`.
 *
 * In **with-parent** mode — activated automatically when the marker file
 * `<git-root>/.rolepod/parent-active` exists (written by the parent
 * `rolepod` plugin's v2.7+ SessionStart hook) — runs live under
 * `<git-root>/.rolepod/evidence/{ts}-rolepod-uiproof-{skill}/`, per the
 * Extension Protocol v1 evidence-path convention. Parent's `check-work`
 * skill aggregates manifest.json files from this directory.
 *
 * Note: with-parent runs anchor at the git root (resolved via
 * `git rev-parse --show-toplevel`), so a uiproof skill invoked from a
 * subdirectory still lands under the worktree root where `check-work`
 * looks. Standalone runs stay anchored at `process.cwd()` — same as
 * pre-v0.6 behavior.
 *
 * Baselines for `visual_diff` always live in `./.rolepod-uiproof/baselines/`
 * regardless of mode — they are user-curated configuration, not per-run
 * evidence.
 */
export type ReplayStep = Record<string, unknown>;

export type ReplayBundle = {
  version: 1;
  run_id: string;
  recorded_at: string;
  open: Record<string, unknown>;
  steps: ReplayStep[];
  expect: ReplayStep[];
};

export type ArtifactPaths = {
  screenshots: string[];
  replay_bundle?: string;
};

export type ArtifactMode = "standalone" | "with-parent";

export type StartRunOptions = {
  /**
   * Skill name as it appears in marketplace (`verify-ui`, `audit-a11y`,
   * `visual-diff`, `scaffold-e2e`, `check-errors`). REQUIRED when emitting
   * a manifest.json (Extension Protocol v1) so parent's `check-work` can
   * route artifacts to the right phase.
   *
   * In `with-parent` mode the run dirname is derived from this field; if
   * omitted the `prefix` argument is used as a fallback (legacy).
   */
  skill?: string;
};

export type StartRunResult = {
  runId: string;
  runDir: string;
  skill: string;
  mode: ArtifactMode;
};

export class ArtifactStore {
  rootDir: string;
  mode: ArtifactMode;
  private readonly baselineRoot: string;
  private readonly pinned: boolean;
  private evidenceGitignoreEnsured = false;

  constructor(
    opts: { rootDir?: string; mode?: ArtifactMode } = {},
  ) {
    // An explicit rootDir or mode pins the store (tests, fixed roots). When
    // neither is given (the production default), mode is re-detected per run
    // so a parent marker written after boot is honoured — see refreshMode.
    this.pinned = opts.rootDir !== undefined || opts.mode !== undefined;

    const parent = detectRolepodParent();
    this.mode = opts.mode ?? (parent.active ? "with-parent" : "standalone");
    this.rootDir =
      opts.rootDir !== undefined
        ? opts.rootDir
        : this.deriveRoot(this.mode, parent.gitRoot);

    // Baselines are config, not evidence — always live in the standalone
    // location so visual_diff sees the same set across modes.
    this.baselineRoot = resolve(process.cwd(), ".rolepod-uiproof", "baselines");
  }

  private deriveRoot(mode: ArtifactMode, gitRoot: string): string {
    // with-parent anchors evidence at git root so `check-work` finds it
    // regardless of which subdirectory the skill was invoked from.
    return mode === "with-parent"
      ? resolve(gitRoot, ".rolepod", "evidence")
      : resolve(process.cwd(), ".rolepod-uiproof", "artifacts");
  }

  /**
   * Re-detect parent mode at run time when the store was not pinned. The
   * parent `rolepod` plugin's SessionStart hook can write
   * `.rolepod/parent-active` after this MCP server already spawned; freezing
   * mode at construction would strand evidence in the standalone dir where
   * `check-work` never looks.
   */
  private refreshMode(): void {
    if (this.pinned) return;
    const parent = detectRolepodParent();
    const mode: ArtifactMode = parent.active ? "with-parent" : "standalone";
    if (mode === this.mode) return;
    this.mode = mode;
    this.rootDir = this.deriveRoot(mode, parent.gitRoot);
    this.evidenceGitignoreEnsured = false; // new root needs its own .gitignore
  }

  /**
   * Allocate a fresh run dir and ensure it exists.
   *
   * - standalone: `./.rolepod-uiproof/artifacts/{prefix}_{ts}_{uuid}/`
   * - with-parent: `<git-root>/.rolepod/evidence/{ts}-rolepod-uiproof-{skill}/`
   *
   * `prefix` is preserved for back-compat with v0.5 callers; new callers
   * should also pass `opts.skill` so the with-parent path can be derived
   * unambiguously and the manifest can be emitted with the canonical
   * skill name.
   */
  async startRun(
    prefix = "run",
    opts: StartRunOptions = {},
  ): Promise<StartRunResult> {
    this.refreshMode();
    const ts = this.timestampSlug();
    const skill = opts.skill ?? prefix;

    let runId: string;
    if (this.mode === "with-parent") {
      // Parent expects a flat, sortable dirname; the short uuid keeps two runs
      // of the same skill within one second from clobbering each other's
      // evidence while preserving the sortable `${ts}-…` prefix.
      runId = `${ts}-rolepod-uiproof-${skill}-${randomUUID().slice(0, 6)}`;
    } else {
      runId = `${prefix}_${ts}_${randomUUID().slice(0, 8)}`;
    }

    await this.ensureEvidenceGitignore();
    const runDir = resolve(this.rootDir, runId);
    await mkdir(runDir, { recursive: true });
    log.debug("artifact run started", {
      run_id: runId,
      dir: runDir,
      mode: this.mode,
      skill,
    });
    return { runId, runDir, skill, mode: this.mode };
  }

  /**
   * Drop a self-ignoring `.gitignore` (`*`) at the evidence/artifacts root the
   * first time we write there, so a consumer's `git add -A` never sweeps
   * transient run artifacts (screenshots, manifests, diffs) into a commit.
   * Scoped to the evidence root only: baselines live elsewhere and stay
   * commit-able, and in with-parent mode the parent's own `.rolepod/` files
   * are untouched. Mirrors how codegraph self-ignores `.codegraph/`.
   */
  private async ensureEvidenceGitignore(): Promise<void> {
    if (this.evidenceGitignoreEnsured) return;
    this.evidenceGitignoreEnsured = true;
    const gitignorePath = resolve(this.rootDir, ".gitignore");
    if (existsSync(gitignorePath)) return;
    try {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(gitignorePath, "*\n", "utf8");
    } catch (err) {
      log.debug("could not write evidence .gitignore", { err: String(err) });
    }
  }

  async writeScreenshot(
    runDir: string,
    buf: Buffer,
    name: string,
  ): Promise<string> {
    const path = resolve(runDir, `${name}.png`);
    await writeFile(path, buf);
    return path;
  }

  async writeReplayBundle(
    runDir: string,
    bundle: ReplayBundle,
    name = "replay.json",
  ): Promise<string> {
    const path = resolve(runDir, name);
    await writeFile(path, JSON.stringify(bundle, null, 2), "utf8");
    return path;
  }

  async writeReport(runDir: string, name: string, body: string): Promise<string> {
    const path = this.resolveInside(runDir, name);
    await writeFile(path, body, "utf8");
    return path;
  }

  async writeBytes(runDir: string, name: string, buf: Buffer): Promise<string> {
    const path = this.resolveInside(runDir, name);
    await writeFile(path, buf);
    return path;
  }

  /**
   * Resolve `name` under `runDir`, rejecting any name that escapes the run
   * directory. A caller-supplied filename (e.g. scaffold_e2e's `filename`)
   * must never write outside the run dir via an absolute path or `../`.
   */
  private resolveInside(runDir: string, name: string): string {
    const base = resolve(runDir);
    const target = resolve(base, name);
    if (isAbsolute(name) || (target !== base && !target.startsWith(base + sep))) {
      throw new RolepodMcpError(
        "invalid_input",
        `Artifact name "${name}" escapes the run directory.`,
        { name },
      );
    }
    return target;
  }

  async ensureDir(absDir: string): Promise<string> {
    await mkdir(absDir, { recursive: true });
    return absDir;
  }

  /** Root for stored visual baselines: `./.rolepod-uiproof/baselines/`. */
  get baselineDir(): string {
    return this.baselineRoot;
  }

  private timestampSlug(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}` +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds())
    );
  }
}
