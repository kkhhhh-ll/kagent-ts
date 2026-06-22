import * as fs from "fs";
import * as path from "path";
import { MessageData, Role } from "../messages/types";
import { countTokens } from "../utils/token-counter";
import { LLMProvider } from "../llm/interface";
import { Logger, ConsoleLogger } from "../logging/logger";

// ─── Configuration ──────────────────────────────────────────────────────────

const TOOL_TOTAL_BYTE_LIMIT = 200 * 1024;  // Step 1: 200 KB
const KEEP_BYTES = 2048;                    // Step 1: keep 2 KB
const TRUNCATED_DIR = ".kagent-context";    // Step 1: save full output here

/** Tools whose results are "read-type" — can be re-run to get the same data. */
const READ_TOOLS = new Set([
  "read_file",
  "grep_search",
  "glob_search",
]);

interface CompressionConfig {
  maxTokens: number;
  compressionThreshold: number;
  keepTurns: number;
  toolResultMaxAgeMs: number;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Progressive 4-step compression.
 *
 * Each step is applied in order. After each step the token count is
 * re-checked; if the context now fits comfortably, later steps are skipped.
 */
export class ProgressiveCompressor {
  private config: CompressionConfig;
  private logger: Logger;

  constructor(config: CompressionConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? new ConsoleLogger();
  }

  /**
   * Run progressive compression.
   *
   * @param messages       The full message list (without system message).
   * @param systemMessage  The system message (preserved).
   * @param llm            Optional LLM provider for Step 4 summarization.
   *                       If omitted, Step 4 is skipped.
   * @returns Compressed message list + removal count.
   */
  async compress(
    messages: MessageData[],
    systemMessage: MessageData | null,
    llm?: LLMProvider,
    model?: string,
  ): Promise<{ messages: MessageData[]; removedCount: number; applied: boolean }> {
    const originalCount = messages.length;
    let result = messages;
    let applied = false;
    const t = this.config.compressionThreshold;
    const triggerToken = t < 1
      ? Math.round(this.config.maxTokens * (1 - t))
      : this.config.maxTokens - t;

    // ── Step 1: Truncate large tool results ────────────────────────────
    const after1 = this.step1TruncateToolResults(result);
    if (after1 !== result) { applied = true; result = after1; }
    if (this.tokenCount(result, systemMessage, model) < triggerToken) {
      return this.finalize(result, originalCount, applied);
    }

    // ── Step 2: Drop old turns beyond keepTurns ────────────────────────
    const turnStartsForStep2 = computeTurnStarts(result);
    const after2 = this.step2DropOldTurns(result, turnStartsForStep2);
    if (after2 !== result) { applied = true; result = after2; }
    if (this.tokenCount(result, systemMessage, model) < triggerToken) {
      return this.finalize(result, originalCount, applied);
    }

    // ── Step 3: Drop stale tool results ────────────────────────────────
    const after3 = this.step3DropStaleToolResults(result);
    if (after3 !== result) { applied = true; result = after3; }
    if (this.tokenCount(result, systemMessage, model) < triggerToken) {
      return this.finalize(result, originalCount, applied);
    }

    // ── Step 4: LLM summarization ──────────────────────────────────────
    if (llm) {
      try {
        const turnStartsForStep4 = computeTurnStarts(result);
        const after4 = await this.step4LlmSummarize(result, systemMessage, llm, turnStartsForStep4);
        if (after4 !== result) { applied = true; result = after4; }
      } catch (err: unknown) {
        this.logger.warn(
          "Compression",
          `Step 4 (LLM summarization) failed: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Falling back to truncation.`,
        );
      }
    }

    return this.finalize(result, originalCount, applied);
  }

  private finalize(
    messages: MessageData[],
    originalCount: number,
    applied: boolean,
  ): { messages: MessageData[]; removedCount: number; applied: boolean } {
    return {
      messages,
      removedCount: applied ? Math.max(0, originalCount - messages.length) : 0,
      applied,
    };
  }

  // ─── Token Counting ───────────────────────────────────────────────────────

