import type { JsonObject } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export function buildCandidateBaseUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [normalized];

  for (const suffix of ["/api", "/v1"]) {
    if (normalized.endsWith(suffix)) {
      candidates.push(normalized.slice(0, -suffix.length) || "/");
    }
  }

  return [...new Set(candidates)];
}

type RequestWithFallbackInput = {
  baseUrl: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  label: string;
};

async function executeRequest(baseUrl: string, input: RequestWithFallbackInput): Promise<{ response: Response; text: string; parsed: unknown }> {
  const url = new URL(`${baseUrl}${input.pathname}`);

  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: input.method,
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  const text = await response.text();
  return {
    response,
    text,
    parsed: text ? safeJsonParse(text) : undefined,
  };
}

export async function requestJsonWithFallback(input: RequestWithFallbackInput): Promise<unknown> {
  const candidateBaseUrls = buildCandidateBaseUrls(input.baseUrl);
  let lastFailure: { status: number; detail: string } | undefined;

  for (const candidateBaseUrl of candidateBaseUrls) {
    const { response, text, parsed } = await executeRequest(candidateBaseUrl, input);
    if (response.ok) {
      return parsed ?? { ok: true, status: response.status };
    }

    const detail = parsed ? JSON.stringify(parsed, null, 2) : text || response.statusText;
    lastFailure = { status: response.status, detail };

    if (response.status !== 404) {
      break;
    }
  }

  throw new Error(`${input.label} failed (${lastFailure?.status ?? "unknown"}): ${lastFailure?.detail ?? "Unknown error"}`);
}

export function buildCategoryFilterPayload(category?: string, categories?: string[]): JsonObject {
  const filter: JsonObject = {};
  if (category) filter.category = category;
  if (categories && categories.length > 0) filter.categories = categories;
  return filter;
}
