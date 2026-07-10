import { describe, expect, it } from "vitest";
import { parseXcuiTestTree } from "../../src/engine/a11y/xcuitest.js";
import { parseUiAutomator2Tree } from "../../src/engine/a11y/uiautomator2.js";
import type { A11yNode } from "../../src/schema/tools.js";

function findByName(node: A11yNode, name: string): A11yNode | null {
  if (node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, name);
    if (hit) return hit;
  }
  return null;
}

const IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication name="App">
  <XCUIElementTypeWindow>
    <XCUIElementTypeButton name="A" label="A" visible="true"/>
  </XCUIElementTypeWindow>
  <XCUIElementTypeOther>
    <XCUIElementTypeButton name="B" label="B" visible="false"/>
  </XCUIElementTypeOther>
</XCUIElementTypeApplication>`;

describe("XCUITest global class-chain index + visibility", () => {
  it("assigns a document-order-global index for same-type elements under different parents", () => {
    const { tree, refIndex } = parseXcuiTestTree(IOS_XML);
    const a = findByName(tree, "A")!;
    const b = findByName(tree, "B")!;
    const metaA = refIndex.get(a.ref)!;
    const metaB = refIndex.get(b.ref)!;
    // Both are the first button among their own siblings…
    expect(metaA.classChainIndex).toBe(1);
    expect(metaB.classChainIndex).toBe(1);
    // …but globally the buttons are #1 and #2 — this is what the selector uses.
    expect(metaA.globalTypeIndex).toBe(1);
    expect(metaB.globalTypeIndex).toBe(2);
  });

  it("surfaces on-screen visibility", () => {
    const { tree } = parseXcuiTestTree(IOS_XML);
    expect(findByName(tree, "A")!.state?.visible).toBe(true);
    expect(findByName(tree, "B")!.state?.visible).toBe(false);
  });

  it("throws on genuinely malformed XML instead of returning an empty success", () => {
    expect(() => parseXcuiTestTree("<XCUIElementTypeButton <<<")).toThrow();
  });

  it("still returns an application-root fallback for empty input", () => {
    const { tree } = parseXcuiTestTree("");
    expect(tree.role).toBe("application");
  });
});

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.LinearLayout>
    <android.widget.CheckBox checkable="true" checked="true" content-desc="Agree"/>
  </android.widget.LinearLayout>
  <android.widget.LinearLayout>
    <android.widget.CheckBox checkable="true" checked="false" content-desc="News"/>
  </android.widget.LinearLayout>
</hierarchy>`;

describe("UiAutomator2 global instance index + checked state", () => {
  it("assigns a document-order-global class index across parents", () => {
    const { tree, refIndex } = parseUiAutomator2Tree(ANDROID_XML);
    const agree = findByName(tree, "Agree")!;
    const news = findByName(tree, "News")!;
    expect(refIndex.get(agree.ref)!.classIndex).toBe(1);
    expect(refIndex.get(news.ref)!.classIndex).toBe(1);
    expect(refIndex.get(agree.ref)!.globalClassIndex).toBe(1);
    expect(refIndex.get(news.ref)!.globalClassIndex).toBe(2);
  });

  it("surfaces checkbox/switch state", () => {
    const { tree } = parseUiAutomator2Tree(ANDROID_XML);
    expect(findByName(tree, "Agree")!.state?.checked).toBe(true);
    expect(findByName(tree, "News")!.state?.checked).toBe(false);
  });

  it("throws on malformed XML", () => {
    expect(() => parseUiAutomator2Tree("<hierarchy <<< bad")).toThrow();
  });
});