  private tokenCount(messages: MessageData[], sys: MessageData | null, model?: string): number {
    let total = 0;
    if (sys) total += 3 + countTokens(sys.content, model);
    for (const m of messages) {
      total += 3 + countTokens(m.content, model);
    }
    return total;
  }

  // ─── Step 1: Truncate large tool results ──────────────────────────────────

  /**
   * If total tool-result bytes exceed 200 KB, truncate the largest
   * results (keep 2 KB + save to disk). Returns a new array if modified.
   */
  private step1TruncateToolResults(messages: MessageData[]): MessageData[] {
    // Collect tool messages with their byte sizes
    const toolIndices: Array<{ idx: number; bytes: number }> = [];
    let totalBytes = 0;

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === Role.Tool) {
        const bytes = Buffer.byteLength(messages[i].content, "utf-8");
        totalBytes += bytes;
        toolIndices.push({ idx: i, bytes });
      }
    }

    if (totalBytes <= TOOL_TOTAL_BYTE_LIMIT) return messages;

    // Sort largest first, truncate until under limit
    toolIndices.sort((a, b) => b.bytes - a.bytes);

    const result = [...messages];
    let excess = totalBytes - TOOL_TOTAL_BYTE_LIMIT;
    fs.mkdirSync(TRUNCATED_DIR, { recursive: true });

    for (const { idx, bytes } of toolIndices) {
      if (excess <= 0) break;

      // Keep KEEP_BYTES, save rest to file
      const content = result[idx].content;
      const truncatedBytes = bytes - KEEP_BYTES;
      if (truncatedBytes <= 0) continue;

      const now = Date.now();
      const hash = simpleHash(content.slice(0, 128) + now);
      const name = result[idx].name ?? "unknown_tool";
      const filename = `ctx_trunc_${sanitize(name)}_${now}_${hash}.txt`;
      const filePath = path.join(TRUNCATED_DIR, filename);

      fs.writeFileSync(filePath, content, "utf-8");

      result[idx] = {
        ...result[idx],
        content:
          content.slice(0, KEEP_BYTES) +
          `\n\n---\n[Context truncated: ${(bytes / 1024).toFixed(1)} KB → ${(KEEP_BYTES / 1024).toFixed(1)} KB. ` +
          `Full output saved to: ${filePath}]`,
      };

      excess -= truncatedBytes;
    }

    return result;
  }

  // ─── Step 2: Drop old turns ───────────────────────────────────────────────

  /**
   * Remove messages older than `keepTurns` conversation turns.
   * A "turn" is a user message + all subsequent assistant/tool messages
   * until the next user message.
   */
  private step2DropOldTurns(messages: MessageData[], turnStarts: number[]): MessageData[] {
    if (turnStarts.length <= this.config.keepTurns) return messages;

    const cutoffIdx = turnStarts[turnStarts.length - this.config.keepTurns];
    if (cutoffIdx <= 0) return messages;

    const dropped = turnStarts.length - this.config.keepTurns;
    const marker: MessageData = {
      role: Role.User,
      content: `[Earlier conversation (${dropped} turn(s)) removed to save context space.]`,
      timestamp: Date.now(),
    };

    return [marker, ...messages.slice(cutoffIdx)];
  }

  // ─── Step 3: Drop stale tool results ──────────────────────────────────────

  /**
   * Remove tool results older than `toolResultMaxAgeMs` for read-type
   * tools (results that can be reproduced by re-running the tool).
   * Sub-agent results (`<subagent-result>`) are preserved.
   */
  private step3DropStaleToolResults(messages: MessageData[]): MessageData[] {
    const now = Date.now();
    const maxAge = this.config.toolResultMaxAgeMs;
    let changed = false;
    const result = messages.map((m) => {
      if (m.role !== Role.Tool) return m;
      if (!m.timestamp) return m;

      // Only target read-type tools (results that can be reproduced by re-running)
      if (!READ_TOOLS.has(m.name ?? "")) return m;

      // Preserve sub-agent results (injected as user messages, but guard anyway)
      if (m.content.includes("<subagent-result")) return m;

      const age = now - m.timestamp;
      if (age < maxAge) return m;

      changed = true;
      return {
        ...m,
        content: `[Tool "${m.name ?? "unknown"}" result (${Math.round(age / 60000)} min ago) removed. ` +
          `Re-run the tool if this information is still needed.]`,
      };
    });

    return changed ? result : messages;
  }

  // ─── Step 4: LLM full-conversation summarization ────────────────────────

  /**
   * Generate a structured summary of ALL messages via the LLM.
   *
   * The entire conversation (from the first user message onward) is
   * compressed into a single summary. No recent turns are kept verbatim —
   * the summary is the sole source of history after compression.
   *
   * A continuity hint is appended so the LLM knows it is resuming, not
   * starting from scratch.
   */
  private async step4LlmSummarize(
    messages: MessageData[],
    _systemMessage: MessageData | null,
    llm: LLMProvider,
    _turnStarts: number[],
  ): Promise<MessageData[]> {
    const prompt = buildSummaryPrompt(messages);

    try {
      const response = await llm.chat(
        [{ role: Role.User, content: prompt }],
        [], // no tools for summarization
      );

      const summary: MessageData = {
        role: Role.User,
        content:
          `[Context Summary — conversation compressed to save space]\n\n` +
          response.content,
        timestamp: Date.now(),
      };

      const hint: MessageData = {
        role: Role.User,
        content:
          "[System] The conversation above has been compressed into a summary. " +
          "You are NOT starting from scratch — continue your work from where you left off. " +
          "Use the summary above to understand what happened before and pick up right where you were.",
        timestamp: Date.now(),
      };

      return [summary, hint];
    } catch {
      // If summarization fails, fall back to simple truncation with a marker
      this.logger.warn("Compression", "Step 4 LLM call failed; falling back to simple truncation.");
      const marker: MessageData = {
        role: Role.User,
        content:
          `[Context compressed — LLM summarization was unavailable. ` +
          `Some earlier context may be missing. Continue to the best of your ability.]`,
        timestamp: Date.now(),
      };
      return [marker];
    }
  }
}

