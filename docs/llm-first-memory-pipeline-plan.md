# LLM-First Memory Pipeline Plan

## Context

Build a more proactive memory pipeline that feels more "magical" than the current heuristic-first flow while preserving memory quality and giving users explicit control over cost/behavior. The existing system already has heuristic capture, optional LLM extraction, pending candidate review, retrieval injection, and a configurable extractor cadence, so this plan should extend those paths rather than replace them wholesale.

## Approach

Recommended direction: move to **LLM-first discovery, policy-gated persistence**.

Decisions captured from planning:
- Add a **behavior mode** setting so users can feel both ends of the tradeoff, not hard-code a single bias.
- Initial modes: `conservative`, `balanced`, `proactive`.
- Keep **medium-confidence** memories in the existing reviewable pending layer; do not let them influence retrieval before promotion.
- **Defer explicit confirmation UX** for now; v1 only needs `auto-save`, `pending/review`, and `discard` outcomes.
- Cost control is handled by **extraction frequency/cadence**, not a separate token budget system.

Recommended mode behavior:
- `conservative`
  - Heuristics remain primary.
  - LLM extraction runs less often and only promotes very high-confidence, low-risk candidates.
  - Most inferred preferences stay pending unless reinforced.
- `balanced` (recommended default)
  - LLM extraction participates in normal discovery.
  - High-confidence durable facts and low-risk defaults can auto-save.
  - Medium-confidence preferences go to pending review.
- `proactive`
  - LLM extraction runs more frequently.
  - More candidate memories are surfaced into pending review.
  - Persistence is still policy-gated; sensitive/transient content remains blocked.

Pipeline target:
1. **Heuristic prefilter**: explicit memory asks, stable regex signals, temporary/sensitive blocking.
2. **LLM candidate extraction**: structured candidate output with policy metadata.
3. **Policy decision**: classify each candidate as `save`, `pending`, or `discard` based on mode, confidence, durability, sensitivity, and evidence.
4. **Persistence/review**:
   - `save` → durable memory DB write
   - `pending` → local review queue only
   - `discard` → dropped
5. **Retrieval**: only durable saved memories can be injected into prompts in v1.

Implementation priority:
1. Tests and verification
2. Settings/config plumbing
3. Policy and service behavior
4. Extension/runtime integration
5. Inline comments
6. Markdown docs
7. Diagram

## Files to modify

Core behavior:
- `src/memory/service.ts` — unify heuristic and LLM candidate handling, mode-aware promotion rules, pending-vs-save outcomes, metadata capture.
- `src/memory/extractor.ts` — richer structured extraction schema for confidence/reason/risk/durability style fields.
- `src/memory/policy.ts` — mode-aware thresholds, sensitivity/transience rules, promotion decision helpers, reusable policy constants.
- `src/memory/types.ts` — new candidate/policy decision/config-related memory types.

Settings/runtime:
- `src/types.ts` — extend `NoodleExtractorConfig` with behavior mode and cadence fields.
- `src/config.ts` — defaults + env override handling for new settings.
- `src/config-screen.ts` — settings UI fields, validation, summary text, defaults.
- `src/commands.ts` — `/noodle` status output and setup summaries for new settings.
- `src/memory/runtime.ts` — expose resolved mode/cadence defaults to runtime.
- `src/extension.ts` — mode-aware extraction cadence and integration tests.

Documentation:
- `README.md` — user-facing explanation of behavior modes and review flow.
- `docs/memory-system-evaluation-plan.md` — expand eval framework around proactive extraction tradeoffs.
- `docs/llm-first-memory-pipeline-plan.md` — this implementation plan.

Tests:
- `test/memory-heuristics.test.ts`
- `test/memory-service.test.ts`
- `test/memory-quality-e2e.test.ts`
- `test/extension.test.ts`
- likely add `test/config*.test.ts` or extend existing config/settings coverage if present once implementation shape is clear.

## Reuse

