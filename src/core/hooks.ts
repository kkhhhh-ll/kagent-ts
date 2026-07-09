import { LLMResponse } from "../llm/interface";
import { LLMNetworkError } from "../llm/errors";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";

/**
 * Lifecycle hooks for agent execution.
 *
 * Each hook is called at a specific point in the agent loop, enabling
 * consumers to add logging, tracing, metrics, or UI updates without
 * subclassing the agent.
 *
 * All hooks are optional — only the ones you provide are called.
 */
export interface AgentHooks {
  /**
   * Whether this hook is safe to pass to sub-agents.
   *
   * When `false`, the hook is automatically excluded from sub-agent hook
   * lists to prevent unbounded recursion. Set to `false` for hooks that
   * spawn their own sub-agents (e.g. {@link ReflectionHook}).
   *
   * Default (`undefined`) is treated as safe — the hook is a pure observer
   * (logging, tracing, metrics) and can safely run in sub-agents.
   */
  safeForSubAgent?: boolean;

  // ─── LLM Lifecycle ───────────────────────────────────────────────────

  /**
   * Called before each LLM chat() call.
   * @param messages The full context messages being sent to the LLM.
   * @param tools    The tools available to the LLM for this call.
   */
  onLLMStart?: (messages: MessageData[], tools: Tool[]) => void;

  /** Called after a successful LLM response. */
  onLLMEnd?: (response: LLMResponse) => void;

  /** Called when a network error exhausts all retries. */
  onLLMError?: (error: LLMNetworkError) => void;

  // ─── Tool Lifecycle ──────────────────────────────────────────────────

  /**
   * Called before a tool begins execution.
   * @param toolCallId The unique ID assigned by the LLM to this tool call
   *                   (from `response.tool_calls[].id`). Used for exact
   *                   matching when the same tool is called multiple times
   *                   in one batch.
   */
  onToolStart?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => void;

  /**
   * Called after a tool returns successfully.
   * @param toolCallId Matches the ID passed to `onToolStart`.
   */
  onToolEnd?: (toolName: string, result: string, toolCallId?: string) => void;

  /**
   * Called when a tool throws or returns an error string.
   * @param toolCallId Matches the ID passed to `onToolStart`.
   */
  onToolError?: (toolName: string, error: string, toolCallId?: string) => void;

  // ─── Reasoning ───────────────────────────────────────────────────────

  /** Called when the LLM produces a reasoning thought. */
  onThought?: (thought: string) => void;

  /**
   * Called for each text chunk during streaming (`agent.stream()`).
   * When set, the agent uses `chatStream()` instead of `chat()` for the
   * final answer phase, yielding incremental content to the consumer.
   */
  onChunk?: (chunk: string) => void;

  // ─── Plan & Solve (PlanSolveAgent only) ──────────────────────────────

  /** Called when an initial plan is created. */
  onPlanCreated?: (plan: string[]) => void;

  /** Called when the plan is revised mid-execution. */
  onPlanRevised?: (plan: string[]) => void;

  // ─── Final ───────────────────────────────────────────────────────────

  /** Called when a final answer is produced. */
  onFinish?: (answer: string) => void | Promise<void>;
}
