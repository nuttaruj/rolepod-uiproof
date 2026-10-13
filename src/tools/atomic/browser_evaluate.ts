import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  browserEvaluateShape,
  ToolNames,
  type BrowserEvaluateInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

/**
 * Gating: this tool executes ARBITRARY JavaScript in the page context,
 * which can read DOM state, mutate it, or exfiltrate data. The code default
 * is off, and the shipped spawn configs set the env to enable it.
 * The handler only works when the server was started with the env var
 * `ROLEPOD_ALLOW_EVAL=1`. Otherwise the tool is still listed (so callers
 * can discover the capability) but every call returns an `eval_disabled`
 * error.
 */
export const browserEvaluateTool: ToolModule<typeof browserEvaluateShape> = {
  name: ToolNames.browserEvaluate,
  description:
    "Execute JavaScript in the active page's context. The `script` is the body of an async function — use `return` for the result and reference inputs via the implicit `args` array. Requires the MCP server to run with `ROLEPOD_ALLOW_EVAL=1` (set in the shipped spawn configs; remove it or set 0 to disable); intended for trusted automation setups only (state seeding, computed-style reads, synthetic event dispatch).",
  inputShape: browserEvaluateShape,
  build(ctx) {
    const allowed = process.env.ROLEPOD_ALLOW_EVAL === "1";
    return safeHandler(async (args: BrowserEvaluateInput) => {
      if (!allowed) {
        throw new RolepodMcpError(
          "engine_error",
          "browser_evaluate is disabled. Restart the rolepod-uiproof MCP server with the env var ROLEPOD_ALLOW_EVAL=1 to enable arbitrary JavaScript execution in the page context.",
        );
      }
      const engine = ctx.registry.engineFor(args.session_id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "evaluate is web-only and requires PlaywrightEngine.",
        );
      }
      const result = await engine.evaluate(
        args.session_id,
        args.script,
        args.args,
      );
      return ok({ result });
    });
  },
};
