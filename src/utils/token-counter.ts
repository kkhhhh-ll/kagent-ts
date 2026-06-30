/**
 * Token counting utility.
 *
 * Uses the `tiktoken` package for accurate tokenization when available.
 * Falls back to a simple character-based heuristic (~4 chars/token) on failure.
 *
 * The tiktoken module is loaded lazily and cached after the first successful check.
 */

let _tiktoken: any = null;
let _tiktokenChecked = false;

/**
 * Try to load the tiktoken module (once, cached).
 */
function getTiktokenModule(): any {
  if (!_tiktokenChecked) {
    _tiktokenChecked = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _tiktoken = require("tiktoken");
    } catch {
      // tiktoken not available — fallback will be used
      _tiktoken = null;
    }
  }
  return _tiktoken;
}

/**
 * Encode text via tiktoken and return the token count.
 * Falls back to heuristic if anything goes wrong.
 */
function countWithTiktoken(text: string, model?: string): number {
  const tk = getTiktokenModule();
  if (!tk) throw new Error("tiktoken not loaded");

  let enc: any;

  // When a model name is provided, try `encoding_for_model` first
  if (model) {
    try {
      enc = tk.encoding_for_model(model);
    } catch {
      // Unknown model name — fall through to generic encoding below
      enc = null;
    }
    if (enc) {
      try {
        return enc.encode(text).length;
      } finally {
        enc.free();
      }
    }
  }

  // No model name or unknown model — use o200k_base (covers GPT-4o, GPT-4o-mini)
  // Fall back to cl100k_base for older models if o200k_base also fails
  try {
    enc = tk.get_encoding("o200k_base");
  } catch {
    enc = tk.get_encoding("cl100k_base");
  }

  try {
    return enc.encode(text).length;
  } finally {
    // Free the encoder to avoid memory leaks (tiktoken is wasm-backed)
    if (enc) enc.free();
  }
}

/**
 * Count tokens in a text string.
 *
 * Uses tiktoken (by model name) when available, falling back to
 * a simple ~4 characters-per-token heuristic.
 *
 * @param text  The text to count tokens in.
 * @param model The OpenAI model name for accurate encoding (e.g. "gpt-4o", "gpt-4o-mini").
 *              When omitted, uses the generic o200k_base encoding.
 */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;

  // Try tiktoken first
  if (getTiktokenModule()) {
    try {
      return countWithTiktoken(text, model);
    } catch {
      // tiktoken failed — fall through to heuristic
    }
  }

  // Heuristic fallback: ~4 characters per token (standard English approximation)
  return Math.ceil(text.length / 4);
}

/**
 * Count tokens in an array of messages.
 * For each message, adds a small overhead for the role metadata.
 *
 * @param messages Array of message-like objects.
 * @param model    Optional model name for accurate token counting.
 */
export function countMessageTokens(
  messages: { role: string; content: string }[],
  model?: string
): number {
  // Per-message format overhead (role tag, spacing, etc.)
  const PER_MESSAGE_OVERHEAD = 3;
  let total = 0;

  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    total += countTokens(msg.content, model);
  }
  return total;
}
