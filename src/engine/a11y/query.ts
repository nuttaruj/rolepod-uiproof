import type { A11yNode } from "../../schema/tools.js";

/**
 * Query → node matching shared by verify_ui_flow's step resolver,
 * `browser_find`, and `browser_wait_for { ref_exists }`.
 *
 * Case-insensitive. A node matches when its accessible name or value equals
 * the query (exact) or contains it (partial). Callers decide what to do with
 * ambiguity: verify_ui_flow refuses to act on an ambiguous step, `browser_find`
 * hands the ranked candidates back to the Lead.
 */
export function collectNodesByQuery(
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

export type FoundNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  /** True when name/value equals the query, false for a substring match. */
  exact: boolean;
};

export type FindOptions = {
  /** Case-insensitive role filter (e.g. "button", "link", "textbox"). */
  role?: string;
  /** Cap on returned matches; `total` still reports the full count. */
  limit?: number;
};

/**
 * Synthetic refs (`s1`, `s2`, …) are issued for wrapper roots the web
 * normalizer needs but that map to no element — resolveLocator rejects them,
 * so never hand one to the Lead as something to click.
 */
function isSyntheticRef(ref: string): boolean {
  return /^s\d+$/.test(ref);
}

/**
 * Rank matches for `query` — exact name/value matches first, then substring
 * matches, document order within each group — optionally filtered by role,
 * and trimmed to `limit`. Returns only what the Lead needs to act
 * (`ref`, `role`, `name`, `value`), never the surrounding tree.
 */
export function findNodes(
  tree: A11yNode,
  query: string,
  opts: FindOptions = {},
): { matches: FoundNode[]; total: number } {
  const { exact, partial } = collectNodesByQuery(tree, query);
  const role = opts.role?.toLowerCase();
  const ranked: Array<readonly [A11yNode, boolean]> = [
    ...exact.map((n) => [n, true] as const),
    ...partial.map((n) => [n, false] as const),
  ].filter(
    ([n]) => !isSyntheticRef(n.ref) && (role === undefined || n.role.toLowerCase() === role),
  );
  const limit = opts.limit ?? 10;
  const matches = ranked.slice(0, limit).map(([n, isExact]) => {
    const out: FoundNode = { ref: n.ref, role: n.role, exact: isExact };
    if (n.name !== undefined) out.name = n.name;
    if (n.value !== undefined) out.value = n.value;
    return out;
  });
  return { matches, total: ranked.length };
}
