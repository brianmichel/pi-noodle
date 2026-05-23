export function maskSecret(value?: string): string {
  if (!value) return "(unset)";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
