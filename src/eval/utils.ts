/**
 * Shared utilities for the eval package — avoids duplicating LLM JSON
 * parsing logic across evaluator and runner.
 */

/**
 * Safely parse LLM-generated JSON with automatic markdown-fence stripping.
 *
 * LLMs often wrap JSON in ```json fences or add trailing text.  This
 * strips those before handing the result to `JSON.parse`.
 *
 * @returns The parsed value, or `undefined` if the string cannot be parsed
 *          as valid JSON (malformed, empty, etc.).
 */
export function parseLLMJson(raw: string): unknown {
  try {
    let json = raw.trim();

    // Strip markdown code fences when present
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) json = fenceMatch[1].trim();

    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
