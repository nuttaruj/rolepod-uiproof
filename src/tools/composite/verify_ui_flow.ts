import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  ToolNames,
  verifyUiFlowShape,
  type A11yNode,
  type VerifyUiFlowInput,
} from "../../schema/tools.js";
import type {
  A11ySnapshot,
  Engine,
  OpenOptions,
  Session,
} from "../../engine/Engine.js";
import { ddmin } from "../../replay/minimize.js";
import { RolepodMcpError } from "../../util/errors.js";
import { writeManifest, type ManifestArtifact } from "../../util/manifest.js";
import { ok, safeHandler } from "../result.js";
import type { ToolContext, ToolModule } from "../types.js";

/** Expectation kinds that can only be evaluated on a web (Playwright) session. */
const WEB_ONLY_EXPECTS = new Set([
  "no_console_errors",
  "no_failed_requests",
  "request_made",
  "response_status",
]);

/**
 * Composite `verify_ui_flow` — drive a session through steps and evaluate
 * expectations against the resulting state.
 *
 * - `mode: 'assert'` (default): pass = "expected feature works".
 * - `mode: 'reproduce'`: pass = "expected bug surfaced". When `minimize`
 *   is true (default) and the initial run reproduces, the composite
 *   performs a linear delta-removal pass over `steps` to find a smaller
 *   sequence that still reproduces. See D-025.
 */
export const verifyUiFlowTool: ToolModule<typeof verifyUiFlowShape> = {
  name: ToolNames.verifyUiFlow,
  description:
    "Open a session, run UI steps, evaluate assertions, and save evidence. Set mode='reproduce' for bug reproduction with optional step minimization.",
  inputShape: verifyUiFlowShape,
  build(ctx) {
    return safeHandler(async (args: VerifyUiFlowInput) => {
      const startedAt = new Date().toISOString();
      const { runId, runDir, skill } = await ctx.store.startRun(
        "verify",
        { skill: "verify-ui" },
      );

      const initial = await runFlow(ctx, args, args.steps, runDir, {
        captureEvidence: true,
        bundleName: "replay.json",
      });

      const result: Record<string, unknown> = {
        run_id: runId,
        mode: args.mode,
        passed: initial.passed,
        evidence_paths: initial.evidence,
      };
      if (initial.failedAtStep !== undefined) result.failed_at_step = initial.failedAtStep;
      if (initial.failureReason !== undefined) result.failure_reason = initial.failureReason;
      if (initial.finalUrl !== undefined) result.final_url_or_screen = initial.finalUrl;

      if (args.mode === "reproduce" && initial.passed && args.minimize) {
        const min = await minimize(ctx, args, args.steps, runDir);
        result.minimized = {
          original_step_count: args.steps.length,
          minimized_step_count: min.steps.length,
          minimal_steps: min.steps,
          steps_removed: min.removed,
          replay_bundle: min.replayPath,
          attempts: min.attempts,
        };
      }

      const manifestPath = await writeManifest({
        runDir,
        skill,
        phase: "verify",
        status: initial.passed ? "pass" : "fail",
        summary: buildVerifySummary(args, initial),
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts: flattenVerifyEvidence(initial.evidence),
        metadata: {
          mode: args.mode,
          step_count: args.steps.length,
          expect_count: args.expect.length,
          ...(initial.finalUrl !== undefined ? { final_url: initial.finalUrl } : {}),
        },
      });
      if (manifestPath) result.manifest = manifestPath;

      return ok(result);
    });
  },
};

function buildVerifySummary(
  args: VerifyUiFlowInput,
  outcome: RunOutcome,
): string {
  const stepCount = args.steps.length;
  const expectCount = args.expect.length;
  if (outcome.passed) {
    return `${stepCount} step(s), ${expectCount} expect(s) passed`;
  }
  if (outcome.failedAtStep !== undefined) {
    return `failed at step ${outcome.failedAtStep}: ${outcome.failureReason ?? "unknown"}`;
  }
  return `failed: ${outcome.failureReason ?? "unknown"}`;
}

