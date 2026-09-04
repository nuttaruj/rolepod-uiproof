import { isAbsolute, resolve as resolvePath } from "node:path";
import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  browserSaveStateShape,
  ToolNames,
  type BrowserSaveStateInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const STORAGE_STATE_NOTE =
  "This file holds the session's cookies and localStorage — it IS the authenticated session. Keep it out of issues, PRs, and shared drives; delete it when the audit is done.";

export const browserSaveStateTool: ToolModule<typeof browserSaveStateShape> = {
  name: ToolNames.browserSaveState,
  description:
    "Persist the active web session's cookies + localStorage as a Playwright storageState JSON, so a later `browser_open` (pass the path as `storage_state`) starts already authenticated — log in or open a one-time link once, then reuse across runs and after `browser_close`. Defaults to `<artifact run dir>/storage-state.json`; pass an absolute `path` to choose the location. Web-only.",
  inputShape: browserSaveStateShape,
  build(ctx) {
    return safeHandler(async (args: BrowserSaveStateInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "save_state is web-only and requires PlaywrightEngine.",
        );
      }
      let target: string;
      if (args.path) {
        if (!isAbsolute(args.path)) {
          throw new RolepodMcpError(
            "invalid_input",
            "`path` must be absolute so the file lands where you expect, not relative to the server's cwd.",
            { path: args.path },
          );
        }
        target = args.path;
      } else {
        const { runDir } = await ctx.store.startRun("save_state", { skill: "verify-ui" });
        target = resolvePath(runDir, "storage-state.json");
      }
      const { cookies, origins } = await engine.saveStorageState(args.session_id, target);
      return ok({
        path: target,
        cookies,
        origins,
        note: STORAGE_STATE_NOTE,
      });
    });
  },
};
