import yaml from "js-yaml";
import type { A11yNode } from "../../schema/tools.js";

/**
 * Unified accessibility-tree normalization.
 *
 * Implements the Chromium path by parsing Playwright 1.60's
 * `page.ariaSnapshot({ mode: "ai" })` YAML output. Each leaf carries a
 * stable `[ref=eN]` marker that Playwright resolves back to a real
 * locator via `page.locator("aria-ref=eN")`.
 *
 * Mobile A11y normalizers (XCUITest / UIAutomator2) are alumnium-inspired
 * — see THIRD_PARTY.md + UPSTREAM_TRACKING.md.
 */

/** Locator metadata for ref → driver resolution. Never sent to the Lead. */
export type WebRefMeta = {
  kind: "web";
  /** The `eN` ref string. Used as `page.locator("aria-ref=" + ref)`. */
  ref: string;
};

export type RefMeta = WebRefMeta;

export type NormalizedSnapshot = {
  tree: A11yNode;
  refIndex: Map<string, RefMeta>;
};

type YamlValue = string | YamlArray | YamlObject;
type YamlArray = YamlValue[];
type YamlObject = { [key: string]: YamlValue | null };

const KEY_RE = /^(?<role>\S+?)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<rest>(?:\s+\[[^\]]+\])*)\s*$/;
const ATTR_RE = /\[([^=\]]+)(?:=([^\]]+))?\]/g;

type ParsedKey = {
  role: string;
  name?: string;
  attrs: Record<string, string>;
};

function parseKey(key: string): ParsedKey {
  const trimmed = key.trim();
  const m = KEY_RE.exec(trimmed);
  if (!m) {
    return { role: trimmed, attrs: {} };
  }
  const groups = m.groups!;
  const out: ParsedKey = { role: groups.role!, attrs: {} };
  if (groups.name !== undefined) out.name = unescapeQuoted(groups.name);
  const rest = groups.rest ?? "";
  for (const attrMatch of rest.matchAll(ATTR_RE)) {
    const [, k, v] = attrMatch;
    if (k) out.attrs[k] = v ?? "true";
  }
  return out;
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Parse a Playwright ai-mode aria snapshot string and produce the unified
 * A11yNode tree plus a refIndex for locator resolution.
 */
export function parseAriaSnapshot(snapshotYaml: string): NormalizedSnapshot {
  const refIndex = new Map<string, RefMeta>();
  let synthCounter = 0;
  const nextSynthRef = (): string => `s${++synthCounter}`;

  const consumeNode = (value: YamlValue): A11yNode | null => {
    // Object with one key like { 'link "Home" [ref=e3]': [...] | "text" }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== 1) return null;
      const key = keys[0]!;
      // Pseudo-keys like `/url` carry hyperlink metadata, not real nodes.
      if (key.startsWith("/")) return null;
      const inner = value[key];
      if (typeof inner === "string") return buildNode(key, null, inner);
      if (Array.isArray(inner)) return buildNode(key, inner, undefined);
      return buildNode(key, null, undefined);
    }
    // Bare string like `link "Home" [ref=e3]` or `text "hello"`
    if (typeof value === "string") {
      return buildNode(value, null, undefined);
    }
    return null;
  };

  const buildNode = (
    key: string,
    rawChildren: YamlValue | null | undefined,
    inlineText: string | undefined,
  ): A11yNode => {
    const parsed = parseKey(key);
    const ref = parsed.attrs.ref ?? nextSynthRef();
    refIndex.set(ref, { kind: "web", ref });

    const node: A11yNode = {
      ref,
      role: parsed.role,
    };
    if (parsed.name !== undefined) node.name = parsed.name;
    if (inlineText !== undefined) {
      node.value = inlineText;
    } else if (parsed.attrs.level) {
      node.value = parsed.attrs.level;
    }

    const state: A11yNode["state"] = {};
    if ("disabled" in parsed.attrs) state.disabled = parsed.attrs.disabled !== "false";
    if ("focused" in parsed.attrs) state.focused = parsed.attrs.focused !== "false";
    if ("selected" in parsed.attrs) state.selected = parsed.attrs.selected !== "false";
    if ("expanded" in parsed.attrs) state.expanded = parsed.attrs.expanded !== "false";
    if (Object.keys(state).length > 0) node.state = state;

    if (Array.isArray(rawChildren)) {
      const children: A11yNode[] = [];
      for (const child of rawChildren) {
        const built = consumeNode(child);
        if (built) children.push(built);
      }
      if (children.length > 0) node.children = children;
    }
    return node;
  };

  let loaded: YamlValue;
  try {
    loaded = (yaml.load(snapshotYaml) as YamlValue) ?? [];
  } catch (err) {
    // A genuinely malformed snapshot must not become a silent empty-but-
    // successful tree (assertions would falsely pass/fail against nothing).
    // Empty input yields undefined -> [] above without throwing.
    throw new Error(
      `Failed to parse aria snapshot YAML: ${(err as Error).message}`,
    );
  }

  const topLevel: A11yNode[] = [];
  if (Array.isArray(loaded)) {
    for (const entry of loaded) {
      const node = consumeNode(entry);
      if (node) topLevel.push(node);
    }
  } else if (loaded && typeof loaded === "object") {
    const node = consumeNode(loaded);
    if (node) topLevel.push(node);
  } else if (typeof loaded === "string" && loaded.length > 0) {
    const node = consumeNode(loaded);
    if (node) topLevel.push(node);
  }

  // The composite needs a single root. Wrap when there are 0 or >1 entries.
  if (topLevel.length === 1) {
    return { tree: topLevel[0]!, refIndex };
  }
  const rootRef = nextSynthRef();
  refIndex.set(rootRef, { kind: "web", ref: rootRef });
  const root: A11yNode = { ref: rootRef, role: "RootWebArea" };
  if (topLevel.length > 0) root.children = topLevel;
  return { tree: root, refIndex };
}
