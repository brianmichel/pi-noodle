# Noodle extension size audit

## Current footprint

Code footprint (`src/` + `test/`, JS/TS only):
- 37 files
- 6,222 LOC
- 199.0 KB

Largest source files/assets:
- `src/web/index.html` — 1,964 LOC, 67.6 KB
- `src/memory/turso-backend.ts` — 717 LOC, 26.5 KB
- `src/commands.ts` — 714 LOC, 21.1 KB
- `src/config-screen.ts` — 657 LOC, 18.8 KB
- `src/memory/service.ts` — 511 LOC, 16.7 KB
- `src/debug-overlay.ts` — 251 LOC, 7.3 KB
- `src/web/server.ts` — 213 LOC, 6.0 KB
- `src/extension.ts` — 197 LOC, 7.0 KB
- `src/tools.ts` — 173 LOC, 6.2 KB
- `src/config.ts` — 160 LOC, 5.5 KB

## Biggest likely sources of bloat

### 1) Web explorer is the dominant footprint
Files:
- `src/web/index.html`
- `src/web/server.ts`
- `src/web/manager.ts`
- `src/web/run.ts`
- `src/web/dev.ts`

Observations:
- `src/web/index.html` alone is **1,964 LOC**.
- The HTML contains both a **969-line `<style>` block** and a **740-line `<script>` block`**.
- This feature family is roughly **2.3k+ LOC** before counting tests.
- For an extension whose core value is memory capture/search, this is a very large sidecar surface area.

Why it feels “vibey”:
- Big inline HTML/CSS/JS tends to grow without strong module boundaries.
- The server API is small, but the UI implementation is effectively a mini app living in one file.
- That makes review harder and invites one-off UI state code.

Keep feature set, remove slop:
- Split `index.html` into static assets (`index.html`, `explorer.css`, `explorer.js`) at minimum.
- Then decide whether the explorer should stay this rich, or become a compact CRUD browser.
- If the current feature set stays, move to a few tiny modules:
  - table/rendering
  - filters/search state
  - websocket/live reload
  - edit/delete actions

Expected payoff:
- Even without removing functionality, this should cut the “one giant file” feel immediately.
- If the explorer is simplified to a minimal review/search UI, this is the single biggest place to win back code size.

### 2) Config flow is duplicated across two UIs
Files:
- `src/commands.ts`
- `src/config-screen.ts`
- `src/config.ts`

Observations:
- `src/commands.ts` contains a full fallback setup wizard with provider-specific prompts, validation, summaries, and save flow.
- `src/config-screen.ts` re-implements the same domain logic in a richer TUI.
- `maskSecret` exists in both `src/utils.ts` and `src/config-screen.ts`.
- Provider defaults, extractor defaults, validation rules, summaries, and field labels are spread across multiple files.

Why it feels bloated:
- The code is not large because config is inherently complex; it is large because the same config rules appear in multiple places.
- `config-screen.ts` is **657 LOC** and `commands.ts` is **714 LOC**. A lot of that is config/editing ceremony.

Keep feature set, remove slop:
- Introduce a shared config schema/descriptor module, for example `src/config-schema.ts`, holding:
  - field metadata
  - provider defaults
  - validation
  - summary rendering
  - partial serialization
- Make both setup UIs consume that shared logic.
- Keep two frontends if needed:
  - rich settings screen
  - simple prompt fallback
- But collapse business rules into one place.

Expected payoff:
- Likely one of the best refactors for size *and* clarity.
- Removes drift risk between the two config experiences.

### 3) `commands.ts` is doing too many jobs
File:
- `src/commands.ts`

Observations:
- It handles:
  - command routing
  - status rendering
  - setup flow
  - memory CRUD commands
  - review flow
  - web explorer lifecycle
  - provider parsing and validation helpers
- File metrics: **714 LOC**, ~**23 function/closure sites**, **49 `ui.notify` calls**.

Why it feels bloated:
- This is a classic “god command file”.
- It mixes domain actions with UI prompting and text formatting.
- Many helpers are fine individually, but the aggregate makes the file dense.

Keep feature set, remove slop:
- Split by command family:
  - `src/commands/index.ts` — routing only
  - `src/commands/setup.ts`
  - `src/commands/memory-crud.ts`
  - `src/commands/review.ts`
  - `src/commands/web.ts`
  - `src/commands/status.ts`
- Move repeated notify/confirm patterns into small helpers.
- Let the router be boring and declarative.

Expected payoff:
- May not reduce raw LOC dramatically by itself, but greatly improves readability and reviewability.
- Once split, duplicated text/validation becomes easier to see and delete.

### 4) `config-screen.ts` is a hand-rolled state machine
File:
- `src/config-screen.ts`

Observations:
- **657 LOC**, **24 switch cases**, **48 `if` conditions**, **41 `FIELD.` references**.
- Field IDs, labels, item builders, validation, defaulting, serialization, and summary logic are all in one file.

Why it feels bloated:
- It is implementing a form engine by hand, but only for one screen.
- The complexity comes from maintaining parallel maps in code:
  - field id -> label
  - field id -> editor
  - provider -> visible fields
  - provider -> defaults
  - draft -> validation
  - draft -> persisted config

Keep feature set, remove slop:
- Define fields declaratively.
- Drive label, description, editor type, visibility, masking, defaulting, and serialization from data.
- Pull pure config logic out of UI code.

Expected payoff:
- Fewer switches and manual branches.
- Easier to add/remove settings without touching 5 places.

### 5) Debug overlay is a lot of code for a dev-only feature
File:
- `src/debug-overlay.ts`

Observations:
- **251 LOC** for a feature gated behind extractor debug.
- `renderStatus()` currently returns `undefined`, but `STATUS_KEY` and `setStatus()` are still wired through `emit()`.
- Contains spinner management, run summaries, widget rendering, and session tracking.

Why it feels bloated:
- This is a lot of permanent surface area for a temporary/developer-facing affordance.
- Some code is effectively dead or near-dead (`renderStatus` path).

Keep feature set, remove slop:
- Remove unused status path entirely if widget-only is enough.
- Collapse run-finalization logic (`noteExtractorRunFinished` / `noteExtractorRunFailed`) into a shared helper.
- Consider a slimmer debug snapshot model instead of multiple imperative event updaters.

Expected payoff:
- Moderate LOC reduction and less lifecycle complexity.

### 6) `extension.ts` contains repeated event patterns
File:
- `src/extension.ts`

Observations:
- Repeats similar logic for:
  - session capture on compact/switch/shutdown
  - extractor model resolution + queueing
  - skip/queue bookkeeping
- The code is readable, but there is repeated orchestration logic.

Keep feature set, remove slop:
- Extract helpers like:
  - `captureSession(reason, ctx, options?)`
  - `maybeQueueExtraction(reason, ctx, target?)`
- Keep event handlers as short declarative bindings.

Expected payoff:
- Small raw LOC win, but important for keeping the extension entrypoint easy to scan.

### 7) `MemoryService` has some repeated matching/promotion plumbing
File:
- `src/memory/service.ts`

Observations:
- Repeated normalized-string overlap checks appear in multiple places:
  - `addCandidateIfNovel`
  - `findMatchingSignalKey`
  - `noteRetrievedMemories`
- Candidate promotion metadata is assembled in several stages.

Why it feels mildly bloated:
- This is not the worst offender, but it has “grew feature by feature” energy.
- The policy is valuable, but the mechanics could be tighter.

Keep feature set, remove slop:
- Introduce a tiny shared predicate for memory text overlap.
- Introduce a dedicated metadata builder for promoted candidates.
- Keep policy/evaluation separate from bookkeeping.

Expected payoff:
- Small-to-medium LOC reduction with better maintainability.

## Likely justified complexity (don’t optimize first)

### `src/memory/turso-backend.ts`
- Large at **717 LOC**, but this is close to the product core.
- Backend code often earns its size if it is where correctness lives.
- I would only trim here after cleaning the UI/config surfaces.

### `src/tools.ts`
- Repetitive, but straightforward.
- Could be factory-generated, though that may hurt clarity more than help.
- Lower priority unless a shared helper makes the code obviously better.

## Recommended order of attack

### Tier 1: highest impact
1. **Shrink / modularize the web explorer**
   - biggest single footprint
   - likely strongest “feels too large for what it does” contributor
2. **Unify config domain logic across `commands.ts` and `config-screen.ts`**
   - removes duplicated rules and vibe-coded branches
3. **Split `commands.ts` by responsibility**
   - reduces cognitive load and exposes more dead duplication

### Tier 2: good cleanup wins
4. **Trim `debug-overlay.ts`**
5. **Collapse repeated orchestration in `extension.ts`**
6. **Normalize matching/promotion helpers in `memory/service.ts`**

## Concrete “slop” indicators found

- Large inline app in `src/web/index.html` instead of modular assets.
- Two config UIs carrying overlapping provider/default/validation logic.
- Duplicate `maskSecret` implementation.
- Dead-ish status path in debug overlay (`renderStatus()` always returns `undefined`).
- A single command file carrying setup, review, CRUD, status, and web process control.
- Repeated substring/normalization logic in memory promotion paths.

## Suggested target shape

If the goal is “same features, less slop”, I’d aim for this:

- `src/extension.ts`
  - only event wiring
- `src/commands/`
  - one file per command family
- `src/config/`
  - shared config schema/defaults/validation/serialization
  - TUI renderer separate from fallback prompt flow
- `src/web/`
  - externalized static assets, small focused modules
- `src/memory/`
  - keep core backend/service/policy, but tighten helper duplication

## My short opinion

The extension does not look bloated because the memory core is inherently too complex.
It looks bloated because **UI/config surfaces expanded faster than the core architecture**:
- one giant web file
- duplicated config logic
- one oversized command file
- a fairly elaborate dev overlay

That is good news: the biggest wins are mostly **surface cleanup**, not risky backend surgery.
