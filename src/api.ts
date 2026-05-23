import { resolveConfig } from "./config.ts";
import type { JsonObject, SearchParams } from "./types.ts";
import { normalizeOptionalString, safeJsonParse } from "./utils.ts";

function buildCandidateBaseUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [normalized];

  for (const suffix of ["/api", "/v1"]) {
    if (normalized.endsWith(suffix)) {
      candidates.push(normalized.slice(0, -suffix.length) || "/");
    }
  }

  return [...new Set(candidates)];
}

async function executeRequest(
  baseUrl: string,
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<{ response: Response; text: string; parsed: unknown }> {
  const url = new URL(`${baseUrl}${pathname}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : undefined;
  return { response, text, parsed };
}

export async function mem0Request(
  method: string,
  pathname: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const config = await resolveConfig();

  const headers: Record<string, string> = {
    "X-API-Key": config.apiKey,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const candidateBaseUrls = buildCandidateBaseUrls(config.baseUrl);
  let lastFailure: { status: number; detail: string } | undefined;

  for (const candidateBaseUrl of candidateBaseUrls) {
    const { response, text, parsed } = await executeRequest(
      candidateBaseUrl,
      method,
      pathname,
      headers,
      body,
      query,
    );

    if (response.ok) {
      return parsed ?? { ok: true, status: response.status };
    }

    const detail = parsed ? JSON.stringify(parsed, null, 2) : text || response.statusText;
    lastFailure = { status: response.status, detail };

    if (response.status !== 404) {
      break;
    }
  }

  throw new Error(`Mem0 ${method} ${pathname} failed (${lastFailure?.status ?? "unknown"}): ${lastFailure?.detail ?? "Unknown error"}`);
}

export function buildSearchPayload(params: SearchParams): JsonObject {
  const payload: JsonObject = {
    query: params.query,
  };

  if (params.top_k !== undefined) payload.top_k = params.top_k;
  if (params.threshold !== undefined) payload.threshold = params.threshold;

  const filters: JsonObject = { ...(params.filters ?? {}) };
  if (params.user_id) filters.user_id = params.user_id;

  const explicitAgentId = normalizeOptionalString(params.agent_id);
  if (explicitAgentId) filters.agent_id = explicitAgentId;
  if (params.run_id) filters.run_id = params.run_id;

  if (Object.keys(filters).length > 0) {
    payload.filters = filters;
  }

  return payload;
}
