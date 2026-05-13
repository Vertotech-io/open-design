# Stabilize upstream before differentiation

For v1, we will first make the upstream Open Design system run reliably in this productization fork before adding differentiated features. The stabilization target is the main local loop: install dependencies, typecheck, test, run the web plus daemon lifecycle, and verify that skills can produce previewable design artifacts.

## Considered Options

- Stabilize upstream first: reduces uncertainty and gives every later feature a working baseline.
- Build differentiated features immediately: moves faster on visible novelty, but risks stacking product ideas on an unverified runtime.

## Consequences

Feature work such as repository discovery, a skill marketplace, expanded media generation, or deeper Open CoDesign UX imports should wait until the upstream runtime path is known-good in this fork. Bugs that block install, test, typecheck, local lifecycle, skill loading, or artifact preview take priority over new feature work during v1.
