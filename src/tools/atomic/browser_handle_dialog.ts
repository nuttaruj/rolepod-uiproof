import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  browserHandleDialogShape,
  ToolNames,
  type BrowserHandleDialogInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const browserHandleDialogTool: ToolModule<
  typeof browserHandleDialogShape
> = {
  name: ToolNames.browserHandleDialog,
  description:
    "Pre-arm a one-shot handler for the NEXT JavaScript dialog (`alert`/`confirm`/`prompt`/`beforeunload`) on the active page. Call this BEFORE the action that triggers the dialog (e.g. before clicking the button that calls `confirm()`). By default it arms and returns immediately (armed=true) so you can issue the triggering action next; the outcome comes back as `last_dialog` on a later call. Pass wait=true to block until the dialog fires (only when another actor triggers it concurrently). Un-armed dialogs are auto-dismissed so the page does not hang.",
  inputShape: browserHandleDialogShape,
  build(ctx) {
    return safeHandler(async (args: BrowserHandleDialogInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "handle_dialog is web-only and requires PlaywrightEngine.",
        );
      }
      const result = await engine.handleDialog(args.session_id, {
        action: args.action,
        wait: args.wait,
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      });
      return ok({
        action: args.action,
        handled: result.handled,
        ...(result.armed !== undefined ? { armed: result.armed } : {}),
        ...(result.last_dialog !== undefined ? { last_dialog: result.last_dialog } : {}),
      });
    });
  },
};
