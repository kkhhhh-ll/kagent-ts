import { LLMProvider } from "./interface";
import { OpenAIProvider } from "./openai-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { RetryConfig } from "./errors";

// ─── ProviderType ────────────────────────────────────────────────────────────

/**
 * Explicit provider selection for the factory.
 * - `"openai"`: Always use OpenAI.
 * - `"anthropic"`: Always use Anthropic.
 * - `"auto"`: Detect from `baseURL` (default).
 */
export type ProviderType = "openai" | "anthropic" | "auto";

// ─── LLMProviderConfig ──────────────────────────────────────────────────────

/**
 * Unified configuration accepted by `createLLMProvider`.
 * Pass this instead of provider-specific configs (`OpenAIConfig`, `AnthropicConfig`)
 * to enable automatic provider detection.
 */
export interface LLMProviderConfig {
  /** API key for the LLM service. */
  apiKey: string;
  /** Model identifier (e.g. "gpt-4o", "claude-sonnet-4-6"). */
  model: string;
  /** Sampling temperature (default: 0.7). */
  temperature?: number;
  /**
   * Maximum output tokens.
   * Per-provider defaults: OpenAI 4096, Anthropic 8192.
   */
  maxTokens?: number;
  /**
   * Base URL for the LLM API endpoint.
   * Used to auto-detect the provider when `provider` is `"auto"`.
   * Examples:
   * - `"https://api.openai.com/v1"` → OpenAI
   * - `"https://api.anthropic.com"` → Anthropic
   * - `undefined` → defaults to OpenAI (backward compatible)
   */
  baseURL?: string;
  /** Retry configuration for network resilience. */
  retry?: RetryConfig;
  /** Request timeout in ms. */
  timeout?: number;
  /**
   * Explicitly choose the provider. When `"auto"` or omitted,
   * the factory detects the provider from `baseURL`.
   */
  provider?: ProviderType;
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Determine which provider to use.
 *
 * Detection rules:
 * 1. If `explicitProvider` is `"openai"` or `"anthropic"`, use that.
 * 2. If `"auto"` or `undefined`, inspect `baseURL`:
 *    - Contains "anthropic" (case-insensitive) → Anthropic
 *    - Otherwise → OpenAI (default / backward compatible)
 */
function detectProvider(
  explicitProvider: ProviderType | undefined,
  baseURL: string | undefined,
): "openai" | "anthropic" {
  if (explicitProvider === "openai") return "openai";
  if (explicitProvider === "anthropic") return "anthropic";

  // `"auto"` or `undefined`: detect from baseURL
  if (baseURL && /anthropic/i.test(baseURL)) {
    return "anthropic";
  }

  return "openai"; // default
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an LLM provider instance, auto-detecting the backend from `baseURL`.
 *
 * @example
 * ```ts
 * // Auto-detect: baseURL contains "anthropic" → AnthropicProvider
 * const llm = createLLMProvider({
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   model: "claude-sonnet-4-6",
 *   baseURL: "https://api.anthropic.com",
 * });
 *
 * // Explicit provider selection
 * const llm = createLLMProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "gpt-4o",
 *   provider: "openai",
 * });
 *
 * // Backward-compatible: no baseURL → OpenAI
 * const llm = createLLMProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "gpt-4o",
 * });
 * ```
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  const provider = detectProvider(config.provider, config.baseURL);

  if (provider === "anthropic") {
    return new AnthropicProvider({
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      retry: config.retry,
      timeout: config.timeout,
    });
  }

  return new OpenAIProvider({
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    baseURL: config.baseURL,
    retry: config.retry,
    timeout: config.timeout,
  });
}