function flattenVerifyEvidence(ev: Evidence): ManifestArtifact[] {
  const out: ManifestArtifact[] = [];
  for (const s of ev.screenshots) out.push({ type: "screenshot", path: s });
  if (ev.replay_bundle) out.push({ type: "replay_bundle", path: ev.replay_bundle });
  if (ev.console) out.push({ type: "console", path: ev.console });
  if (ev.a11y_tree) out.push({ type: "a11y_tree", path: ev.a11y_tree });
  if (ev.har) out.push({ type: "har", path: ev.har });
  if (ev.trace) out.push({ type: "trace", path: ev.trace });
  if (ev.video) for (const v of ev.video) out.push({ type: "video", path: v });
  return out;
}

// ---------------------------------------------------------------------------
// Core single-run logic — shared by the initial run and every minimization
// attempt.
// ---------------------------------------------------------------------------

type Evidence = {
  screenshots: string[];
  replay_bundle?: string;
  console?: string;
  a11y_tree?: string;
  har?: string;
  trace?: string;
  video?: string[];
};

type RunOutcome = {
  passed: boolean;
  failedAtStep?: number;
  failureReason?: string;
  finalUrl?: string;
  evidence: Evidence;
};

function buildCaptureOptions(
  captures: Set<string>,
  runDir: string,
): OpenOptions["capture"] | undefined {
  const cap: NonNullable<OpenOptions["capture"]> = {};
  if (captures.has("har")) {
    cap.har = { path: resolvePath(runDir, "network.har") };
  }
  if (captures.has("video")) {
    cap.video = { dir: resolvePath(runDir, "videos") };
  }
  if (captures.has("trace")) {
    cap.trace = { artifactDir: runDir };
  }
  return Object.keys(cap).length > 0 ? cap : undefined;
}

