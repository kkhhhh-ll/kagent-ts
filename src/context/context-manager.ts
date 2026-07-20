import { MessageData, Role } from "../messages/types";
import { ContextConfig, ContextState } from "./types";
import { countTokens } from "../utils/token-counter";
import { ProgressiveCompressor } from "../compression/progressive-compressor";
import { LLMProvider } from "../llm/interface";
import { Logger, ConsoleLogger } from "../logging/logger";

/**
 * ContextManager maintains the message window that will be sent to the LLM.
 *
 * Responsibilities:
 * - Accept new messages with automatic timestamps.
 * - Detect when the token threshold is crossed and trigger compression.
 * - Run progressive 4-step compression with optional LLM summarization.
 * - Provide the current message list to the caller (e.g., Agent).
 */
export class ContextManager {
  private config: ContextConfig;
  private messages: MessageData[] = [];
  private systemMessage: MessageData | null = null;
  private _isCompressed = false;
  private compressor: ProgressiveCompressor;
  private logger: Logger;

  constructor(config?: Partial<ContextConfig>, logger?: Logger) {
    this.config = {
      maxTokens: config?.maxTokens ?? 128000,
      compressionThreshold: config?.compressionThreshold ?? 20000,
      keepTurns: config?.keepTurns ?? 40,
      toolResultMaxAgeMs: config?.toolResultMaxAgeMs ?? 60 * 60 * 1000,
      summaryKeepTurns: config?.summaryKeepTurns ?? 10,
      compression: config?.compression,
    };

    // Validate threshold
    if (this.config.compressionThreshold <= 0) {
      throw new Error(
        `compressionThreshold must be > 0. Got ${this.config.compressionThreshold}.`
      );
    }
    if (this.config.compressionThreshold < 1 && this.config.compressionThreshold > 0.25) {
      throw new Error(
        `compressionThreshold ratio must be ≤ 0.25 (trigger at ≥ 75% of context). ` +
        `Got ${this.config.compressionThreshold} (trigger at ${Math.round((1 - this.config.compressionThreshold) * 100)}%).`
      );
    }

    this.logger = logger ?? new ConsoleLogger();
    this.compressor = new ProgressiveCompressor(this.config, this.logger);
  }

  /**
   * Compute the trigger token count based on the compressionThreshold mode.
   * Absolute: maxTokens - threshold
   * Ratio:    maxTokens * (1 - threshold)
   */
  private triggerTokens(): number {
    const t = this.config.compressionThreshold;
    return t < 1
      ? Math.round(this.config.maxTokens * (1 - t))
      : this.config.maxTokens - t;
  }

  /**
   * Set or update the system message (always preserved in the window).
   */
  setSystemMessage(content: string): void {
    this.systemMessage = { role: Role.System, content };
  }

  /**
   * Add a message to the context window. Timestamps are auto-set if not
   * already present.
   */
  addMessage(message: MessageData): void {
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }
    this.messages.push(message);
  }

  /**
   * Check whether compression should trigger.
   * @param model Optional model name for accurate tiktoken encoding.
   * @returns true when remaining free tokens < compressionThreshold.
   */
  shouldCompress(model?: string): boolean {
    // Short-circuit: too few messages to ever hit the compression threshold.
    // The system message + a handful of conversation turns won't breach
    // typical thresholds (64K+). Avoids unnecessary tiktoken calls.
    const totalMsgs = (this.systemMessage ? 1 : 0) + this.messages.length;
    if (totalMsgs < 20) return false;
    return this.getCurrentTokens(model) >= this.triggerTokens();
  }

  /**
   * Token count of all messages in the window.
   * @param model Optional model name for accurate tiktoken encoding.
   */
  getCurrentTokens(model?: string): number {
    let total = 0;
    if (this.systemMessage) {
      total += 3 + countTokens(this.systemMessage.content, model);
    }
    for (const msg of this.messages) {
      total += 3 + countTokens(msg.content, model);
    }
    return total;
  }

  /**
   * Run progressive 4-step compression.
   *
   * @param llm Optional LLM provider for Step 4 (summarization).
   *            If omitted, only steps 1-3 are applied.
   */
  async compress(llm?: LLMProvider): Promise<{ tokensSaved: number }> {
    const model = llm?.model;
    const result = await this.compressor.compress(
      this.messages,
      this.systemMessage,
      llm,
      model,
    );
    this.messages = result.messages;
    if (result.applied) {
      this._isCompressed = true;
    }
    return { tokensSaved: result.tokensSaved };
  }

  /**
   * Convenience: check + compress if needed.
   *
   * @param llm LLM provider for Step 4 summarization and accurate token counting.
   * @returns true if compression was applied.
   */
  async checkAndCompress(llm?: LLMProvider): Promise<boolean> {
    const model = llm?.model;
    if (!this.shouldCompress(model)) return false;

    const beforeTokens = this.getCurrentTokens(model);
    this.logger.info(
      "Context",
      `Compression triggered: ${beforeTokens} tokens, ` +
      `threshold at ${this.triggerTokens()}.`,
    );

    const { tokensSaved } = await this.compress(llm);

    const afterTokens = this.getCurrentTokens(model);
    this.logger.info(
      "Context",
      `Compression done: ${beforeTokens} → ${afterTokens} tokens ` +
      `(${tokensSaved > 0 ? `saved ~${tokensSaved} tokens` : "no tokens saved"}).`,
    );

    return tokensSaved > 0;
  }

  /**
   * Get the current context messages (ready to send to the LLM).
   * Includes the system message as the first element if set.
   */
  getContextMessages(): MessageData[] {
    if (this.systemMessage) {
      return [this.systemMessage, ...this.messages];
    }
    return [...this.messages];
  }

  /**
   * Get the raw messages (without system message prepended).
   */
  getMessages(): MessageData[] {
    return [...this.messages];
  }

  /**
   * Check if compression has been applied.
   */
  get isCompressed(): boolean {
    return this._isCompressed;
  }

  /**
   * Get the current state of the context window.
   */
  getState(): ContextState {
    return {
      currentTokens: this.getCurrentTokens(),
      messageCount: this.messages.length,
      isCompressed: this._isCompressed,
      maxTokens: this.config.maxTokens,
    };
  }

  /**
   * Clear all messages from the window (preserves system message).
   */
  clear(): void {
    this.messages = [];
    this._isCompressed = false;
  }
}
