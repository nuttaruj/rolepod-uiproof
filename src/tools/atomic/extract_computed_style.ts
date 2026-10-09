import { PlaywrightEngine } from "../../engine/PlaywrightEngine.js";
import {
  extractComputedStyleShape,
  ToolNames,
  type ExtractComputedStyleInput,
} from "../../schema/tools.js";
import { RolepodMcpError } from "../../util/errors.js";
import { ok, safeHandler } from "../result.js";
import type { ToolModule } from "../types.js";

/**
 * Curated computed-style properties most useful for replicating a design:
 * typography, color, background/gradient, effects, border, spacing, layout.
 * Override per-call via the `css_properties` argument.
 */
export const DEFAULT_COMPUTED_STYLE_PROPS = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "opacity",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "border-radius",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "width",
  "height",
  "display",
  "position",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "transform",
  "transition",
] as const;

export const extractComputedStyleTool: ToolModule<typeof extractComputedStyleShape> = {
  name: ToolNames.extractComputedStyle,
  description:
    "Read the computed CSS of the first element matching a CSS selector — typography, color, background/gradient, spacing, border, shadow, layout, transform — plus its bounding box. Read-only (no eval gate); lets you replicate a reference design exactly instead of guessing tokens. Pass `css_properties` to override the curated default set.",
  inputShape: extractComputedStyleShape,
  build(ctx) {
    return safeHandler(async (args: ExtractComputedStyleInput) => {
      const engine = ctx.registry.engineFor(args.session_id);
      if (!(engine instanceof PlaywrightEngine)) {
        throw new RolepodMcpError(
          "unsupported_engine",
          "extract_computed_style is web-only and requires PlaywrightEngine.",
        );
      }
      const props = args.css_properties ?? [...DEFAULT_COMPUTED_STYLE_PROPS];
      const result = await engine.computedStyle(
        {
          id: args.session_id,
          platform: ctx.registry.platformOf(args.session_id),
        },
        args.selector,
        props,
      );
      if (!result.found) {
        throw new RolepodMcpError(
          "invalid_input",
          `selector "${args.selector}" matched no element.`,
          { selector: args.selector },
        );
      }
      return ok({
        selector: args.selector,
        match_count: result.match_count,
        box: result.box,
        styles: result.styles,
      });
    });
  },
};
