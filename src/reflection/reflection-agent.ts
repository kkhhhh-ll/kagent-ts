import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { STRUCTURED_OUTPUT_INSTRUCTIONS } from "../core/response-schema";
import { ErrorNotebook, ErrorNotebookEntry, ReflectionErrorCategory } from "./error-notebook";
import type { ToolErrorTrace } from "../tools/types";
import { Logger, ConsoleLogger } from "../logging/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Input provided to the ReflectionAgent for analysis.
 */
export interface ReflectionInput {
  /** The original user query. */
  userQuery: string;
  /** The final answer produced by the agent. */
  finalAnswer: string;
  /** The full conversation messages (for context). */
  conversation: MessageData[];
  /** Tool error traces from the session (if any). */
  errorTraces?: ToolErrorTrace[];
  /** Session identifier for notebook entries. */
  sessionId: string;
}

/**
 * A single finding produced by the ReflectionAgent.
 */
export interface ReflectionFinding {
  /** Error category. */
  category: ReflectionErrorCategory;
  /** What went wrong. */
  description: string;
  /** Root cause. */
  cause: string;
  /** How to avoid it next time. */
  suggestion: string;
  /** Related tool trace IDs (if applicable). */
  relatedTraceIds?: string[];
}

/**
 * Structured JSON output expected from the fork sub-agent's final answer.
 */
interface ReflectionResponse {
  analysis: string;
  score: number;
  findings: ReflectionFinding[];
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const ERROR_REFLECTION_SYSTEM_PROMPT = `You are a reflective quality-assurance agent. Your job is to review a completed
agent session and identify mistakes, missed opportunities, and improvement suggestions.

You have access to read_file and grep_search tools to verify your findings against the actual codebase.

Analyze the session across these dimensions:
- **Reasoning**: Was the agent's logic sound? Any flawed deductions?
- **Tool use**: Were the right tools used with correct parameters? Any misuse?
- **Efficiency**: Could the task have been completed faster or with fewer steps?
- **Completeness**: Does the answer fully address the user's query? Any missing information?
- **Context**: Was the context window managed well? Any irrelevant noise?

In your final answer, output a JSON object with this structure:
{
  "analysis": "overall assessment (2-4 sentences)",
  "score": 85,
  "findings": [
    {
      "category": "reasoning_error | tool_misuse | missed_optimization | incomplete_answer | hallucination | context_mismanagement | other",
      "description": "concise description of what went wrong",
      "cause": "root cause — why did this happen?",
      "suggestion": "how to avoid this next time",
      "relatedTraceIds": ["trace_abc123"]
    }
  ]
}

Rules:
- Score 0-100 where 100 = flawless execution.
- Only include findings for actual issues — do NOT fabricate problems.
- If the session was perfect, return an empty findings array and score 100.
- Group related findings; don't duplicate.
- Be specific: cite exact tool names, file paths, reasoning steps where applicable.
- Use your tools to verify findings against the actual codebase before reporting them.
${STRUCTURED_OUTPUT_INSTRUCTIONS}`;

// ─── ReflectionAgent ─────────────────────────────────────────────────────────

/**
 * Configuration for the ReflectionAgent.
 */
export interface ReflectionAgentConfig {
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** ErrorNotebook for persisting findings. */
  notebook: ErrorNotebook;
  /**
   * Maximum ReAct iterations for the sub-agent (default: 4).
   */
  maxIterations?: number;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

/**
 * ReflectionAgent — post-execution self-reflection via a forked sub-agent.
 *
 * After the main agent finishes, the ReflectionAgent forks a lightweight
 * ReActAgent to review the full session trace. The fork runs in its own
 * context with read-only tools (read_file, grep_search) so it can verify
 * findings against the codebase.
 *
 * Findings are persisted to an ErrorNotebook (错题本) for future learning.
 *
 * Usage:
 * ```ts
 * const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });
 * const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 4 });
 * const entries = await reflector.reflect({
 *   userQuery: input,
 *   finalAnswer: answer,
 *   conversation: contextMessages,
 *   sessionId: "sess_123",
 * });
 * ```
 */
export class ReflectionAgent {
  private llm: LLMProvider;
  private notebook: ErrorNotebook;
  private maxIterations: number;
  private logger: Logger;

