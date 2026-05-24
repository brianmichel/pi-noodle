import type { JsonObject } from "./types.ts";

export function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJsonObject(value: unknown, fallback: JsonObject = {}): JsonObject {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonStringArray(value: unknown, fallback: string[] = []): string[] {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string" || Array.isArray(parsed)) {
      return asStringArray(parsed);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const typedPart = part as { type?: string; text?: string };
      if (typedPart.type === "text" && typeof typedPart.text === "string") {
        return [typedPart.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}
