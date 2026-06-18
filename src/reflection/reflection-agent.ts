import { LLMProvider, LLMResponse } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { Message } from "../messages/message";
import { ErrorNotebook, ErrorNotebookEntry, ReflectionErrorCategory } from "./error-notebook";
import type { ToolErrorTrace } from "../tools/types";

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
 * Structured JSON output expected from the LLM during reflection.
 */
interface ReflectionResponse {
  analysis: string;
  score: number; // 0–100 self-rating
  findings: ReflectionFinding[];
  improvements: string[];
}

// ─── Reflection System Prompt ────────────────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `You are a reflective quality-assurance agent. Your job is to review a completed
agent session and identify mistakes, missed opportunities, and improvement suggestions.

You will receive:
1. The user's original query.
2. The agent's final answer.
3. The full conversation (user, assistant, tool calls, tool results).
4. Any tool error traces recorded during execution.

Analyze the session across these dimensions:
- **Reasoning**: Was the agent's logic sound? Any flawed deductions?
- **Tool use**: Were the right tools used with correct parameters? Any misuse?
- **Efficiency**: Could the task have been completed faster or with fewer steps?
- **Completeness**: Does the answer fully address the user's query? Any missing information?
- **Context**: Was the context window managed well? Any irrelevant noise?

Output a JSON object with this structure:
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
  ],
  "improvements": [
    "specific, actionable improvement suggestion 1",
    "specific, actionable improvement suggestion 2"
  ]
}

Rules:
- Score 0-100 where 100 = flawless execution.
- Only include findings for actual issues — do NOT fabricate problems.
- If the session was perfect, return an empty findings array and score 100.
- Group related findings; don't duplicate.
- Be specific: cite exact tool names, file paths, reasoning steps where applicable.`;

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
   * Maximum reflection iterations (default: 3).
   * Each iteration refines the previous analysis.
   */
  maxIterations?: number;
}

/**
 * ReflectionAgent — post-execution self-reflection with a limited iteration loop.
 *
 * After the main agent finishes, the ReflectionAgent reviews the full session
 * trace and identifies mistakes or missed opportunities. Findings are persisted
 * to an ErrorNotebook (错题本) for future learning.
 *
 * The agent runs a loop of self-reflection followed by refinement. In each
 * iteration it:
 * 1. Asks the LLM to analyze the session and rate itself (0-100).
 * 2. Extracts structured findings.
 * 3. Feeds previous findings back for a second pass (refinement).
 *
 * After all iterations, findings are written to the ErrorNotebook.
 *
 * Usage:
 * ```ts
 * const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });
 * const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });
 * const findings = await reflector.reflect({
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

  constructor(config: ReflectionAgentConfig) {
    this.llm = config.llm;
    this.notebook = config.notebook;
    this.maxIterations = config.maxIterations ?? 3;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Run the reflection loop and persist findings.
   *
   * @returns The final list of findings written to the notebook.
   */
  async reflect(input: ReflectionInput): Promise<ErrorNotebookEntry[]> {
    const allFindings: ReflectionFinding[] = [];
    let lastResponse: ReflectionResponse | null = null;

    // ── Iterative refinement loop ──────────────────────────────────────
    for (let i = 0; i < this.maxIterations; i++) {
      const isFirstPass = i === 0;
      const messages = this.buildReflectionMessages(input, allFindings, lastResponse, isFirstPass);

      const response = await this.llm.chat(messages);
      const parsed = this.parseReflectionResponse(response);

      if (!parsed) {
        // Couldn't parse — skip this iteration
        continue;
      }

      lastResponse = parsed;

      // Merge findings (deduplicate by description)
      for (const f of parsed.findings) {
        const isDuplicate = allFindings.some(
          (existing) =>
            existing.category === f.category &&
            existing.description.toLowerCase() === f.description.toLowerCase(),
        );
        if (!isDuplicate) {
          allFindings.push(f);
        }
      }

      // Early exit: if score is high (95+) and no new findings, we're done
      if (parsed.score >= 95 && parsed.findings.length === 0) {
        break;
      }
    }

    // ── Persist to ErrorNotebook ───────────────────────────────────────
    const entries: ErrorNotebookEntry[] = [];
    for (const f of allFindings) {
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

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Build the message array for a reflection iteration.
   *
   * First pass: full session context + instructions.
   * Subsequent passes: previous findings + refinement request.
   */
  private buildReflectionMessages(
    input: ReflectionInput,
    previousFindings: ReflectionFinding[],
    lastResponse: ReflectionResponse | null,
    isFirstPass: boolean,
  ): MessageData[] {
    const messages: MessageData[] = [];

    // System
    messages.push({ role: Role.System, content: REFLECTION_SYSTEM_PROMPT });

    if (isFirstPass) {
      // Full session dump for first pass
      const context = [
        "=== User Query ===",
        input.userQuery,
        "",
        "=== Final Answer ===",
        input.finalAnswer,
        "",
        "=== Conversation === ",
        ...this.formatConversation(input.conversation),
        "",
        "=== Tool Error Traces ===",
        ...this.formatErrorTraces(input.errorTraces),
      ].join("\n");

      messages.push({
        role: Role.User,
        content: `Please review this agent session and identify any issues:\n\n${context}`,
      });
    } else {
      // Refinement pass: show previous findings and ask for more
      const prevSummary = [
        `Previous score: ${lastResponse?.score ?? "?"}/100`,
        `Previous analysis: ${lastResponse?.analysis ?? "N/A"}`,
        `Previous findings (${previousFindings.length}):`,
        ...previousFindings.map(
          (f) => `- [${f.category}] ${f.description} → ${f.suggestion}`,
        ),
      ].join("\n");

      messages.push({
        role: Role.User,
        content:
          `Refinement pass — re-examine the session with fresh eyes. ` +
          `Here is what you found previously:\n\n${prevSummary}\n\n` +
          `Are there any additional issues you missed? Any findings that should be ` +
          `removed (false positives)? Output the FULL updated JSON (not just deltas).`,
      });
    }

    return messages;
  }

  /**
   * Format the conversation for the reflection prompt.
   * Truncates very long tool results for readability.
   */
  private formatConversation(messages: MessageData[]): string[] {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = msg.content;

      // Truncate long tool results
      if (msg.role === Role.Tool && content.length > 1000) {
        content = content.slice(0, 500) + "\n... (truncated, " + content.length + " chars total)";
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

  /**
   * Parse the LLM's structured JSON response into a ReflectionResponse.
   * Returns null if parsing fails.
   */
  private parseReflectionResponse(
    response: LLMResponse,
  ): ReflectionResponse | null {
    try {
      // Extract JSON from the response (may be wrapped in ```json fences)
      let raw = response.content.trim();
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) raw = fenceMatch[1];

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Validate required fields
      if (typeof parsed.analysis !== "string") return null;
      if (typeof parsed.score !== "number") return null;
      if (!Array.isArray(parsed.findings)) return null;
      if (!Array.isArray(parsed.improvements)) return null;

      // Validate each finding
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
          continue; // skip invalid finding
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

      return {
        analysis: parsed.analysis,
        score: parsed.score,
        findings,
        improvements: parsed.improvements.filter(
          (i): i is string => typeof i === "string",
        ),
      };
    } catch {
      return null;
    }
  }
}
