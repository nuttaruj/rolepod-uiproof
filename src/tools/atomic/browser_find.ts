import { findNodes } from "../../engine/a11y/query.js";
import {
  browserFindShape,
  ToolNames,
  type BrowserFindInput,
} from "../../schema/tools.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const NO_MATCH_HINT =
  "No element matched. Try a shorter substring, drop `role`, or take a `browser_snapshot` to see the tree.";

export const browserFindTool: ToolModule<typeof browserFindShape> = {
  name: ToolNames.browserFind,
  description:
    "Find elements by accessible name or value (case-insensitive; exact matches rank first, then substrings), optionally filtered by `role`, and return fresh refs — without paying for a full `browser_snapshot`. Snapshots internally, so the returned refs are valid for the next click/type/hover exactly like snapshot refs (D-010). Use it on large pages (admin dashboards, long menus) where a full tree costs thousands of tokens per action.",
  inputShape: browserFindShape,
  build(ctx) {
    return safeHandler(async (args: BrowserFindInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      const snap = await engine.snapshot({
        id: args.session_id,
        platform: ctx.registry.platformOf(args.session_id),
      });
      const opts: { role?: string; limit: number } = { limit: args.limit };
      if (args.role !== undefined) opts.role = args.role;
      const { matches, total } = findNodes(snap.tree, args.query, opts);
      return ok({
        session_id: snap.session_id,
        url_or_screen: snap.url_or_screen,
        query: args.query,
        matches,
        total,
        truncated: total > matches.length,
        ...(matches.length === 0 ? { hint: NO_MATCH_HINT } : {}),
      });
    });
  },
};
