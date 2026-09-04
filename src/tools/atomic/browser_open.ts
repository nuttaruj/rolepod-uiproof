import { browserOpenShape, ToolNames, type BrowserOpenInput } from "../../schema/tools.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const browserOpenTool: ToolModule<typeof browserOpenShape> = {
  name: ToolNames.browserOpen,
  description:
    "Open a new browser or mobile session against a target. Web: pass `storage_state` (absolute path to a Playwright storageState JSON) to start already authenticated instead of navigating a login / one-time-link URL — the same file can be reused across runs and after a `browser_close`.",
  inputShape: browserOpenShape,
  build(ctx) {
    return safeHandler(async (args: BrowserOpenInput) => {
      const session = await ctx.registry.open(args);
      return ok({ session_id: session.id, platform: session.platform });
    });
  },
};
