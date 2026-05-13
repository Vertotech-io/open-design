# Use nexu-io/open-design as the upstream

We will treat `nexu-io/open-design` as the primary upstream for this repo and build this productization fork from that architecture, rather than switching the base to `OpenCoworkAI/open-codesign`. `open-codesign` remains an important reference project for UX patterns such as comment mode, tweak sliders, previews, and exports, but its Electron form factor and owned provider loop conflict with the Open Design direction of a Next.js web app plus local daemon that delegates to the user's existing coding-agent CLI.

## Considered Options

- `nexu-io/open-design` as upstream: matches the desired web plus daemon architecture and file-based skills/design-systems direction.
- `OpenCoworkAI/open-codesign` as base fork: strong UX reference, but would require replacing its Electron and provider-loop assumptions.

## Consequences

Future work should first reconcile against `nexu-io/open-design` before importing patterns from other repositories. External repositories are reference projects unless a separate ADR promotes one to upstream or vendored dependency.

Git remotes should follow this convention: `origin` points at this productization fork, and `upstream` points at `https://github.com/nexu-io/open-design.git`.
