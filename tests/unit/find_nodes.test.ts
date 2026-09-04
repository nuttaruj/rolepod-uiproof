import { describe, expect, it } from "vitest";
import { findNodes } from "../../src/engine/a11y/query.js";
import type { A11yNode } from "../../src/schema/tools.js";

/**
 * `browser_find` / `wait_for ref_exists` hand the Lead a short ranked list of
 * refs instead of a whole tree. Ranking must be exact-before-substring in
 * document order, honour the role filter and the limit, and never surface a
 * synthetic wrapper ref (`sN`) — resolveLocator rejects those, so returning
 * one would send the Lead into an unknown_ref loop.
 */

function node(ref: string, role: string, name?: string, children: A11yNode[] = []): A11yNode {
  const n: A11yNode = { ref, role, children };
  if (name !== undefined) n.name = name;
  return n;
}

const tree: A11yNode = node("s1", "document", "Install Now", [
  node("e1", "link", "Install Now (details)"),
  node("e2", "button", "Install Now"),
  node("e3", "button", "install now"),
  { ref: "e4", role: "textbox", name: "Search", value: "install now please" },
  node("e5", "heading", "Plugins"),
]);

describe("findNodes", () => {
  it("ranks exact matches before substring matches, document order within each", () => {
    const { matches, total } = findNodes(tree, "Install Now");
    expect(matches.map((m) => m.ref)).toEqual(["e2", "e3", "e1", "e4"]);
    expect(matches.map((m) => m.exact)).toEqual([true, true, false, false]);
    expect(total).toBe(4);
  });

  it("never returns a synthetic wrapper ref even when its name matches", () => {
    const { matches } = findNodes(tree, "Install Now");
    expect(matches.some((m) => m.ref === "s1")).toBe(false);
  });

  it("filters by role, case-insensitively", () => {
    const { matches, total } = findNodes(tree, "install now", { role: "Link" });
    expect(matches.map((m) => m.ref)).toEqual(["e1"]);
    expect(total).toBe(1);
  });

  it("applies the limit but reports the full total", () => {
    const { matches, total } = findNodes(tree, "install now", { limit: 2 });
    expect(matches).toHaveLength(2);
    expect(total).toBe(4);
  });

  it("matches on value as well as name and carries both back", () => {
    const { matches } = findNodes(tree, "please");
    expect(matches).toEqual([
      { ref: "e4", role: "textbox", name: "Search", value: "install now please", exact: false },
    ]);
  });

  it("returns an empty list, not an error, when nothing matches", () => {
    expect(findNodes(tree, "Deactivate")).toEqual({ matches: [], total: 0 });
  });
});