async function runFlow(
  ctx: ToolContext,
  args: VerifyUiFlowInput,
  steps: VerifyUiFlowInput["steps"],
  runDir: string,
  opts: { captureEvidence: boolean; bundleName: string; forceClose?: boolean },
): Promise<RunOutcome> {
  const evidence: Evidence = { screenshots: [] };
  const captures = new Set<string>(args.capture ?? ["screenshot"]);
  let passed = false;
  let failedAtStep: number | undefined;
  let failureReason: string | undefined;
  let finalSnapshot: A11ySnapshot | undefined;

  // Build OpenOptions enriched with capture lifecycle requests. The
  // engine wires recordHar / recordVideo / tracing at context creation.
  const openOpts: OpenOptions = { ...args.open };
  const captureCfg = buildCaptureOptions(captures, runDir);
  if (captureCfg) {
    openOpts.capture = captureCfg;
  }

  const session = await ctx.registry.open(openOpts);
  const engine = ctx.registry.engineFor(session.id);
  const sessionHandle: Session = { id: session.id, platform: session.platform };

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const beforeSnap = await engine.snapshot(sessionHandle);
      try {
        await runStep(engine, sessionHandle, step, beforeSnap);
      } catch (err) {
        failedAtStep = i;
        failureReason = `Step ${i} (${step.kind}) failed: ${describeError(err)}`;
        throw err;
      }
    }

    finalSnapshot = await engine.snapshot(sessionHandle);
    const isWeb = engine instanceof PlaywrightEngine;
    const failures: string[] = [];
    for (let i = 0; i < args.expect.length; i++) {
      const expectation = args.expect[i]!;
      if (!isWeb && WEB_ONLY_EXPECTS.has(expectation.kind)) {
        // Console/network assertions can't be evaluated on a mobile (Appium)
        // session; failing loudly beats silently passing an unverifiable check.
        failures.push(
          `expect[${i}] ${describeExpect(expectation)} requires a web session (unsupported on ${session.platform})`,
        );
        continue;
      }
      if (!evaluateExpect(expectation, finalSnapshot, engine, session.id)) {
        failures.push(`expect[${i}] ${describeExpect(expectation)}`);
      }
    }
    if (args.mode === "assert" && args.expect.length === 0) {
      // An assert run with no expectations verified nothing — never report a
      // pass, or a typo'd `expect` key (which zod drops to the []-default)
      // would silently succeed.
      passed = false;
      failureReason =
        "No expectations declared — nothing was verified. Add at least one `expect` (e.g. text_visible) so the run asserts on the result.";
    } else if (failures.length === 0) {
      passed = true;
    } else {
      failureReason = `Expectations failed: ${failures.join("; ")}`;
    }
  } catch (err) {
    if (!failureReason) failureReason = describeError(err);
    passed = false;
  } finally {
    if (opts.captureEvidence) {
      if (captures.has("screenshot")) {
        try {
          const buf = await engine.screenshot(sessionHandle, true);
          const p = await ctx.store.writeScreenshot(runDir, buf, "final");
          evidence.screenshots.push(p);
        } catch (err) {
          failureReason ??= `screenshot capture failed: ${describeError(err)}`;
        }
      }

      if (captures.has("console") && engine instanceof PlaywrightEngine) {
        try {
          const messages = engine.peekBuffers(session.id).console;
          evidence.console = await ctx.store.writeReport(
            runDir,
            "console.json",
            JSON.stringify(
              {
                count: messages.length,
                by_level: countByLevel(messages),
                messages,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          failureReason ??= `console capture failed: ${describeError(err)}`;
        }
      }

      if (captures.has("a11y_tree") && finalSnapshot) {
        try {
          evidence.a11y_tree = await ctx.store.writeReport(
            runDir,
            "a11y_tree.json",
            JSON.stringify(finalSnapshot, null, 2),
          );
        } catch (err) {
          failureReason ??= `a11y_tree capture failed: ${describeError(err)}`;
        }
      }

      try {
        evidence.replay_bundle = await ctx.store.writeReplayBundle(
          runDir,
          {
            version: 1,
            run_id: runDir.split("/").pop() ?? "run",
            recorded_at: new Date().toISOString(),
            open: args.open as unknown as Record<string, unknown>,
            steps: steps as unknown as Record<string, unknown>[],
            expect: args.expect as unknown as Record<string, unknown>[],
          },
          opts.bundleName,
        );
      } catch {
        /* swallow — replay bundle is best-effort */
      }
    }
    // forceClose closes throwaway runs (minimization attempts) regardless of
    // the caller's close_on_finish, so ddmin can't leak one browser per attempt.
    if (opts.forceClose || args.close_on_finish) {
      await ctx.registry.close(sessionHandle).catch(() => undefined);
    }
  }

  // HAR / video / trace artifacts are flushed by the engine on context close.
  // Surface their paths now that the close has completed (if captureEvidence
  // was requested).
  if (opts.captureEvidence) {
    if (captureCfg?.har) evidence.har = captureCfg.har.path;
    if (captureCfg?.trace) {
      evidence.trace = resolvePath(captureCfg.trace.artifactDir, "trace.zip");
    }
    if (captureCfg?.video) {
      try {
        const files = await readdir(captureCfg.video.dir).catch(() => [] as string[]);
        evidence.video = files
          .filter((f) => f.endsWith(".webm"))
          .map((f) => resolvePath(captureCfg.video!.dir, f));
      } catch {
        /* swallow — video is best-effort */
      }
    }
  }

  const out: RunOutcome = { passed, evidence };
  if (failedAtStep !== undefined) out.failedAtStep = failedAtStep;
  if (failureReason !== undefined) out.failureReason = failureReason;
  if (finalSnapshot) out.finalUrl = finalSnapshot.url_or_screen;
  return out;
}

function countByLevel(
  messages: { level: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    counts[m.level] = (counts[m.level] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Linear delta-removal — naive but bounded by the step count.
// ---------------------------------------------------------------------------

type MinimizeResult = {
  steps: VerifyUiFlowInput["steps"];
  removed: number[];
  attempts: number;
  replayPath: string | undefined;
};

async function minimize(
  ctx: ToolContext,
  args: VerifyUiFlowInput,
  initialSteps: VerifyUiFlowInput["steps"],
  runDir: string,
): Promise<MinimizeResult> {
  // Tag each step with its original index so we can report what was removed.
  type Tagged = { step: VerifyUiFlowInput["steps"][number]; origIndex: number };
  const tagged: Tagged[] = initialSteps.map((step, origIndex) => ({ step, origIndex }));
  let attempts = 0;

  const predicate = async (subset: Tagged[]): Promise<boolean> => {
    attempts += 1;
    const outcome = await runFlow(
      ctx,
      args,
      subset.map((t) => t.step),
      runDir,
      { captureEvidence: false, bundleName: "minimize-tmp.json", forceClose: true },
    );
    return outcome.passed;
  };

  const minimal = await ddmin(tagged, predicate);
  const remainingIdx = new Set(minimal.map((t) => t.origIndex));
  const removed = tagged
    .map((t) => t.origIndex)
    .filter((i) => !remainingIdx.has(i));

  // One final capture run with the minimized sequence to anchor evidence.
  let replayPath: string | undefined;
  if (minimal.length !== initialSteps.length) {
    const finalRun = await runFlow(
      ctx,
      args,
      minimal.map((t) => t.step),
      runDir,
      { captureEvidence: true, bundleName: "replay-minimized.json" },
    );
    replayPath = finalRun.evidence.replay_bundle;
  }
  return {
    steps: minimal.map((t) => t.step),
    removed: removed.sort((a, b) => a - b),
    attempts,
    replayPath,
  };
}

// ---------------------------------------------------------------------------
// Step + expect evaluation helpers (shared with mode='assert').
// ---------------------------------------------------------------------------

async function runStep(
  engine: Engine,
  session: Session,
  step: VerifyUiFlowInput["steps"][number],
  snap: A11ySnapshot,
): Promise<void> {
  switch (step.kind) {
    case "click": {
      const ref = resolveStepRef(snap.tree, step.query);
      await engine.click(session, ref);
      return;
    }
    case "type": {
      const ref = resolveStepRef(snap.tree, step.query);
      await engine.type(
        session,
        ref,
        step.text,
        step.clear_first ? { clearFirst: true } : undefined,
      );
      return;
    }
    case "key":
      await engine.key(session, step.key);
      return;
    case "wait_for":
      await engine.waitFor(session, step.condition);
      return;
    case "navigate":
      await engine.navigate(session, step.url);
      return;
    case "hover": {
      const ref = resolveStepRef(snap.tree, step.query);
      await engine.hover(session, ref);
      return;
    }
    case "drag": {
      const fromRef = resolveStepRef(snap.tree, step.from_query);
      const toRef = resolveStepRef(snap.tree, step.to_query);
      await engine.drag(session, fromRef, toRef);
      return;
    }
    case "fill_form": {
      const resolved = step.fields.map((f) => {
        const ref = resolveStepRef(snap.tree, f.query);
        return f.kind !== undefined
          ? { ref, value: f.value, kind: f.kind }
          : { ref, value: f.value };
      });
      await engine.fillForm(session, resolved);
      return;
    }
    case "upload": {
      const ref = resolveStepRef(snap.tree, step.query);
      await engine.uploadFile(session, ref, step.file_path);
      return;
    }
    case "dialog": {
      requirePlaywright(engine, "dialog");
      // Fire and forget — the next step (the dialog trigger) will resolve
      // the handler. We register synchronously inside handleDialog.
      void engine
        .handleDialog(session.id, {
          action: step.action,
          ...(step.text !== undefined ? { text: step.text } : {}),
        })
        .catch(() => undefined);
      return;
    }
    case "set_env": {
      requirePlaywright(engine, "set_env");
      await engine.setEnv(session.id, {
        ...(step.viewport !== undefined ? { viewport: step.viewport } : {}),
        ...(step.offline !== undefined ? { offline: step.offline } : {}),
        ...(step.geolocation !== undefined
          ? { geolocation: step.geolocation }
          : {}),
        ...(step.color_scheme !== undefined
          ? { colorScheme: step.color_scheme }
          : {}),
        ...(step.reduced_motion !== undefined
          ? { reducedMotion: step.reduced_motion }
          : {}),
        ...(step.extra_headers !== undefined
          ? { extraHeaders: step.extra_headers }
          : {}),
        ...(step.network_throttle !== undefined
          ? { networkThrottle: step.network_throttle }
          : {}),
        ...(step.cpu_throttle !== undefined
          ? { cpuThrottle: step.cpu_throttle }
          : {}),
      });
      return;
    }
    case "switch_page": {
      requirePlaywright(engine, "switch_page");
      await engine.switchPage(session.id, step.index);
      return;
    }
    case "evaluate": {
      requirePlaywright(engine, "evaluate");
      if (process.env.ROLEPOD_ALLOW_EVAL !== "1") {
        throw new RolepodMcpError(
          "engine_error",
          "verify_ui_flow step kind 'evaluate' is disabled. Restart the rolepod-uiproof MCP server with ROLEPOD_ALLOW_EVAL=1 to enable.",
        );
      }
      await engine.evaluate(session.id, step.script);
      return;
    }
    case "scroll":
      await engine.scroll(session, step.direction, step.amount);
      return;
    case "settle":
      requirePlaywright(engine, "settle");
      await engine.settle({ id: session.id, platform: session.platform });
      return;
  }
}

function requirePlaywright(
  engine: Engine,
  stepKind: string,
): asserts engine is PlaywrightEngine {
  if (!(engine instanceof PlaywrightEngine)) {
    throw new RolepodMcpError(
      "unsupported_engine",
      `verify_ui_flow step kind "${stepKind}" is web-only and requires PlaywrightEngine.`,
    );
  }
}

function evaluateExpect(
  exp: VerifyUiFlowInput["expect"][number],
  snap: A11ySnapshot,
  engine: Engine,
  sessionId: string,
): boolean {
  switch (exp.kind) {
    case "text_visible":
      return treeHasText(snap.tree, exp.text);
    case "text_absent":
      return !treeHasText(snap.tree, exp.text);
    case "url_matches":
      return new RegExp(exp.pattern).test(snap.url_or_screen);
    case "ref_in_state": {
      // Resolve the same exact-match-first / ambiguity-aware way as action
      // steps — the old first-substring-match would evaluate the wrong element
      // (e.g. "Save Draft" for query "Save") and report a false verdict.
      const node = resolveExpectNode(snap.tree, exp.query);
      if (!node) return false;
      switch (exp.state) {
        case "visible":
          return true;
        case "enabled":
          return node.state?.disabled !== true;
        case "focused":
          return node.state?.focused === true;
      }
    }
    case "no_console_errors": {
      // Mobile is handled by the WEB_ONLY_EXPECTS pre-check in runFlow; this
      // guard stays defensive and returns false (unverifiable ≠ pass).
      if (!(engine instanceof PlaywrightEngine)) return false;
      const msgs = engine.peekBuffers(sessionId).console.filter(
        (m) => m.level === "error",
      );
      const excludes = exp.exclude_patterns ?? [];
      const remaining = msgs.filter(
        (m) => !excludes.some((p) => m.text.includes(p)),
      );
      return remaining.length === 0;
    }
    case "no_failed_requests": {
      if (!(engine instanceof PlaywrightEngine)) return false;
      const reqs = engine.peekBuffers(sessionId).network.filter((r) => {
        if (r.failure) return true;
        if (r.status === undefined) return false;
        if (exp.allow_4xx) return r.status >= 500;
        return r.status >= 400;
      });
      const excludes = exp.exclude_patterns ?? [];
      const remaining = reqs.filter(
        (r) => !excludes.some((p) => r.url.includes(p)),
      );
      return remaining.length === 0;
    }
    case "request_made": {
      if (!(engine instanceof PlaywrightEngine)) return false;
      const re = new RegExp(exp.url_pattern);
      const wantMethod = exp.method?.toUpperCase();
      const matches = engine.peekBuffers(sessionId).network.filter((r) => {
        if (!re.test(r.url)) return false;
        if (wantMethod && r.method.toUpperCase() !== wantMethod) return false;
        return true;
      });
      const min = exp.min_count ?? 1;
      return matches.length >= min;
    }
    case "response_status": {
      if (!(engine instanceof PlaywrightEngine)) return false;
      const re = new RegExp(exp.url_pattern);
      const match = engine
        .peekBuffers(sessionId)
        .network.find((r) => re.test(r.url) && r.status === exp.status);
      return match !== undefined;
    }
  }
}

function describeExpect(exp: VerifyUiFlowInput["expect"][number]): string {
  switch (exp.kind) {
    case "text_visible":
      return `text_visible "${exp.text}"`;
    case "text_absent":
      return `text_absent "${exp.text}"`;
    case "url_matches":
      return `url_matches /${exp.pattern}/`;
    case "ref_in_state":
      return `ref_in_state "${exp.query}" → ${exp.state}`;
    case "no_console_errors":
      return "no_console_errors";
    case "no_failed_requests":
      return "no_failed_requests";
    case "request_made":
      return `request_made ${exp.method ?? ""} ${exp.url_pattern}`.trim();
    case "response_status":
      return `response_status ${exp.url_pattern} = ${exp.status}`;
  }
}

function missingQuery(query: string): RolepodMcpError {
  return new RolepodMcpError(
    "invalid_input",
    `No element matched query "${query}" in the current snapshot.`,
    { query },
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resolve a step query to exactly one ref. Prefers an exact name/value match
 * over a substring match, and reports `ambiguous_query` when the query matches
 * several equally-good elements rather than silently binding to the first —
 * acting on the wrong element would produce a wrong verdict.
 */
export function resolveStepRef(tree: A11yNode, query: string): string {
  const { exact, partial } = collectNodesByQuery(tree, query);
  if (exact.length === 1) return exact[0]!.ref;
  if (exact.length === 0 && partial.length === 1) return partial[0]!.ref;
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) throw missingQuery(query);
  throw ambiguousQuery(query, candidates);
}

function collectNodesByQuery(
  tree: A11yNode,
  query: string,
): { exact: A11yNode[]; partial: A11yNode[] } {
  const target = query.toLowerCase();
  const exact: A11yNode[] = [];
  const partial: A11yNode[] = [];
  const visit = (node: A11yNode): void => {
    const name = node.name?.toLowerCase();
    const value = node.value?.toLowerCase();
    if (name === target || value === target) {
      exact.push(node);
    } else if (
      (name?.includes(target) ?? false) ||
      (value?.includes(target) ?? false)
    ) {
      partial.push(node);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return { exact, partial };
}

function ambiguousQuery(query: string, candidates: A11yNode[]): RolepodMcpError {
  const top = candidates
    .slice(0, 5)
    .map((n) => `${n.role}${n.name ? ` "${n.name}"` : ""}`);
  return new RolepodMcpError(
    "ambiguous_query",
    `Query "${query}" matched ${candidates.length} elements — refine it to target one. Candidates: ${top.join(", ")}${candidates.length > 5 ? ", …" : ""}`,
    { query, match_count: candidates.length },
  );
}

/**
 * Resolve a query to a single node for an expectation. Exact name/value match
 * wins over substring; returns null when nothing matches OR the query is
 * ambiguous (several equal matches), so the expectation fails rather than
 * verifying the wrong element.
 */
export function resolveExpectNode(tree: A11yNode, query: string): A11yNode | null {
  const { exact, partial } = collectNodesByQuery(tree, query);
  if (exact.length === 1) return exact[0]!;
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  return null;
}

function treeHasText(tree: A11yNode, text: string): boolean {
  const target = text.toLowerCase();
  const visit = (node: A11yNode): boolean => {
    if (
      (node.name && node.name.toLowerCase().includes(target)) ||
      (node.value && node.value.toLowerCase().includes(target))
    ) {
      return true;
    }
    return node.children?.some(visit) ?? false;
  };
  return visit(tree);
}
