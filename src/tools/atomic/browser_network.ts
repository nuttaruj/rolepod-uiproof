import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  browserNetworkShape,
  ToolNames,
  type BrowserNetworkInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

export const browserNetworkTool: ToolModule<typeof browserNetworkShape> = {
  name: ToolNames.browserNetwork,
  description:
    "List network requests captured on the active page. Filters: `url_pattern` (substring or regex via `pattern_kind`), `method`, `status_range`, `only_failed`. Set `export_har: true` to require the session to have been opened with HAR recording — see `verify_ui_flow` capture=[\"har\"] or call `browser_open` with capture.har=true. Read-only unless `clear: true`.",
  inputShape: browserNetworkShape,
  build(ctx) {
    return safeHandler(async (args: BrowserNetworkInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "network is web-only and requires PlaywrightEngine.",
        );
      }
      const requests = engine.getNetwork(args.session_id, {
        ...(args.url_pattern !== undefined ? { urlPattern: args.url_pattern } : {}),
        patternKind: args.pattern_kind,
        ...(args.method !== undefined ? { method: args.method } : {}),
        ...(args.status_range !== undefined
          ? { statusRange: args.status_range }
          : {}),
        onlyFailed: args.only_failed,
        clear: args.clear,
        limit: args.limit,
      });
      const failed = requests.filter(
        (r) => !!r.failure || (r.status !== undefined && r.status >= 400),
      ).length;
      return ok({
        count: requests.length,
        failed_count: failed,
        requests,
        // HAR file lives wherever the session was opened with
        // `capture.har.path`. We don't echo it here to avoid leaking
        // filesystem paths into untrusted logs; the verify_ui_flow run
        // result surfaces it in `evidence_paths.har`.
        har_recording: args.export_har
          ? "HAR is written at session close to the path passed via capture.har at open time. Cookie/Set-Cookie/Authorization headers are redacted on write; a trace.zip from the same run is not."
          : undefined,
      });
    });
  },
};
