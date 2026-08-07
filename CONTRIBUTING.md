# Contributing to rolepod-uiproof

Thanks for your interest. rolepod-uiproof is a small, opinionated project.
For non-trivial changes, please open a discussion or issue first so we
can confirm the change fits the project's scope before you sink time
into a PR.

## Quick start for contributors

```bash
git clone <repo-url> rolepod-uiproof
cd rolepod-uiproof
npm install
npx playwright install chromium
npm run typecheck
npm test               # vitest smoke + lint
npm run build          # tsup + schema export
npm run smoke:mcp      # stdio handshake against the bin
```

## Source layout

The boundaries that matter:

| Layer | Owns | Does NOT own |
|---|---|---|
| `src/engine/*` | Driver instantiation, AT extraction, ref resolution, atomic action dispatch | Multi-step orchestration, artifacts, replay, schema validation |
| `src/tools/atomic/*` | One-to-one MCP wrappers over engine primitives | Composing actions across multiple primitives |
| `src/tools/composite/*` | Multi-step orchestrations + artifact writing + assertion eval | Driver work (delegate to engine) |
| `src/schema/tools.ts` | The single source of truth for tool names + zod shapes | Tool behaviour |
| `src/replay/*` | Replay bundle write + minimization algorithm | Snapshotting (engine), evidence (artifacts) |
| `src/artifact/*` | `./.rolepod-uiproof/` filesystem layout | Anything else |

Cross the wrong boundary and the reviewer will ask you to move the code.

## What we welcome

- Bug fixes in `engine/`, `tools/`, and `replay/` — with a failing
  test that turns green.
- New engine implementations behind the `Engine` interface
  (`src/engine/Engine.ts`). No other layer changes when an engine
  joins.
- New atomic tools when they are genuine driver primitives. Composite
  workflows should compose existing atoms.
- Skill prose improvements that stay inside the
  `tests/lint/skills.test.ts` contract.
- Better fixtures, more smoke-test coverage, faster CI.

## What we usually decline

- Any feature whose justification is *"because Playwright MCP has it"*.
  rolepod-uiproof is intentionally smaller — Lead-driven, single-purpose
  composites, no internal LLM.
- Internal LLM calls inside the MCP server (D-004).
- Fallback chains inside shipped skills (D-024).
- Schema-breaking changes after v1.0 ships without a deprecation
  cycle (D-022's spirit).
- Telemetry of any kind (D-013).
- Adding deps without a clear payoff — every new dep enlarges the
  install footprint for web-only users.

## Code style

- TypeScript strict mode (`tsconfig.json`). `noUncheckedIndexedAccess`
  is on; address it by checking, not by `!`.
- One concept per file. If a file grows past ~400 lines, split it.
- No comments unless the *why* is non-obvious. Names should carry the
  *what*.
- Errors thrown to the MCP wire must be `RolepodMcpError` with a
  stable `code` — see `src/util/errors.ts`.
- Logs go to stderr only (`src/util/log.ts`). stdout carries the
  JSON-RPC stream.

## Tests

- `vitest` for both lint (`tests/lint/`) and smoke (`tests/smoke/`).
- Web smoke runs against `https://example.com` to stay offline-free.
  Avoid adding network-heavy targets.
- Mobile smoke is gated on simulator availability — keep new mobile
  tests in `.skip` blocks with a clear `WHY` comment until they can
  run in CI.

## Commits + PRs

- Conventional Commits prefix preferred: `feat:`, `fix:`, `chore:`,
  `docs:`, `refactor:`, `test:`.
- One concern per PR. If the diff sprawls, split it.
- The PR description should answer: *what changes, why, and how was
  it verified*.
- The "Test plan" section is mandatory — even if it's just
  `npm test`.

## Reviewer checklist (for maintainers)

- [ ] Project scope held (no internal LLM; no fallback chains in shipped skills; web/mobile platform parity)?
- [ ] Single-backend rule held for shipped skills?
- [ ] No fallback chains in `skills/*/SKILL.md`?
- [ ] Tool name additions reflected in `ToolNames`, server registry,
      schema export, and skill lint allowlist?
- [ ] `THIRD_PARTY.md` updated when a dep is added?
- [ ] CHANGELOG entry under `## [Unreleased]`?
- [ ] Minor release: playwright pin reviewed per `UPSTREAM_TRACKING.md`
      (bump gets its own CHANGELOG line + baseline re-capture warning)?

## Reporting security issues

See `SECURITY.md`. Do **not** open a public issue for security
findings.

## Code of conduct

Participation in this project is governed by `CODE_OF_CONDUCT.md`
(Contributor Covenant 2.1).
