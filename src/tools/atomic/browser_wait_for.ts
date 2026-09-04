import { findNodes } from "../../engine/a11y/query.js";
import {
  browserWaitForShape,
  ToolNames,
  type BrowserWaitForInput,
} from "../../schema/tools.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const browserWaitForTool: ToolModule<typeof browserWaitForShape> = {
  name: ToolNames.browserWaitFor,
  description:
    "Wait until a condition holds: text_visible, ref_exists, url_matches, or idle. Defaults to a 10s timeout. Invalidates all refs on success — except `ref_exists`, which returns fresh `matches` (`{ref, role, name}`) for the query so you can click without a snapshot.",
  inputShape: browserWaitForShape,
  build(ctx) {
    return safeHandler(async (args: BrowserWaitForInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      const session = {
        id: args.session_id,
        platform: ctx.registry.platformOf(args.session_id),
      };
      const cond = args.condition;
      const start = Date.now();
      await engine.waitFor(session, cond, args.timeout_ms);
      const waited_ms = Date.now() - start;
      if (cond.kind !== "ref_exists") return ok({ matched: true, waited_ms });
      // The wait already located the element — hand back its ref(s) instead
      // of making the Lead pay for a full snapshot (≈10k tokens on an admin
      // page) just to click what it waited for. Snapshotting here re-issues
      // refs, so the ones returned are valid for the next action (D-010).
      const snap = await engine.snapshot(session);
      const { matches, total } = findNodes(snap.tree, cond.query, { limit: 5 });
      return ok({ matched: true, waited_ms, matches, total });
    });
  },
};