- `src/memory/service.ts`
  - `queueAutomaticCapture()` already stages/promotes heuristic candidates.
  - `queueLLMExtraction()` already performs batched extraction on cadence.
  - `listPendingCandidates()` / `dismissPendingCandidate()` already expose a reviewable pending layer.
  - `addCandidateIfNovel()` and merge metadata logic already handle dedupe/merge.
- `src/memory/policy.ts`
  - `prefilterUserMessage()` already blocks sensitive content and ignores temporary instructions.
  - `evaluateCandidatePromotion()` already scores repetition, confidence, explicit asks, and project/default conventions.
  - `shouldRetrieveMemories()` and `categoriesForPrompt()` already control retrieval scope.
- `src/types.ts`, `src/config.ts`, `src/config-screen.ts`, `src/commands.ts`, `src/memory/runtime.ts`
  - Existing extractor settings path (`enabled`, `model`, `triggerEvery`) can be expanded instead of adding a parallel config system.
- Existing tests
  - `test/memory-heuristics.test.ts`, `test/memory-service.test.ts`, `test/memory-quality-e2e.test.ts`, and `test/extension.test.ts` already cover the current memory behavior and should be extended first.

## Steps

- [ ] **Lock the settings contract first**
  - Add extractor behavior mode enum: `conservative | balanced | proactive`.
  - Keep `enabled` as the master switch.
  - Keep cadence as `triggerEvery` and make it mode-aware via defaults rather than a separate budget system.
  - Proposed defaults:
    - extractor disabled by default unless already enabled in user config
    - when enabled and unset: mode = `balanced`
    - cadence defaults:
      - conservative: every 20 user turns
      - balanced: every 10 user turns
      - proactive: every 4-5 user turns
  - Make mode editable in settings UI and visible in `/noodle` summary output.

- [ ] **Write failing tests before implementation**
  - Policy tests for mode-specific thresholds and outcomes.
  - Service tests for `save` vs `pending` vs `discard` behavior.
  - Extension/runtime tests for different extraction cadences by mode.
  - Config/settings tests for defaults, validation, and env overrides.
  - E2E quality tests for proactive recall without precision collapse.

- [ ] **Expand the extraction schema**
  - Replace the current narrow extraction object with a candidate shape that can support policy gating, e.g.:
    - `text`
    - `category`
    - `durability`
    - `confidence`
    - `reason`
    - `stability` or equivalent long-term score
    - `sensitivity` or risk flag
    - `suggestedAction` (`save | pending | discard`) as advisory only
  - Keep the final persistence decision in local policy code, not in the model alone.
  - Update prompt instructions so the extractor is conservative about transient task details and secrets.

- [ ] **Refactor policy into explicit decision helpers**
  - Add a central decision function that takes:
    - candidate
    - accumulated local signal/repetition evidence
    - active mode
  - Return a structured decision:
    - `action: save | pending | discard`
    - `score`
    - `reasons`
  - Hard requirements:
    - explicit memory asks can still save immediately unless sensitive/temporary
    - sensitive content is always blocked
    - temporary/task-local instructions are always discarded
    - medium-confidence inferred preferences become pending
    - only high-confidence, low-risk, durable memories auto-save

- [ ] **Unify heuristic and LLM candidate handling in the service**
  - Reuse one promotion pipeline for heuristic and LLM candidates instead of separate logic paths.
  - Preserve existing dedupe/merge behavior through `addCandidateIfNovel()`.
  - Persist decision metadata for observability, e.g. mode, confidence, reasons, source, signal count.
  - Keep pending candidates reviewable via the existing `/noodle review` flow.
  - Do not let pending candidates affect prompt injection in v1.

