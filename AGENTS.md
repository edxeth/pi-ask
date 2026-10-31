# AGENTS.md

Guidance for agents working in this repository.

## Project scope

This repo builds a **pi.dev extension** that adds an `ask` / interview-style user question flow.

Primary deliverables:

- `src/` — implementation
- `tests/` — behavior coverage
- `docs/` — contract and architecture

## Project goals

Optimize for:

1. **pi-native design**
   - prefer `pi.registerTool()`
   - prefer `ctx.ui.custom()` for complex flows
   - keep results compatible with normal pi tool results

2. **testable architecture**
   - keep state logic in plain TypeScript modules
   - keep pi/TUI wiring thin
   - prefer testing transitions and serialization over terminal rendering details

3. **small docs, clear code**
   - keep implementation consistent with `docs/contract.md`
   - update docs when behavior changes materially
   - keep docs focused on contracts and boundaries, not line-by-line explanations

## Tech stack

- TypeScript
- pnpm
- Biome
- pi extension APIs from `@earendil-works/pi-coding-agent`
- TUI components from `@earendil-works/pi-tui`
- TypeBox for tool schemas

## Commands

Use these project commands:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm format
pnpm lint
pnpm check
pnpm run check:ci
pnpm run check:pi-floor
```

Notes:

- `pnpm check` runs `ultracite check` (no writes); `pnpm run fix` applies fixes.
- `pnpm test` runs the Node test runner against `tests/*.test.ts`.
- The 4 gates are `pnpm test`, `pnpm typecheck`, `pnpm run check:ci`, and `pnpm run check:pi-floor` (typecheck and tests against pi 0.99.0 in a temp copy).
- the extension is intended to be loaded dynamically with:

```bash
pi -e ./src/index.ts
```

## File-specific guidance

### `src/`

- keep implementation in TypeScript only
- preserve the separation between:
  - schema/types
  - state logic
  - UI component logic
  - tool registration
- avoid introducing unnecessary framework abstractions
- prefer small pure helper functions where possible

### `tests/`

- add or update tests when changing state behavior
- prefer focused tests for:
  - question normalization
  - selection behavior
  - tab movement
  - custom answer submission
  - result summarization
  - cancellation behavior

### docs

Keep docs short and synced with the implementation.

- `README.md`: install, run, and use
- `docs/README.md`: docs index
- `docs/contract.md`: external behavior and UX guarantees
- `docs/architecture.md`: module boundaries and invariants
- when the README `last commit` badge uses a `?v=<commit-sha>` cache-busting param, update that SHA when the badge is stale and you are already touching `README.md` for a related docs/release refresh

## Coding expectations

- follow Biome/Ultracite formatting and lint expectations
- prefer explicit, readable code over clever code
- use descriptive names
- use early returns to keep control flow simple
- avoid dead code and generic boilerplate comments
- do not add React/JSX-specific patterns unless the repo actually starts using them

## What to avoid

- do not add unrelated framework guidance or dependencies
- do not add browser/web UI unless the task explicitly requires it
- do not hardcode machine-specific paths
- do not weaken type safety just to silence errors
- do not commit editor-specific files unless they are clearly project-useful

## When changing behavior

Update the relevant docs in the same change:

- usage changes -> `README.md`
- contract or UX changes -> `docs/contract.md`
- module boundary changes -> `docs/architecture.md`

## Preferred workflow

1. read the relevant docs first
2. inspect the existing implementation before refactoring
3. make the smallest coherent change
4. run `pnpm format` and the 4 gates
5. update docs if behavior or expectations changed

## Branches, PRs, and releases

- One branch per ticket, one PR on `FasalZein/pi-ask`, squash merge. Never rewrite pushed history.
- Squash subjects must pass commitlint (conventional commits); pass `--subject`, because git's default merge message fails.
- After every merge, run the 4 gates on `main`. Branches that pass alone can fail together.
- CI (GitHub Actions, `.github/workflows/ci.yml`) runs the 4 gates on Linux for pull requests and `main` pushes. Run the gates locally too. Tests that touch the filesystem must not assume macOS paths; `@` file completion needs `fd` (CI installs `fd-find`).
- Release: bump `package.json` and `CHANGELOG.md` through a PR, then `gh release create vX.Y.Z -R FasalZein/pi-ask --target <merge sha>`. Never publish to npm (ADR 0004, ADR 0009).
- When running `scripts/behavior/` on Opus: the harness passes `--no-extensions`, so `anthropic/*` fails when its auth comes from the `pi-claude-auth` extension; use `cpa/claude-opus-5-5` there. Interview runs can exceed 120 s; set `PI_ASK_BEHAVIOR_TIMEOUT_MS=300000`.

## Agent skills

### Issue tracker

GitHub Issues on the standalone repository `FasalZein/pi-ask` (not upstream `eko24ive/pi-ask`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
