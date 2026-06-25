import Ajv, { ErrorObject } from "ajv";
import { ToolErrorCode, toolError, ToolResult } from "./types";

/**
 * Validates tool arguments against the tool's JSON Schema definition.
 *
 * Uses ajv to compile each tool's `parameters` schema once, then validates
 * incoming arguments before the tool is executed — catching missing required
 * params, wrong types, etc. before wasting an LLM round-trip on a call that
 * would fail.
 */

const ajv = new Ajv({
  allErrors: true,        // collect all errors, not just the first
  strict: false,          // allow non-strict JSON Schema keywords LLMs may emit
  coerceTypes: false,     // don't silently coerce — surface type errors
});

/** Cache of compiled validators keyed by a per-tool stable key. */
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

/**
 * Build a stable cache key from a tool's name and parameters hash.
 *
 * We hash `JSON.stringify(parameters)` so that if a tool's schema changes at
 * runtime (e.g. MCP tools reconnecting with a different schema) the cache
 * invalidates automatically.
 */
function cacheKey(toolName: string, parameters: Record<string, unknown>): string {
  return `${toolName}::${JSON.stringify(parameters)}`;
}

/**
 * Check whether the JSON Schema has any real constraints worth validating.
 *
 * An empty schema (`{}` or `{"type": "object"}` with no properties/required)
 * imposes no constraints, so we skip compilation.
 */
function hasConstraints(schema: Record<string, unknown>): boolean {
  const keys = Object.keys(schema);
  if (keys.length === 0) return false;
  if (keys.length === 1 && keys[0] === "type") return false;
  return true;
}

/**
 * Format ajv errors into a human-readable (and LLM-readable) message.
 *
 * Each error line follows the pattern:
 *   - /fieldName: <message>
 *   - /: <message>  (root-level errors)
 */
function formatErrors(errors: ErrorObject[]): string {
  const lines = errors.map((err) => {
    const path = err.instancePath || "/";
    return `  - ${path}: ${err.message}`;
  });
  return lines.join("\n");
}

/**
 * Validate tool arguments against the tool's JSON Schema.
 *
 * @param toolName   — The tool's name (for error messages).
 * @param parameters — The tool's JSON Schema definition (`Tool.parameters`).
 * @param args       — The parsed arguments from the LLM.
 *
 * @returns `null` when validation passes (no error), or a {@link ToolResult}
 *          with `VALIDATION_ERROR` when the arguments are invalid.
 */
export function validateToolArgs(
  toolName: string,
  parameters: Record<string, unknown>,
  args: Record<string, unknown>,
): ToolResult | null {
  // ── Guard: nothing to validate ────────────────────────────────────────
  if (!hasConstraints(parameters)) {
    return null;
  }

  // ── Compile (or fetch cached) validator ───────────────────────────────
  const key = cacheKey(toolName, parameters);
  let validate: ReturnType<typeof ajv.compile>;

  if (validatorCache.has(key)) {
    validate = validatorCache.get(key)!;
  } else {
    try {
      validate = ajv.compile(parameters);
      validatorCache.set(key, validate);
    } catch (compileErr: unknown) {
      // Schema itself is malformed — log and skip validation for this tool.
      // The LLM will still get error feedback from the actual tool call.
      const msg = compileErr instanceof Error ? compileErr.message : String(compileErr);
      console.warn(
        `[tool-validator] Failed to compile schema for tool "${toolName}": ${msg}`,
      );
      return null;
    }
  }

  // ── Validate ──────────────────────────────────────────────────────────
  const valid = validate(args);

  if (valid) {
    return null; // all good
  }

  // ── Build structured error for the LLM ────────────────────────────────
  const errors = validate.errors ?? [];
  const errorList = formatErrors(errors);
  const requiredFields =
    parameters.required && Array.isArray(parameters.required)
      ? (parameters.required as string[]).join('", "')
      : "";

  let content = `[RETRYABLE:VALIDATION_ERROR] Tool "${toolName}" was called with invalid arguments.\n\n`;
  content += `Validation errors:\n${errorList}\n`;

  if (requiredFields) {
    content += `\nRequired fields: "${requiredFields}"\n`;
  }

  content += `\nReceived arguments: ${JSON.stringify(args, null, 2)}\n\n`;
  content += `Please correct the arguments and re-invoke the tool with valid parameters.`;

  return toolError(ToolErrorCode.VALIDATION_ERROR, content, "retryable");
}
