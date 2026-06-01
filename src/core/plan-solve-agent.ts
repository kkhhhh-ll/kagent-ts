import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import {
  parsePlanSolveResponse,
  PLAN_SOLVE_INSTRUCTIONS,
} from "./response-schema";
import { LLMNetworkError } from "../llm/openai-provider";
import { LLMResponse } from "../llm/interface";
import { SessionState, SessionStatus } from "../session/session-types";
import { PreferenceManager } from "../preferences/preference-manager";

/**
 * Default system prompt for the Plan-and-Solve paradigm.
 *
 * The LLM is instructed to separate planning from execution:
 * 1. Phase 1 — PLAN:   Analyze and create a detailed numbered plan.
 * 2. Phase 2 — RESOLVE: Work through each step, using tools as needed.
 *    The plan can be revised mid-execution when new information emerges.
 * 3. FINAL: When all steps are complete, output the full answer.
 */
const DEFAULT_PLAN_SOLVE_SYSTEM_PROMPT = `You are a helpful AI assistant powered by the Plan-and-Resolve paradigm.
You have access to a set of tools you can use to answer the user's question.

Process:
1. First, analyze the user's request and create a detailed plan.
2. Then, work through each step of the plan using tools as needed.
3. If you encounter unexpected information or tool failures, revise the remaining steps.
4. When all steps are complete, provide the final answer.

If no tools are needed, respond with the final answer directly.

=== Tool Error Recovery ===
When a tool returns an error:
1. READ the error message carefully — understand WHY it failed.
2. ANALYZE whether the parameters were correct. Common issues:
   - Wrong file path (check spelling, use absolute paths)
   - Missing or incorrect arguments
   - The tool may need different input formats
3. RETRY with corrected parameters if you can fix the issue.
4. If the same tool fails repeatedly, try a COMPLETELY DIFFERENT approach.
5. If a tool fails 2+ times in a row, consider whether your PLAN needs revision.
   The approach may be fundamentally wrong — output a "revised_plan".
6. If a tool is disabled after too many failures, DO NOT try to use it again.
   Find another way to accomplish the task.${PLAN_SOLVE_INSTRUCTIONS}`;

/**
 * Configuration specific to the Plan-and-Solve Agent.
 */
export interface PlanSolveAgentConfig extends AgentConfig {
  /** Maximum iterations for the Plan-Solve loop (default: 15). */
  maxIterations?: number;

  /** Maximum number of steps in a plan (default: 12). */
  maxPlanSteps?: number;

  /**
   * Enable progressive skill disclosure.
   * When true, skills are auto-detected from user input and loaded
   * into the system prompt on demand (default: true).
   */
  enableSkillAutoDetect?: boolean;

  /**
   * Number of consecutive tool failures before a "replan hint" is injected
   * into the system prompt, nudging the LLM to consider revising its plan.
   * Set to 0 to disable auto-replan triggering (default: 2).
   */
  replanThreshold?: number;
}

/**
 * Plan-and-Solve Agent implementing a structured Plan → Resolve → Final Answer loop.
 *
 * This paradigm separates high-level planning from step-by-step execution:
 * - **Phase 1 (Plan):**  The LLM analyzes the request and creates a numbered plan.
 * - **Phase 2 (Resolve):** The LLM executes each step, using tools. The plan is
 *   injected into the system prompt to keep the LLM focused. If obstacles arise,
 *   the LLM can output a `revised_plan` to adjust remaining steps.
 * - **Final:** When all steps are complete, the LLM provides the final answer.
 *
 * Compared to ReAct, Plan-and-Solve encourages more deliberate decomposition
 * up front, reducing the chance of the agent getting lost mid-task.
 *
 * Session persistence:
 * When `enableCheckpointing` is set, the agent auto-saves checkpoints that
 * include full plan state (current plan, completed steps, replan info) so the
 * session can be resumed after a network interruption.
 */
export class PlanSolveAgent extends Agent {
  private maxIterations: number;
  private maxPlanSteps: number;
  private enableSkillAutoDetect: boolean;

  /** The current plan steps (empty until the plan is created). */
  private currentPlan: string[] = [];

  /** Whether a plan has been created in this run. */
  private hasPlan = false;

  /**
   * How many consecutive tool failures before a replan hint is injected.
   * 0 = disabled (no auto-replanning hints).
   */
  private replanThreshold: number;

  /** Consecutive tool failures in the current run (resets on success). */
  private consecutiveFailures = 0;

  /** How many plan steps have been completed (used for plan display). */
  private completedSteps = 0;

  /** Internal flag: when true, run() skips plan state reset (used by resume()). */
  private _skipPlanReset = false;