// ─── Summary Prompt Builder ─────────────────────────────────────────────────

const MAX_CHARS_PER_MESSAGE = 3000;

function buildSummaryPrompt(messages: MessageData[]): string {
  const transcriptLines = messages.map((m) => {
    const roleLabel = m.role.toUpperCase();
    let content = m.content;
    if (content.length > MAX_CHARS_PER_MESSAGE) {
      content = content.slice(0, MAX_CHARS_PER_MESSAGE) + "\n... [truncated for summarization]";
    }
    return `[${roleLabel}]${m.name ? ` (${m.name})` : ""}\n${content}`;
  });

  const transcript = transcriptLines.join("\n\n---\n\n");

  return [
    "You are a context compression assistant. Read the following conversation transcript ",
    "and generate a structured summary document. The summary MUST include ALL of these ",
    "sections (use them as headings, do not skip any):",
    "",
    "## 1. Primary Request and Intent",
    "Every request the user made and their intent/goal.",
    "",
    "## 2. Key Technical Concepts",
    "Technologies, libraries, patterns, and concepts discussed or used.",
    "",
    "## 3. Files and Code Sections",
    "Every file path mentioned or edited, with relevant code snippets where available.",
    "",
    "## 4. Errors and Fixes",
    "Every error encountered and how it was resolved (or if still unresolved).",
    "",
    "## 5. Problem Solving",
    "Chronological walkthrough of how problems were approached and resolved.",
    "",
    "## 6. ALL User Messages",
    "Copy every single user message verbatim. Do NOT summarize, omit, or paraphrase any.",
    "",
    "## 7. Pending Tasks",
    "Tasks that were requested but not yet started or completed.",
    "",
    "## 8. Current Work",
    "What was being worked on right before this compression happened — ",
    "the exact state and context of the ongoing task.",
    "",
    "## 9. Optional Next Step",
    "If you can infer the logical next action, suggest it briefly. " +
    "Otherwise say 'Continue from where you left off.'",
    "",
    "---",
    "",
    "=== CONVERSATION TRANSCRIPT ===",
    "",
    transcript,
    "",
    "=== END ===",
    "",
    "Now generate the structured summary document.",
  ].join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeTurnStarts(messages: MessageData[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === Role.User) {
      starts.push(i);
    }
  }
  return starts;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
