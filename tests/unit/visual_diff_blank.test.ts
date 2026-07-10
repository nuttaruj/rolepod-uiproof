import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { isBlankPng } from "../../src/tools/composite/visual_diff.js";

/**
 * A broken/unloaded page renders as one solid colour; seeding a baseline from
 * it would poison every future diff. isBlankPng flags that so the full-page
 * seed path can refuse it.
 */
function solid(w: number, h: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("isBlankPng", () => {
  it("returns true for an all-white capture", () => {
    expect(isBlankPng(solid(40, 30, 255, 255, 255))).toBe(true);
  });

  it("returns true for any single solid colour", () => {
    expect(isBlankPng(solid(40, 30, 12, 34, 56))).toBe(true);
  });

  it("returns false once a single pixel differs", () => {
    const png = new PNG({ width: 40, height: 30 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
    // flip one pixel
    png.data[4 * 100] = 0;
    expect(isBlankPng(PNG.sync.write(png))).toBe(false);
  });
});