  constructor(config: PlanSolveAgentConfig) {
    // Set default Plan-Solve system prompt if none provided
    const mergedConfig: PlanSolveAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_PLAN_SOLVE_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxIterations = config.maxIterations ?? 15;
    this.maxPlanSteps = config.maxPlanSteps ?? 12;
    this.enableSkillAutoDetect = config.enableSkillAutoDetect ?? true;
    this.replanThreshold = config.replanThreshold ?? 2;

    // If skills are registered, rebuild the system prompt so the
    // available-skills hint is included in the initial prompt.
    if (this.skillManager.activeCount > 0) {
      this.rebuildSystemPrompt();
    }
  }

  async run(input: string): Promise<string> {
    // ── Phase 0: Progressive disclosure ──────────────────────────────
    if (this.enableSkillAutoDetect && this.skillManager.count > 0) {
      const activated = this.skillManager.detectAndActivate(input);
      if (activated.length > 0) {
        this.rebuildSystemPrompt();
        console.log(`[Skills] Auto-activated: ${activated.join(", ")}`);
      }
    }

    // ── Create user message ─────────────────────────────────────────
    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    // Reset plan state for this run (skip when resuming a session)
    if (!this._skipPlanReset) {
      this.currentPlan = [];
      this.hasPlan = false;
      this.consecutiveFailures = 0;
      this.completedSteps = 0;
    }
    this._skipPlanReset = false;

    // Save initial checkpoint (captures user input before any LLM call)
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // Track consecutive unproductive iterations (no tool calls, no answer)
    let consecutiveEmptyIterations = 0;
    const EMPTY_ITERATION_LIMIT = 5;

    // ── Main Plan-Solve loop ────────────────────────────────────────
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Check if user cancelled (SIGINT)
      if (this.isCancelled) {
        this.sessionManager?.deleteSession(
          this.sessionManager.getSessionId(),
        );
        return "Execution cancelled by user. Session discarded.";
      }

      this.checkAndCompress();

      // Rebuild the system prompt to inject current plan progress
      // and any replan hint if consecutive failures are detected
      const replanHint = this.computeReplanHint();
      this.rebuildContextWithPlan(replanHint);

      const contextMessages = this.contextManager.getContextMessages();

      // Call the LLM — with network error handling
      this.hooks.onLLMStart?.();
      let response: LLMResponse;
      try {
        response = await this.llm.chat(
          contextMessages,
          this.toolRegistry.getTools(),
        );
      } catch (err: unknown) {
        if (err instanceof LLMNetworkError) {
          this.hooks.onLLMError?.(err);
          return this.handleNetworkError(err, iteration + 1);
        }
        throw err;
      }
      this.hooks.onLLMEnd?.(response);

      const parsed = parsePlanSolveResponse(response.content);

      // Create assistant message from the response
      const assistantMessage = Message.assistant(
        response.content,
        response.tool_calls,
      );

      this.contextManager.addMessage(assistantMessage.toDict());

      // ── Handle tool calls (execution phase) ─────────────────────
      if (response.tool_calls && response.tool_calls.length > 0) {
        consecutiveEmptyIterations = 0;

        if (parsed.thought) {
          console.log(`[Thought] ${parsed.thought}`);
          this.hooks.onThought?.(parsed.thought);
          this.captureAnalysisFromThought(parsed.thought);
        }

        // Track whether ANY tool in this round failed
        let roundHadFailure = false;

        for (const toolCall of response.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          this.hooks.onToolStart?.(toolCall.function.name, args);

          let result: string;
          try {
            result = await this.toolRegistry.execute(
              toolCall.function.name,
              args,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = `Error executing tool "${toolCall.function.name}": ${message}`;
          }

          // Track failure/success for replan detection and hooks
          if (result.startsWith("Error")) {
            roundHadFailure = true;
            this.hooks.onToolError?.(toolCall.function.name, result);
          } else {
            this.hooks.onToolEnd?.(toolCall.function.name, result);
          }

          // Track this result for error analysis if it indicates a failure
          this.trackToolErrorForAnalysis(toolCall.function.name, result);

          const toolMessage = Message.tool(
            result,
            toolCall.id,
            toolCall.function.name,
          );

          this.contextManager.addMessage(toolMessage.toDict());
        }

        // Update consecutive failure count and step progress
        if (roundHadFailure) {
          this.consecutiveFailures++;
          console.log(
            `[Replan] Consecutive failures: ${this.consecutiveFailures}` +
              (this.replanThreshold > 0 &&
              this.consecutiveFailures >= this.replanThreshold
                ? ` — threshold reached (${this.replanThreshold}), will prompt replan`
                : ""),
          );
        } else {
          // Reset failure counter on success
          this.consecutiveFailures = 0;

          // Advance completed steps based on LLM-reported progress
          if (parsed.currentStep && this.hasPlan) {
            this.completedSteps = Math.max(
              this.completedSteps,
              Math.min(parsed.currentStep - 1, this.currentPlan.length),
            );
          } else if (this.hasPlan) {
            this.completedSteps = Math.min(
              this.completedSteps + 1,
              this.currentPlan.length,
            );
          }

          if (this.hasPlan) {
            console.log(
              `[Progress] Step ${this.completedSteps}/${this.currentPlan.length} completed`,
            );
          }
        }

        // Save checkpoint after complete tool execution round
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("active");
        }

        // Continue the loop for the next thought
        continue;
      }

      // ── Final answer ────────────────────────────────────────────
      if (parsed.answer) {
        if (parsed.thought) {
          console.log(`[Thought] ${parsed.thought}`);
          this.hooks.onThought?.(parsed.thought);
        }
        console.log(`[Plan-Solve] Task complete — returning final answer.`);
        // Save final checkpoint as completed
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        this.hooks.onFinish?.(parsed.answer);
        return parsed.answer;
      }

      // ── Initial plan creation ───────────────────────────────────
      if (
        !this.hasPlan &&
        parsed.plan &&
        Array.isArray(parsed.plan) &&
        parsed.plan.length > 0
      ) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.plan.slice(0, this.maxPlanSteps);
        this.hasPlan = true;
        console.log(`[Plan] Created ${this.currentPlan.length}-step plan:`);
        for (let i = 0; i < this.currentPlan.length; i++) {
          console.log(`  ${i + 1}. ${this.currentPlan[i]}`);
        }
        this.hooks.onPlanCreated?.(this.currentPlan);
        if (parsed.thought) {
          console.log(`[Thought] ${parsed.thought}`);
          this.hooks.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Plan revision ───────────────────────────────────────────
      if (
        parsed.revised_plan &&
        Array.isArray(parsed.revised_plan) &&
        parsed.revised_plan.length > 0
      ) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.revised_plan.slice(0, this.maxPlanSteps);
        this.completedSteps = 0; // Remaining steps are now new
        console.log(
          `[Plan] Revised — ${this.currentPlan.length} steps remaining:`,
        );
        for (let i = 0; i < this.currentPlan.length; i++) {
          console.log(`  ${i + 1}. ${this.currentPlan[i]}`);
        }
        this.hooks.onPlanRevised?.(this.currentPlan);
        if (parsed.thought) {
          console.log(`[Thought] ${parsed.thought}`);
          this.hooks.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Default: log thought and continue loop ──────────────────
      if (parsed.thought) {
        consecutiveEmptyIterations++;
        console.log(`[Thought] ${parsed.thought}`);
        this.hooks.onThought?.(parsed.thought);
        this.captureAnalysisFromThought(parsed.thought);

        // If stuck in thought-only loop, bail out
        if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
          const stuckMsg =
            "I apologize, but I'm having difficulty making progress on your request. " +
            "Please try rephrasing or breaking it down into smaller, more specific steps.";
          const stuckAssistantMessage = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckAssistantMessage.toDict());
          this.hooks.onFinish?.(stuckMsg);
          return stuckMsg;
        }

        continue;
      }

      // Empty response (no thought, no answer, no tool calls, no plan)
      consecutiveEmptyIterations++;
      if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
        const stuckMsg =
          "I apologize, but I'm having difficulty making progress on your request. " +
          "Please try rephrasing or breaking it down into smaller, more specific steps.";
        const stuckAssistantMessage = Message.assistant(stuckMsg);
        this.contextManager.addMessage(stuckAssistantMessage.toDict());
        this.hooks.onFinish?.(stuckMsg);
        return stuckMsg;
      }
    }

    // ── Max iterations reached without final answer ──────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    return timeoutMsg;
  }

  // ─── Session Persistence Overrides ───────────────────────────────────

  /**
   * Agent type identifier for session metadata.
   */
  protected getAgentType(): "plan-solve" {
    return "plan-solve";
  }

  /**
   * Include plan state in session checkpoints.
   */
  protected buildBaseSessionState(status: SessionStatus): SessionState {
    const base = super.buildBaseSessionState(status);
    return {
      ...base,
      planState: {
        currentPlan: this.currentPlan,
        hasPlan: this.hasPlan,
        completedSteps: this.completedSteps,
        consecutiveFailures: this.consecutiveFailures,
      },
    };
  }

  /**
   * Restore plan state from a saved session.
   */
  protected loadAndRestoreSession(sessionId: string): SessionState {
    const state = super.loadAndRestoreSession(sessionId);

    if (state.planState) {
      this.currentPlan = state.planState.currentPlan;
      this.hasPlan = state.planState.hasPlan;
      this.completedSteps = state.planState.completedSteps;
      this.consecutiveFailures = state.planState.consecutiveFailures;
    }

    return state;
  }

  // ─── Resume ──────────────────────────────────────────────────────────

  /**
   * Resume a previously interrupted session.
   *
   * Restores messages, system prompt, and plan state so the agent can
   * continue from where it left off.
   *
   * @param sessionId The session ID to resume.
   * @param input     New user input to continue the conversation.
   */
  async resume(sessionId: string, input: string): Promise<string> {
    this.loadAndRestoreSession(sessionId);
    // Signal run() to preserve the restored plan state
    this._skipPlanReset = true;
    return this.run(input);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /**
   * Handle an LLMNetworkError: save an interrupted checkpoint if
   * checkpointing is enabled, and return a user-facing message with
   * resume instructions.
   */
  private handleNetworkError(err: LLMNetworkError, iteration: number): string {
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("interrupted");
    }

    const sid = this.sessionManager?.getSessionId() ?? "unknown";

    console.error(
      `\n[Network Error] ${err.cause}: ${err.message}`,
    );

    if (this.checkpointingEnabled && this.sessionManager) {
      return (
        `[Network Error] ${err.message}\n\n` +
        `Your session "${sid}" has been saved (iteration ${iteration}).\n` +
        `After your network is restored, resume with:\n` +
        `  agent.resume("${sid}", "continue with what you were doing")\n\n` +
        `Or start a new session by calling agent.run() again.`
      );
    }

    return (
      `[Network Error] ${err.message}\n\n` +
      `Please check your network connection and try again.`
    );
  }

  // ─── Plan Context Injection ─────────────────────────────────────────────

  /**
   * Rebuild the system prompt to include the current plan context
   * alongside the core prompt and active skill prompts.
   *
   * Called each iteration so the LLM always sees the up-to-date plan.
   *
   * @param replanHint Optional hint injected when consecutive tool
   *                   failures exceed the threshold, nudging the LLM
   *                   to consider revising its plan.
   */
  private rebuildContextWithPlan(replanHint?: string): void {
    let prompt = this.coreSystemPrompt;

    // User preferences — injected as a system-prompt section
    prompt += PreferenceManager.toPrompt(this.preferences);

    // Available skills hint (progressive disclosure — names only)
    prompt += this.skillManager.buildAvailableSkillsHint();

    // Plan context — injected when a plan exists
    if (this.hasPlan && this.currentPlan.length > 0) {
      prompt += `\n\n=== Current Plan (${this.completedSteps}/${this.currentPlan.length} completed) ===\n`;
      for (let i = 0; i < this.currentPlan.length; i++) {
        const marker =
          i < this.completedSteps
            ? "✅"
            : i === this.completedSteps
              ? "➡️"
              : "  ";
        prompt += `  ${marker} ${i + 1}. ${this.currentPlan[i]}\n`;
      }
      prompt +=
        `\nWork through the plan step by step. ` +
        `When you complete a step, move to the next one. ` +
        `If you need to revise remaining steps, output a "revised_plan".`;
    }

    // Replan hint — injected when consecutive failures are detected
    if (replanHint) {
      prompt += `\n\n${replanHint}`;
    }

    // Active skill instructions
    prompt += this.skillManager.buildSkillsPrompt();

    this.contextManager.setSystemMessage(prompt);
  }

  /**
   * Compute a replan hint based on the current consecutive failure count.
   *
   * When consecutive failures reach the configured threshold, a message is
   * returned that will be appended to the system prompt, nudging the LLM
   * to consider revising its plan rather than continuing with a failing approach.
   *
   * Returns undefined when no hint is needed (failures below threshold
   * or auto-replan is disabled).
   */
  private computeReplanHint(): string | undefined {
    if (this.replanThreshold <= 0) return undefined;
    if (!this.hasPlan) return undefined;
    if (this.consecutiveFailures >= this.replanThreshold) {
      return (
        `⚠️ REPLAN SUGGESTED: Multiple consecutive tool failures detected (${this.consecutiveFailures}).\n` +
        `The current approach may be fundamentally wrong.\n` +
        `Please consider whether your plan needs revision. If so, output a "revised_plan" ` +
        `with a new strategy for the remaining steps. Only the REMAINING steps — ` +
        `do NOT re-list already completed steps.`
      );
    }
    return undefined;
  }
}
