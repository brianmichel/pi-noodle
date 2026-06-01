# AGENTS.md

This file applies to this entire repository.

## Goal

We are trying to build a minimal, high-quality memory system for the Pi.dev agent harness. We aim to have a high quality test suite to help prove the efficacy of this project. It should be straight forward for memories to be stored, and retrieved. Ideally this happens automatically for the user.

## Type safety

Prefer creating types where needed to represent things instead of just strings. We like types since they help us better understand and reason about our code. Use the TypeScript type system to make contracts clear, and ensure that side effects are easily dealt with.

## Tooling

This project uses mise to provide a unified interface into dependencies and tasks. The following tasks are available:

- `mise check`: run the TypeScript type checker
- `mise install`: install any dependencies
- `mise precommit`: run precommit validation
- `mise test`: runs this project's unit test suite.

## Dead Code & Comments

- Delete dead code. Do not deprecate it, alias it, or leave it behind "for consumers." This is a private monorepo, not a published library.
- When a refactor replaces an interface or flow, remove the superseded entrypoints in the same change. Do not keep compatibility wrappers, transitional fallbacks, or duplicate code paths unless the user explicitly asks for a staged migration.
- Update tests and callers to the new seam instead of preserving the old one.
- Do not add decorative section-divider comments (e.g. `// -----------`).
- Do not add comments that restate what the code already says.
- JSDoc on public package exports is expected.

## Validation

You can validate your work by running the precommit task and ensure it has a normal exit status and there is no abnormal output.
