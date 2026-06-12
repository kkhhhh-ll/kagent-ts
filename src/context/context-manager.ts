import { MessageData, Role } from "../messages/types";
import { ContextConfig, ContextState } from "./types";
import { countTokens } from "../utils/token-counter";
import { ProgressiveCompressor } from "../compression/progressive-compressor";
import { LLMProvider } from "../llm/interface";

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

  constructor(config?: Partial<ContextConfig>) {
    this.config = {
      maxTokens: config?.maxTokens ?? 128000,
      compressionThreshold: config?.compressionThreshold ?? 20000,
      keepTurns: config?.keepTurns ?? 40,
      summaryKeepTurns: config?.summaryKeepTurns ?? 10,
      toolResultMaxAgeMs: config?.toolResultMaxAgeMs ?? 60 * 60 * 1000,
      compression: config?.compression,
    };
    this.compressor = new ProgressiveCompressor(this.config);
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
    return this.getCurrentTokens(model) >= this.config.maxTokens - this.config.compressionThreshold;
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
  async compress(llm?: LLMProvider): Promise<{ removedCount: number }> {
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
    return { removedCount: result.removedCount };
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
    console.log(
      `[Context] Compression triggered: ${beforeTokens} tokens, ` +
      `threshold at ${this.config.maxTokens - this.config.compressionThreshold}.`,
    );

    const { removedCount } = await this.compress(llm);

    const afterTokens = this.getCurrentTokens(model);
    console.log(
      `[Context] Compression done: ${beforeTokens} → ${afterTokens} tokens ` +
      `(${removedCount > 0 ? `removed ~${removedCount} messages` : "no messages removed"}).`,
    );

    return removedCount > 0;
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