  /** Hard timeout for the entire reflection fork (5 minutes). */
  private static readonly REFLECTION_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(config: ReflectionAgentConfig) {
    this.llm = config.llm;
    this.notebook = config.notebook;
    this.maxIterations = config.maxIterations ?? 4;
    this.logger = config.logger ?? new ConsoleLogger();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to review the session and persist findings.
   *
   * @returns The final list of findings written to the notebook.
   * @throws If the reflection fork times out.
   */
  async reflect(input: ReflectionInput): Promise<ErrorNotebookEntry[]> {
    const taskPrompt = this.buildTaskPrompt(input);

    // Enforce a hard timeout so a slow/stuck LLM call can't block
    // the process indefinitely.
    const answer = await Promise.race([
      this.forkAndRun(taskPrompt),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Reflection fork timed out after ${ReflectionAgent.REFLECTION_TIMEOUT_MS / 1000}s`)),
          ReflectionAgent.REFLECTION_TIMEOUT_MS,
        ),
      ),
    ]);

    const findings = this.parseFindings(answer);

    // Deduplicate by category + description before persisting
    const seen = new Set<string>();
    const unique: ReflectionFinding[] = [];
    for (const f of findings) {
      const key = `${f.category}::${f.description.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }

    // Persist to ErrorNotebook
    const entries: ErrorNotebookEntry[] = [];
    for (const f of unique) {
      const entry = this.notebook.add({
        sessionId: input.sessionId,
        category: f.category,
        description: f.description,
        cause: f.cause,
        suggestion: f.suggestion,
        userQuery: input.userQuery,
        relatedTraceIds: f.relatedTraceIds,
      });
      entries.push(entry);
    }

    return entries;
  }

  // ─── Private: Fork ─────────────────────────────────────────────────────

  /**
   * Fork a minimal ReActAgent and run it to completion.
   * Returns the agent's final answer string.
   */
  private async forkAndRun(userPrompt: string): Promise<string> {
    const { forkAgent } = await import("../core/fork.js");
    return forkAgent(userPrompt, {
      llm: this.llm,
      systemPrompt: ERROR_REFLECTION_SYSTEM_PROMPT,
      maxIterations: this.maxIterations,
      logger: this.logger,
    });
  }

  // ─── Private: Prompt Building ──────────────────────────────────────────

  /**
   * Build the task prompt for the sub-agent from the reflection input.
   */
  private buildTaskPrompt(input: ReflectionInput): string {
    const context = [
      "Please review this agent session and identify any issues.",
      "",
      "=== User Query ===",
      input.userQuery,
      "",
      "=== Final Answer ===",
      input.finalAnswer,
      "",
      "=== Conversation ===",
      ...this.formatConversation(input.conversation),
      "",
      "=== Tool Error Traces ===",
      ...this.formatErrorTraces(input.errorTraces),
      "",
      "Analyze the session and output your findings as JSON in your final answer.",
    ].join("\n");

    return context;
  }

  /**
   * Format the conversation for the reflection prompt.
   * Truncates very long tool results for readability.
   */
  private formatConversation(messages: MessageData[]): string[] {
    /** Characters to keep from the start of a truncated tool result. */
    const TRUNCATION_RETAIN = 500;
    /** Tool result longer than this will be truncated. */
    const TRUNCATION_THRESHOLD = TRUNCATION_RETAIN * 2;

    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = msg.content;

      // Truncate long tool results
      if (msg.role === Role.Tool && content.length > TRUNCATION_THRESHOLD) {
        content = content.slice(0, TRUNCATION_RETAIN) + "\n... (truncated, " + content.length + " chars total)";
      }

      lines.push(`[${role}] ${content}`);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          lines.push(`  → tool_call: ${tc.function.name}(${tc.function.arguments})`);
        }
      }
    }
    return lines;
  }

  /**
   * Format error traces for the reflection prompt.
   */
  private formatErrorTraces(traces?: ToolErrorTrace[]): string[] {
    if (!traces || traces.length === 0) return ["(no tool errors recorded)"];
    const lines: string[] = [];
    for (const t of traces) {
      lines.push(`- ${t.traceId}: ${t.toolName} — ${t.resolved ? "resolved" : "unresolved"} (${t.events.length} events)`);
    }
    return lines;
  }

  // ─── Private: Parsing ──────────────────────────────────────────────────

  /**
   * Parse the sub-agent's final answer into a list of ReflectionFindings.
   * Returns an empty array if parsing fails (best-effort — the LLM may
   * produce malformed output).
   */
  private parseFindings(answer: string): ReflectionFinding[] {
    try {
      // Extract JSON from the answer (may be wrapped in ```json fences)
      let raw = answer.trim();
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) raw = fenceMatch[1];

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (!Array.isArray(parsed.findings)) return [];

      const validCategories = new Set<string>([
        "reasoning_error", "tool_misuse", "missed_optimization",
        "incomplete_answer", "hallucination", "context_mismanagement", "other",
      ]);

      const findings: ReflectionFinding[] = [];
      for (const f of parsed.findings as Array<Record<string, unknown>>) {
        if (
          typeof f.category !== "string" ||
          !validCategories.has(f.category) ||
          typeof f.description !== "string" ||
          typeof f.cause !== "string" ||
          typeof f.suggestion !== "string"
        ) {
          this.logger.warn(
            "ReflectionAgent",
            `Skipping malformed reflection finding: missing or invalid required field (category, description, cause, suggestion). Got: ${JSON.stringify({ category: f.category, description: f.description, cause: f.cause, suggestion: f.suggestion })}`,
          );
          continue;
        }
        findings.push({
          category: f.category as ReflectionErrorCategory,
          description: f.description,
          cause: f.cause,
          suggestion: f.suggestion,
          relatedTraceIds: Array.isArray(f.relatedTraceIds)
            ? f.relatedTraceIds.filter((id): id is string => typeof id === "string")
            : undefined,
        });
      }

      return findings;
    } catch (err: unknown) {
      this.logger.error(
        "ReflectionAgent",
        `Failed to parse reflection findings from LLM output: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
