# Extension refactor plan

## Context

Noodle’s code footprint is still modest overall, but the extension surface has grown unevenly. The biggest issue is not core memory functionality; it is that config, command, and dev/debug surfaces have accumulated extra layers and duplicated logic. The goal is to keep the current feature set, stay idiomatic TypeScript, and make the codebase easier to scan and maintain by removing slop before touching the web explorer.

This plan intentionally puts the web portion last.

## Approach

Refactor in three passes before touching web:
1. **Centralize config domain logic** so both setup experiences share one source of truth.
2. **Split command orchestration by responsibility** so routing is thin and command files are small.
3. **Trim support-layer complexity** in extension wiring, debug overlay, and memory service helpers.
4. **Only then** revisit the web explorer, when the non-web architecture is cleaner and we can simplify it without dragging existing duplication forward.

The emphasis is on consolidation and decomposition, not clever abstractions. Prefer a few small pure helpers and descriptor objects over factories or heavy generic layers.

## Files to modify

Primary pre-web targets:
- `src/commands.ts`
- `src/config-screen.ts`
- `src/config.ts`
- `src/extension.ts`
- `src/debug-overlay.ts`
- `src/memory/service.ts`
- `src/utils.ts`
- `src/types.ts`

Likely new files/directories:
- `src/commands/index.ts`
- `src/commands/setup.ts`
- `src/commands/memory-crud.ts`
- `src/commands/review.ts`
- `src/commands/status.ts`
- `src/commands/web.ts`
- `src/commands/ui.ts`
- `src/config/schema.ts`
- `src/config/draft.ts`
- `src/config/summary.ts`

Web phase (last):
- `src/web/index.html`
- `src/web/server.ts`
- `src/web/manager.ts`
- `src/web/run.ts`
- `src/web/dev.ts`
- optional extracted assets/modules under `src/web/`

## Reuse

Existing code and patterns to preserve/reuse:
- `resolveConfig`, `writeConfig`, `defaultExtractorTriggerEvery` in `src/config.ts`
- `runConfigScreen` in `src/config-screen.ts` as the richer UI entrypoint
- command flows in `src/commands.ts` for current user-facing behavior and text
- `maskSecret` in `src/utils.ts` as the shared secret-display helper
- `MemoryService` public methods in `src/memory/service.ts` as the stable memory domain surface
- extractor event/debug hooks in `src/debug-overlay.ts` and `src/extension.ts`
- explorer process/server split already present in `src/web/manager.ts` and `src/web/server.ts`

## Steps

- [ ] **Create a shared config domain layer**
  - Move provider defaults, extractor defaults, validation, summaries, and partial serialization out of `src/config-screen.ts` and `src/commands.ts`.
  - Define config field metadata declaratively instead of scattering labels, visibility rules, and defaults across switch statements.
  - Keep `resolveConfig`/`writeConfig` as the persistence boundary.

- [ ] **Refactor `runConfigScreen` to consume shared config helpers**
  - Keep the current TUI behavior, but reduce manual field bookkeeping.
  - Remove config-specific duplication from the screen implementation.
  - Delete the local `maskSecret` copy in favor of `src/utils.ts`.

- [ ] **Refactor setup fallback prompts to consume the same shared config helpers**
  - Preserve the existing fallback UX for environments without custom UI support.
  - Make prompt flow thin: collect values, call shared validation/defaulting/summary helpers, save.

- [ ] **Split `src/commands.ts` into command-family modules**
  - Keep one small router/registration entrypoint.
  - Move setup, review, memory CRUD, status, and web commands into separate files.
  - Extract shared UI helpers for notify/confirm/input patterns where that reduces repetition without obscuring behavior.

- [ ] **Trim `src/extension.ts` to pure event wiring**
  - Extract helpers for repeated session-capture and extraction-queue flows.
  - Keep handler bodies short and declarative.
  - Preserve current behavior around shutdown, compaction, and extractor cadence.

- [ ] **Simplify `src/debug-overlay.ts`**
  - Remove the unused `setStatus`/`renderStatus` path if widget-only behavior is sufficient.
  - Collapse duplicated success/error finalization logic.
  - Keep the overlay readable and obviously optional.

- [ ] **Tighten helper duplication in `src/memory/service.ts`**
  - Centralize normalized text-overlap matching used by dedupe/retrieval bookkeeping.
  - Centralize promotion metadata assembly.
  - Avoid changing retrieval/promotion policy behavior unless tests prove equivalence.

- [ ] **Run tests and compare footprint before web changes**
  - Confirm behavior is unchanged.
  - Recount file/LOC distribution to ensure pre-web cleanup already improved shape.

- [ ] **Refactor web last**
  - After non-web cleanup, decide whether the explorer should be merely modularized or also simplified.
  - Minimum pass: split giant inline HTML/CSS/JS into focused assets/modules.
  - Preferred pass: keep the same feature set but reduce one-off UI state and make the server/UI boundary more obvious.

## Verification

Pre-web verification:
- Run `npm test`.
- Run `npm run check`.
- Manually exercise:
  - `/noodle`
  - `/noodle settings`
  - fallback setup flow when custom UI is unavailable
  - `/noodle remember`, `/noodle forget`, `/noodle edit`, `/noodle review`
  - extractor debug flow if enabled
- Re-run the footprint comparison to confirm command/config/support layers shrank or at least became structurally cleaner.

Web-phase verification:
- Run `npm run check` and `npm test` again.
- Run `/noodle web` and `/noodle web stop`.
- Verify explorer load, edit, delete, live reload/dev behavior, and auto-shutdown behavior remain intact.

## Notes

Recommended implementation order:
1. shared config domain
2. config screen + fallback setup reuse
3. command split
4. extension/debug/service cleanup
5. web cleanup last

This order should produce cleaner architecture early, reduce duplication before moving files around, and avoid spending time polishing the largest sidecar feature before the core extension surface is simplified.
