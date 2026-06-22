import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import {
  parsePlanSolveResponse,
  PLAN_SOLVE_INSTRUCTIONS,
} from "./response-schema";
import { TOOL_ERROR_RECOVERY, SUB_AGENT_DELEGATION } from "./system-prompts";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse, LLMResponseErrorCode } from "../llm/interface";
import { ToolResult, ToolErrorCode, toolError } from "../tools/types";
import { SessionState, SessionStatus } from "../session/session-types";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin";

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
${TOOL_ERROR_RECOVERY}
5. If multiple tools fail in a round, consider whether your PLAN needs revision.
   The approach may be fundamentally wrong — output a "revised_plan".${PLAN_SOLVE_INSTRUCTIONS}
${SUB_AGENT_DELEGATION}`;

/**
 * Configuration specific to the Plan-and-Solve Agent.
 */
export interface PlanSolveAgentConfig extends AgentConfig {
  /** Maximum iterations for the Plan-Solve loop (default: 15). */
  maxIterations?: number;

  /** Maximum number of steps in a plan (default: 12). */
  maxPlanSteps?: number;

  /** Number of consecutive tool failures before a "replan hint" is injected
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
    this.replanThreshold = config.replanThreshold ?? 2;

    // Build the full system prompt once all sections are ready
    this.rebuildSystemPrompt();
  }

  async run(input: string): Promise<string> {
    // ── Async initialization (MCP connections, etc.) ─────────────────
    await this.init();

    // ── Reload dynamic resources (preferences, skills, MCP) ─────────
    await this.reloadDynamicResources();

    // ── Recover orphaned sub-agent results from a cancelled session ──
    this.recoverOrphanedSubAgentResults();

    // ── Pre-flight: reject oversized input before any LLM call ───────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

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

    // Track consecutive max_tokens truncations (to avoid infinite continuation loops)
    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    // ── Main Plan-Solve loop ────────────────────────────────────────
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Check if user cancelled (SIGINT)
      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        const cancelMsg =
          `Execution cancelled by user. Session "${sid}" preserved — ` +
          `resume with agent.resume("${sid}", "<your prompt>").`;
        for (const h of this.hooks) h.onFinish?.(cancelMsg);
        return cancelMsg;
      }

      await this.checkAndCompress();

      // Rebuild the system prompt to inject current plan progress
      // and any replan hint if consecutive failures are detected
      const replanHint = this.computeReplanHint();
      this.rebuildContextWithPlan(replanHint);

      const contextMessages = this.contextManager.getContextMessages();

      // Token budget check — stop if the session budget is exhausted
      const budgetError = this.checkTokenBudget(this.contextManager.getCurrentTokens());
      if (budgetError) {
        for (const h of this.hooks) h.onFinish?.(budgetError);
        return budgetError;
      }

      // Call the LLM — with network error handling
      for (const h of this.hooks) h.onLLMStart?.(contextMessages, this.toolRegistry.getTools());
      let response: LLMResponse;
      try {
        response = await this.llm.chat(
          contextMessages,
          this.toolRegistry.getTools(),
        );
      } catch (err: unknown) {
        if (err instanceof LLMNetworkError) {
          for (const h of this.hooks) h.onLLMError?.(err);
          return this.handleNetworkError(err, iteration + 1, "continue with what you were doing");
        }
        throw err;
      }
      for (const h of this.hooks) h.onLLMEnd?.(response);

      // Record token usage against the session budget
      if (response.usage) {
        this.tokenBudget?.recordUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      const parsed = parsePlanSolveResponse(response.content);

      // Create assistant message from the response
      const assistantMessage = Message.assistant(
        response.content,
        response.tool_calls,
      );

      // ── Handle max_tokens truncation ──────────────────────────────
      const isTruncated = response.responseError?.code === LLMResponseErrorCode.MAX_TOKENS;
      if (isTruncated) {
        consecutiveTruncations++;
        if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
          // Bail out — too many consecutive truncations, return what we have.
          // Don't add the truncated message to context; it's incomplete junk.
          const fallback = parsed.answer
            ? parsed.answer + "\n\n[Note: Response may be incomplete due to repeated output limits.]"
            : "I apologize, but I'm unable to complete this response due to output length constraints. " +
              "Please try breaking your request into smaller steps.";
          for (const h of this.hooks) h.onFinish?.(fallback);
          return fallback;
        }

        // Store the truncated message so the LLM has context for where it left off,
        // then inject a continuation instruction.
        this.contextManager.addMessage(assistantMessage.toDict());

        const continueMsg = Message.user(
          "Your previous response was cut off (max output tokens reached). " +
          "Continue exactly where you left off — do NOT repeat any content already written. " +
          "If you were calling tools, re-invoke them with complete arguments."
        );
        this.contextManager.addMessage(continueMsg.toDict());
      } else {
        // Normal (non-truncated) response — store it and reset the counter.
        this.contextManager.addMessage(assistantMessage.toDict());
        consecutiveTruncations = 0;
      }

      // ── Handle tool calls (execution phase) ─────────────────────
      if (response.tool_calls && response.tool_calls.length > 0) {
        consecutiveEmptyIterations = 0;

        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }

        // If the LLM response shows non-truncation quality issues, warn
        // before executing tool calls. (max_tokens truncation is handled above.)
        if (response.responseError &&
            response.responseError.code !== LLMResponseErrorCode.MAX_TOKENS &&
            response.responseError.code !== LLMResponseErrorCode.OK) {
          const warnMsg = Message.system(
            `LLM response quality issue: ${response.responseError.message}`
          );
          this.contextManager.addMessage(warnMsg.toDict());
        }

        // Track whether ANY tool in this round failed
        let roundHadFailure = false;

        const mcpWarnedServers = new Set<string>();

        for (const toolCall of response.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            // Arguments are malformed or truncated — don't execute.
            const result: ToolResult = toolError(
              ToolErrorCode.ARGUMENTS_PARSE_ERROR,
              `[RETRYABLE:ARGUMENTS_PARSE_ERROR] Failed to parse arguments for tool "${toolCall.function.name}". ` +
              `The raw arguments were: ${toolCall.function.arguments || "(empty)"}\n\n` +
              `${response.responseError?.code === LLMResponseErrorCode.MAX_TOKENS ? "The LLM response was truncated (max_tokens). Please reduce context or split the work across smaller steps. " : ""}` +
              `Please re-invoke the tool with correctly formatted JSON arguments.`,
              "retryable",
            );

            roundHadFailure = true;
            // Tool never executed — args were unparseable
            for (const h of this.hooks) h.onToolError?.(toolCall.function.name, result.content);

            const toolMessage = Message.tool(
              result.content,
              toolCall.id,
              toolCall.function.name,
            );
            this.contextManager.addMessage(toolMessage.toDict());
            continue;
          }

          for (const h of this.hooks) h.onToolStart?.(toolCall.function.name, args);

          // Execute via ToolRegistry — never throws.
          const result: ToolResult = await this.toolRegistry.execute(
            toolCall.function.name,
            args,
          );

          if (!result.success) {
            roundHadFailure = true;
            for (const h of this.hooks) h.onToolError?.(toolCall.function.name, result.content);
          } else {
            for (const h of this.hooks) h.onToolEnd?.(toolCall.function.name, result.content);
          }

          const toolMessage = Message.tool(
            result.content,
            toolCall.id,
            toolCall.function.name,
          );

          this.contextManager.addMessage(toolMessage.toDict());

          // ── Post-execution handling for special tool types ────
          const toolName = toolCall.function.name;

          // Sub-agent spawned — purely informational; results arrive
          // asynchronously and will be injected via pollSubAgentResults().
          if (result.success && toolName === "spawn_subagent") {
            this.logger.info(
              "SubAgent",
              `Spawned "${args.name ?? "unknown"}" — ` +
              `result will arrive in a later iteration.`
            );
          }

          // MCP tool failure — warn about potential connection loss so
          // the LLM can stop calling tools from the same server.
          // Only warn once per server per batch to avoid duplicate messages.
          if (!result.success && !BUILTIN_TOOL_NAMES.has(toolName)) {
            const serverName = toolName.split("_")[0] ?? "unknown";
            if (!mcpWarnedServers.has(serverName)) {
              const isConnErr =
                result.content.includes("connection") ||
                result.content.includes("not connected") ||
                result.content.includes("ECONNREFUSED") ||
                result.content.includes("ENOTFOUND");
              if (isConnErr) {
                mcpWarnedServers.add(serverName);
                this.logger.info(
                  "MCP",
                  `Connection lost to server "${serverName}" — ` +
                  `further calls to this server may fail.`
                );
                const mcpWarn = Message.system(
                  `MCP server "${serverName}" appears to be disconnected: ${result.content.slice(0, 200)}`
                );
                this.contextManager.addMessage(mcpWarn.toDict());
              }
            }
          }
        }

        // Update consecutive failure count and step progress
        if (roundHadFailure) {
          this.consecutiveFailures++;
          this.logger.info(
            "Replan",
            `Consecutive failures: ${this.consecutiveFailures}` +
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
            this.logger.info(
              "Progress",
              `Step ${this.completedSteps}/${this.currentPlan.length} completed`,
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
        // If truncated, don't return — the continuation instruction is
        // already in context; next iteration will continue from here.
        if (isTruncated) {
          consecutiveEmptyIterations = 0;
          if (parsed.thought) {
            this.logger.info("Thought", parsed.thought);
            for (const h of this.hooks) h.onThought?.(parsed.thought);
          }
          // If this is the last iteration we can't continue — return
          // what we have instead of the generic "max iterations" message.
          if (iteration === this.maxIterations - 1) {
            const fallback = parsed.answer +
              "\n\n[Note: Response may be incomplete due to output length constraints.]";
            for (const h of this.hooks) h.onFinish?.(fallback);
            return fallback;
          }
          this.logger.info("Plan-Solve", "Answer truncated (max_tokens) — continuing in next iteration.");
          continue;
        }
        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        this.logger.info("Plan-Solve", "Task complete — returning final answer.");
        // Save final checkpoint as completed
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(parsed.answer);
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
        this.logger.info("Plan", `Created ${this.currentPlan.length}-step plan:`);
        for (let i = 0; i < this.currentPlan.length; i++) {
          this.logger.info("Plan", `  ${i + 1}. ${this.currentPlan[i]}`);
        }
        for (const h of this.hooks) h.onPlanCreated?.(this.currentPlan);
        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
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
        this.consecutiveFailures = 0; // New plan, fresh failure counter
        this.logger.info(
          "Plan",
          `Revised — ${this.currentPlan.length} steps remaining:`,
        );
        for (let i = 0; i < this.currentPlan.length; i++) {
          this.logger.info("Plan", `  ${i + 1}. ${this.currentPlan[i]}`);
        }
        for (const h of this.hooks) h.onPlanRevised?.(this.currentPlan);
        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Default: log thought and continue loop ──────────────────
      if (parsed.thought) {
        consecutiveEmptyIterations++;
        this.logger.info("Thought", parsed.thought);
        for (const h of this.hooks) h.onThought?.(parsed.thought);

        // If stuck in thought-only loop, bail out
        if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
          const stuckMsg =
            "I apologize, but I'm having difficulty making progress on your request. " +
            "Please try rephrasing or breaking it down into smaller, more specific steps.";
          const stuckAssistantMessage = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckAssistantMessage.toDict());
          for (const h of this.hooks) h.onFinish?.(stuckMsg);
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
        for (const h of this.hooks) h.onFinish?.(stuckMsg);
        return stuckMsg;
      }
    }

    // ── Max iterations reached without final answer ──────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    for (const h of this.hooks) h.onFinish?.(timeoutMsg);
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

  // ─── Network error handling inherited from Agent ───────────────────
  // handleNetworkError is defined in the base Agent class.

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
    let prompt = this.buildSystemPrompt();

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
