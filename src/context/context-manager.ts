import { MessageData, Role } from "../messages/types";
import { ContextConfig, ContextState } from "./types";
import { CompressionStrategy } from "../compression/interface";
import { SlidingWindowCompression } from "../compression/sliding-window";
import { countTokens } from "../utils/token-counter";

/**
 * ContextManager maintains the message window that will be sent to the LLM.
 *
 * Responsibilities:
 * - Accept new messages and update the running token count.
 * - Detect when the token threshold is crossed and trigger compression.
 * - Provide the current message list to the caller (e.g., Agent).
 */
export class ContextManager {
  private config: ContextConfig;
  private messages: MessageData[] = [];
  private systemMessage: MessageData | null = null;
  private compressionStrategy: CompressionStrategy;
  private _isCompressed = false;
  /** Optional model name for tiktoken-aware token counting. */
  private modelName?: string;

  constructor(config?: Partial<ContextConfig>) {
    this.config = {
      maxTokens: config?.maxTokens ?? 128000,
      compressionThresholdRatio: config?.compressionThresholdRatio ?? 0.75,
      compression: config?.compression,
    };
    this.compressionStrategy = new SlidingWindowCompression(
      this.config.compression
    );
  }

  /**
   * Optionally set the model name so token counting uses tiktoken's
   * model-specific encoding (e.g. "gpt-4o" → o200k_base).
   */
  setModelName(model: string): void {
    this.modelName = model;
  }

  /**
   * Set or update the system message (always preserved in the window).
   */
  setSystemMessage(content: string): void {
    this.systemMessage = { role: Role.System, content };
  }

  /**
   * Add a message to the context window.
   */
  addMessage(message: MessageData): void {
    this.messages.push(message);
  }

  /**
   * Check whether the context window has exceeded the compression threshold.
   */
  shouldCompress(): boolean {
    return this.getCurrentTokens() >= this.getCompressionThreshold();
  }

  /**
   * The token count at which compression triggers.
   */
  private getCompressionThreshold(): number {
    return Math.floor(
      this.config.maxTokens * this.config.compressionThresholdRatio
    );
  }

  /**
   * Approximate token count of all messages in the window.
   * When a model name has been set (via setModelName), uses tiktoken
   * for model-specific encoding accuracy.
   */
  getCurrentTokens(): number {
    let total = 0;
    // System message overhead
    if (this.systemMessage) {
      total += 3 + countTokens(this.systemMessage.content, this.modelName);
    }
    // Per-message overhead + content
    for (const msg of this.messages) {
      total += 3; // role overhead
      total += countTokens(msg.content, this.modelName);
    }
    return total;
  }

  /**
   * Run the compression strategy to reduce the window size.
   * Resets the message list to the compressed output.
   */
  compress(): { removedCount: number } {
    const result = this.compressionStrategy.compress(
      this.messages,
      this.systemMessage ?? undefined
    );
    this.messages = result.messages;
    this._isCompressed = result.applied;
    return { removedCount: result.removedCount };
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
