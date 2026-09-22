import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * opencode HTTP skill catalog guard.
 *
 * opencode (v2) loads skills from a `skills` config entry that points at an
 * HTTP base URL; it fetches `<base>/index.json` and then every listed file
 * from `<base>/<name>/<file>`. Our base URL is the raw GitHub view of
 * `skills/`, so `skills/index.json` must mirror the on-disk skill tree
 * exactly — a skill added without a catalog entry never reaches opencode
 * users, a file added to a skill dir but not to its `files` is never served,
 * and a listed file that doesn't exist 404s on install. `version` is what
 * opencode keys its cache on, so it moves with package.json (same lockstep
 * rule as the npx spawn pins).
 */
const repoRoot = resolve(__dirname, "..", "..");
const skillsDir = resolve(repoRoot, "skills");
const version = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).version as string;

type Entry = { name: string; version: string; files: string[] };
const catalog = JSON.parse(
  readFileSync(resolve(skillsDir, "index.json"), "utf8"),
) as { skills: Entry[] };

const onDisk = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// Every file under skills/<name>/, as the relative POSIX path opencode joins
// onto `<base>/<name>/`.
const filesUnder = (name: string): string[] =>
  readdirSync(resolve(skillsDir, name), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(resolve(skillsDir, name), resolve(d.parentPath, d.name)))
    .map((p) => p.split("\\").join("/"))
    .sort();

describe("skills/index.json (opencode HTTP catalog)", () => {
  it("lists exactly the skill directories under skills/", () => {
    expect(catalog.skills.map((s) => s.name).sort()).toEqual(onDisk);
  });

  it.each(catalog.skills.map((s) => [s.name, s] as const))(
    "%s: files match the skill dir exactly and include SKILL.md",
    (name, entry) => {
      expect(entry.files).toContain("SKILL.md");
      expect([...entry.files].sort()).toEqual(filesUnder(name));
    },
  );

  it.each(catalog.skills.map((s) => [s.name, s.version] as const))(
    "%s: catalog version tracks package.json (opencode cache key)",
    (_name, v) => {
      expect(v).toBe(version);
    },
  );
});
