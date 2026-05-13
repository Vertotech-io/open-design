# Open Design

Open Design is an open-source substrate for generating editable design artifacts through the user's existing coding-agent CLI. This context captures the product language and architectural boundaries used when planning the system.

## Language

**Open Design**:
The product system this repo is building: a web app plus local daemon that turns briefs into editable design artifacts through external coding agents.
_Avoid_: Claude Design clone, design generator

**Design artifact**:
A generated, previewable output such as an HTML prototype, deck, template, media composition, or `DESIGN.md`.
_Avoid_: mockup, output, result

**Skill**:
A file-based agent instruction package, usually `SKILL.md` plus optional assets and references, that teaches an agent how to produce a specific artifact shape.
_Avoid_: plugin, template, prompt

**Design system**:
A versioned `DESIGN.md` file that defines reusable visual language for artifacts.
_Avoid_: theme, style preset

**Upstream**:
The external repository treated as the primary source of architectural direction and mergeable changes.
_Avoid_: inspiration, reference

**Reference project**:
An external project used for patterns or validation without treating its codebase as the product base.
_Avoid_: upstream, dependency

**Productization fork**:
This repo's role when it builds on a chosen upstream while adding fixes, integration work, and differentiation.
_Avoid_: rewrite, clone

## Relationships

- **Open Design** produces **Design artifacts** by orchestrating coding agents through **Skills**.
- A **Design system** constrains the visual language used by a **Skill** when generating a **Design artifact**.
- `nexu-io/open-design` is the **Upstream** for this **Productization fork**.
- `OpenCoworkAI/open-codesign`, `multica-ai/multica`, `op7418/guizang-ppt-skill`, and similar repos are **Reference projects** unless explicitly promoted to **Upstream**.

## Example dialogue

> **Dev:** "Should we fork Open CoDesign and build from there?"
> **Domain expert:** "No. Treat `nexu-io/open-design` as the **Upstream**. Open CoDesign is a **Reference project** for UX patterns, not the base for this **Productization fork**."

## Flagged ambiguities

- "repo to fork" was ambiguous between **Upstream** and **Reference project**. Resolved: `nexu-io/open-design` is the upstream; other repos are evaluated for reusable patterns, skills, or license-compatible vendoring.
