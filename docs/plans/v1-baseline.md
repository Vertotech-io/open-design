# v1 Baseline Plan

**Parent:** [`roadmap.md`](../roadmap.md) · **Decision:** [`ADR 0002`](../adr/0002-stabilize-upstream-before-differentiation.md)

This plan defines the first productization milestone for this fork. The v1 baseline is not a feature-differentiation phase. It is the point where the chosen upstream can be installed, validated, run, and inspected reliably enough that later product work has a stable base.

## Goal

Make `nexu-io/open-design` reliable as this fork's upstream runtime before adding new product surface area.

The baseline is met when a clean local checkout can:

- install dependencies with Node 24 and the pinned pnpm version;
- pass workspace typecheck and tests;
- start the local daemon/web lifecycle through `pnpm tools-dev`;
- create a project, run an agent path, and persist a previewable design artifact;
- run the desktop shell against the local web/daemon runtime;
- keep fork-specific decisions documented in `CONTEXT.md` and `docs/adr/`.

## Current State

- Upstream remote is `nexu-io/open-design`.
- This fork tracks upstream `main` and carries only a small set of productization commits.
- Node 24 is the authoritative validation runtime.
- Workspace typecheck and recursive tests pass locally with Node 24.
- PRs to upstream should stay draft until CI, local lifecycle, and desktop smoke results are known.

## Included Work

- Keep this fork rebased on upstream `main`.
- Fix install, typecheck, test, and package-boundary failures.
- Stabilize flaky tests when they block reliable baseline validation.
- Preserve repo rules around contracts, sidecar boundaries, runtime paths, and `tools-dev`.
- Document fork decisions as ADRs instead of leaving them in chat.
- Run and record local smoke checks for web, daemon, desktop, and artifact persistence.

## Explicitly Deferred

- New marketplace or skill-discovery product flows.
- UI imports from reference projects.
- Major design-system editor changes.
- New hosted or SaaS deployment topology.
- Large adapter expansion beyond what is needed to validate the upstream runtime.
- Branding, marketing pages, or landing-page work.

## Validation Ladder

Use the smallest check that proves the current change, then climb the ladder before marking baseline work ready:

1. Targeted test or repro for the changed package.
2. Package typecheck/test for affected package boundaries.
3. Workspace typecheck:
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm typecheck`
4. Workspace tests:
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r --if-present run test`
5. Local lifecycle smoke:
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm tools-dev run web --daemon-port <port> --web-port <port>`
6. Desktop smoke on a GUI-capable machine:
   `pnpm tools-dev inspect desktop status --json`

## Exit Criteria

- `pnpm install`, `pnpm typecheck`, and `pnpm -r --if-present run test` pass under Node 24.
- `pnpm tools-dev run web` can serve the app through the daemon/web pair.
- A project can run through the configured agent path and produce a saved artifact.
- Desktop can discover the web URL through sidecar IPC.
- Known warnings are documented or converted into issues.
- The fork is ready for narrow differentiated work without first debugging the foundation.
