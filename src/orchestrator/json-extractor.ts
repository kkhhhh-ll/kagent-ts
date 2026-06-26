/**
 * Shared JSON extraction utility.
 *
 * Extracts a JSON object string from LLM output that may contain markdown
 * fences, surrounding prose, or minor formatting issues.
 *
 * This is a copy of the logic in src/core/response-schema.ts kept here to
 * avoid a circular dependency (response-schema.ts imports system-prompt
 * fragments that the orchestrator does not need).
 */

/**
 * Try to extract a JSON object from a string that may contain
 * markdown, extra text, malformed newlines, or other noise.
 *
 * Returns the JSON string if found, or null.
 */
export function extractJSON(text: string): string | null {
  if (!text) return null;

  // Try with progressively more aggressive cleanup
  const variants = [
    text.trim(),
    cleanupJSON(text.trim()),
    text.trim().replace(/\n/g, " ").replace(/\r/g, ""),
  ];

  // De-duplicate variants
  const seen = new Set<string>();
  const uniqueVariants = variants.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });

  for (const variant of uniqueVariants) {
    const result = tryExtractJSON(variant);
    if (result) return result;
  }

  return null;
}

function tryExtractJSON(text: string): string | null {
  if (isValidJSON(text)) return text;

  // Try extracting from markdown code blocks: ```json ... ```
  const blockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (blockMatch && isValidJSON(blockMatch[1])) return blockMatch[1];

  // Try finding the first { ... } with balanced braces
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    const fromBrace = text.slice(braceStart);
    const result = extractBalancedBraces(fromBrace);
    if (result) return result;
  }

  return null;
}

function extractBalancedBraces(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
        escapeNext = false;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(0, i + 1);
          if (isValidJSON(candidate)) return candidate;
          break;
        }
      }
    }
  }

  return null;
}

function cleanupJSON(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
