import { describe, expect, it } from "vitest";
import {
  resolveStepRef,
  resolveExpectNode,
  treeHasText,
} from "../../src/tools/composite/verify_ui_flow.js";
import type { A11yNode } from "../../src/schema/tools.js";

/**
 * Query resolution must prefer an exact name match over a substring match, and
 * report `ambiguous_query` when several elements match equally well — silently
 * binding to the first match would act on the wrong element and yield a wrong
 * verdict.
 */

function node(ref: string, role: string, name: string, children: A11yNode[] = []): A11yNode {
  return { ref, role, name, children };
}

const tree: A11yNode = node("root", "document", "", [
  node("b1", "button", "Submit"),
  node("t1", "text", "Submit your feedback below"),
  node("l1", "link", "Learn more"),
]);

describe("resolveStepRef", () => {
  it("prefers an exact name match over an earlier substring match", () => {
    // "Submit" is an exact match on b1 and a substring of t1 — exact wins.
    expect(resolveStepRef(tree, "Submit")).toBe("b1");
  });

  it("resolves a unique substring match", () => {
    expect(resolveStepRef(tree, "Learn")).toBe("l1");
  });

  it("throws ambiguous_query when several elements match equally", () => {
    const ambiguous: A11yNode = node("root", "document", "", [
      node("a", "button", "Delete"),
      node("b", "button", "Delete"),
    ]);
    expect(() => resolveStepRef(ambiguous, "Delete")).toThrowError();
    try {
      resolveStepRef(ambiguous, "Delete");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ambiguous_query");
      expect((e as { detail?: { match_count?: number } }).detail?.match_count).toBe(2);
    }
  });

  it("throws invalid_input when nothing matches", () => {
    try {
      resolveStepRef(tree, "nonexistent-label");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("invalid_input");
    }
  });
});

describe("resolveExpectNode (ref_in_state resolution)", () => {
  it("prefers the exact match so ref_in_state checks the intended element", () => {
    // "Save Draft" precedes the real "Save" submit button in DOM order.
    const t = node("root", "document", "", [
      node("d", "button", "Save Draft"),
      node("s", "button", "Save"),
    ]);
    expect(resolveExpectNode(t, "Save")?.ref).toBe("s");
  });

  it("returns null on ambiguity rather than verifying the wrong element", () => {
    const t = node("root", "document", "", [
      node("a", "button", "Save"),
      node("b", "button", "Save"),
    ]);
    expect(resolveExpectNode(t, "Save")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveExpectNode(tree, "no-such-label")).toBeNull();
  });
});

describe("treeHasText respects mobile visibility", () => {
  it("does not match an off-screen (visible:false) node — no false text_visible", () => {
    const t: A11yNode = {
      ref: "root",
      role: "document",
      children: [
        { ref: "a", role: "text", name: "Hidden Label", state: { visible: false } },
      ],
    };
    expect(treeHasText(t, "Hidden Label")).toBe(false);
  });

  it("matches a visible node", () => {
    const t: A11yNode = {
      ref: "root",
      role: "document",
      children: [
        { ref: "a", role: "text", name: "Shown Label", state: { visible: true } },
      ],
    };
    expect(treeHasText(t, "Shown Label")).toBe(true);
  });

  it("matches a web node with no visibility state (unchanged behaviour)", () => {
    expect(treeHasText(node("root", "document", "", [node("a", "text", "Web Label")]), "Web Label")).toBe(true);
  });
});
