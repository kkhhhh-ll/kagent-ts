import { LLMResponse } from "../llm/interface";
import { LLMNetworkError } from "../llm/openai-provider";
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

  /** Called before a tool begins execution. */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;

  /** Called after a tool returns successfully. */
  onToolEnd?: (toolName: string, result: string) => void;

  /** Called when a tool throws or returns an error string. */
  onToolError?: (toolName: string, error: string) => void;

  // ─── Reasoning ───────────────────────────────────────────────────────

  /** Called when the LLM produces a reasoning thought. */
  onThought?: (thought: string) => void;

  // ─── Plan & Solve (PlanSolveAgent only) ──────────────────────────────

  /** Called when an initial plan is created. */
  onPlanCreated?: (plan: string[]) => void;

  /** Called when the plan is revised mid-execution. */
  onPlanRevised?: (plan: string[]) => void;

  // ─── Final ───────────────────────────────────────────────────────────

  /** Called when a final answer is produced. */
  onFinish?: (answer: string) => void;
}
