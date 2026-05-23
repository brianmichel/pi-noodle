import { DEFAULT_AGENT_ID } from "./constants.ts";
import { prefilterUserMessage, buildSignalKey } from "./memory-heuristics.ts";
import { upsertMemoryCandidate } from "./memory-store.ts";
import { enqueueWriteTask } from "./queue.ts";
import type { LocalSignal, MemoryCandidate, MemoryCategory } from "./memory-types.ts";
import type { NotificationTarget } from "./types.ts";

const localSignals = new Map<string, LocalSignal>();
const recentlySaved = new Set<string>();

function candidateCategoriesForPrompt(prompt: string): MemoryCategory[] {
  const categories: MemoryCategory[] = ["identity", "response_style"];

  if (/\b(code|implement|implementation|refactor|fix|test|review|debug|script|function|library|framework|tool|tooling|stack)\b/i.test(prompt)) {
    categories.push("coding_pref", "workflow");
  }

  if (/\b(repo|project|convention|branch|workflow|team|codebase)\b/i.test(prompt)) {
    categories.push("project", "workflow");
  }

  return Array.from(new Set(categories));
}

function shouldPromoteCandidate(candidate: MemoryCandidate, signal: LocalSignal): boolean {
  if (candidate.explicit) return true;
  if (candidate.category === "identity") return true;
  if (signal.count >= 3) return true;
  return candidate.confidence >= 0.9 && signal.count >= 2;
}

function toMemoryMetadata(candidate: MemoryCandidate, signal: LocalSignal): Record<string, unknown> {
  return {
    category: candidate.category,
    categories: [candidate.category],
    durability: candidate.durability,
    confidence: candidate.confidence,
    source: signal.count >= 2 && !candidate.explicit ? "repetition" : candidate.source,
    signal_count: signal.count,
    trigger_reasons: candidate.reasons,
    agent_id: DEFAULT_AGENT_ID,
    auto_saved: true,
  };
}

export function buildRetrievalPlan(prompt: string): { shouldRetrieve: boolean; categories: MemoryCategory[] } {
  const prefilter = prefilterUserMessage(prompt);
  return {
    shouldRetrieve: prefilter.shouldRetrieve,
    categories: candidateCategoriesForPrompt(prompt),
  };
}

export function queueAutomaticMemoryCapture(text: string, target?: NotificationTarget): boolean {
  const prefilter = prefilterUserMessage(text);
  if (!prefilter.hasCandidate) return false;

  let queued = false;
  for (const candidate of prefilter.candidates) {
    const key = buildSignalKey(candidate);
    const signal = localSignals.get(key) ?? { key, count: 0, lastSeenAt: 0 };
    signal.count += 1;
    signal.lastSeenAt = Date.now();
    localSignals.set(key, signal);

    if (recentlySaved.has(key) || !shouldPromoteCandidate(candidate, signal)) {
      continue;
    }

    queued = true;
    recentlySaved.add(key);
    enqueueWriteTask({
      label: "Mem0 automatic memory capture",
      ...(target ? { target } : {}),
      task: async () => {
        const result = await upsertMemoryCandidate({
          text: candidate.text,
          normalized: candidate.normalized,
          metadata: toMemoryMetadata(candidate, signal),
        });
        if (result !== "saved") {
          recentlySaved.delete(key);
        }
      },
      onFailure: () => {
        recentlySaved.delete(key);
      },
    });
  }

  return queued;
}