- [ ] **Implement settings/config/runtime support**
  - Extend `NoodleExtractorConfig` with a `mode` field.
  - Add env override support for the new mode if desired (`NOODLE_EXTRACTOR_MODE`) while keeping current env behavior intact.
  - Validate that cadence remains a positive integer.
  - Update settings screen labels and summary strings so users understand the tradeoff:
    - conservative = higher precision / lower magic / lower cost
    - balanced = default tradeoff
    - proactive = more candidate discovery / more review load / higher cost

- [ ] **Update extension trigger behavior**
  - Preserve the current event hook structure in `src/extension.ts`.
  - Make extraction cadence derive from resolved config.
  - Ensure manual capture and heuristic capture still work even when extractor mode is conservative or disabled.
  - Ensure shutdown extraction and consolidation still behave sensibly with the new mode rules.

- [ ] **Expand verification-focused test coverage**
  - `test/memory-heuristics.test.ts`
    - mode-aware promotion thresholds
    - pending outcomes for medium-confidence inferred preferences
    - discard outcomes for temporary/sensitive content
  - `test/memory-service.test.ts`
    - unified handling for heuristic and LLM candidates
    - pending queue population without DB writes
    - save promotion after repeated evidence
    - durable auto-save in proactive/balanced modes when confidence is high
  - `test/extension.test.ts`
    - conservative/balanced/proactive cadence behavior
    - fallback to active/default model behavior unchanged
  - `test/memory-quality-e2e.test.ts`
    - proactive mode increases candidate discovery while keeping sensitive/transient exclusion
    - balanced mode saves durable facts and pushes softer preferences to pending
    - retrieval only uses saved memories, not pending ones
    - explicit forget/update continues to work after LLM-first capture

- [ ] **Add inline comments after tests pass**
  - Comment the policy boundary between extraction and persistence.
  - Comment why pending candidates do not participate in retrieval.
  - Keep comments focused on invariants and tradeoffs, not line-by-line narration.

- [ ] **Finish user-facing docs last**
  - Update `README.md` with new settings, examples, and review behavior.
  - Expand `docs/memory-system-evaluation-plan.md` with quality metrics and eval cases for each mode.
  - Add a small markdown pipeline diagram showing:
    - input → heuristic filter → LLM extraction → policy decision → save/pending/discard → retrieval

## Verification

Implementation verification order:

1. **Policy/unit verification**
   - Run memory heuristic/policy tests and confirm each mode produces the expected `save`, `pending`, or `discard` outcome.
   - Verify explicit durable facts still save reliably.
   - Verify temporary and sensitive messages never promote in any mode.

2. **Service verification**
   - Confirm pending candidates are retained for review without durable DB writes.
   - Confirm repeated evidence can promote a pending candidate into a saved memory.
   - Confirm dedupe/merge metadata still works for repeated captures.

3. **Settings/runtime verification**
   - Validate settings UI for enabled/disabled extractor, mode selection, and cadence validation.
   - Verify resolved config defaults and environment overrides.
   - Verify extension cadence behavior by mode using tests.

4. **End-to-end quality verification**
   - Balanced mode: durable facts save, softer inferred preferences go pending.
   - Conservative mode: lower auto-save rate and fewer proactive captures.
   - Proactive mode: more candidate discovery without sensitive/transient leakage.
   - Retrieval only injects saved memories; pending items remain invisible to prompt injection.
   - Forget/update flows continue to work with memories created by heuristic and LLM-first paths.

5. **Manual verification**
   - Use `/noodle settings` to switch between conservative, balanced, and proactive.
   - Use `/noodle review` to inspect medium-confidence candidates.
   - Run a few realistic conversation scripts to compare review load and saved-memory quality across modes.

Suggested test commands:
- `npm test`
- or targeted runs for memory-related suites first if the repo supports them.

## Open implementation notes

- Yes: this should absolutely be built as **settings** so you can feel both sides of the tradeoff in practice instead of arguing about a single global default.
- Recommended default is still `balanced`, but the product should make mode switching easy enough for internal evaluation and dogfooding.
- If review load in `proactive` is too high, tune thresholds before adding confirmation UX.
