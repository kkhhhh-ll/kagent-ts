import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import {
  parsePlanSolveResponse,
  PLAN_SOLVE_INSTRUCTIONS,
} from "./response-schema";
import { TOOL_ERROR_RECOVERY } from "./system-prompts";
import { wrapAndScan } from "../security/boundaries";
import { StreamingAnswerExtractor } from "./streaming-answer-extractor";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse, LLMResponseErrorCode } from "../llm/interface";
import { SessionState, SessionStatus } from "../session/session-types";


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
   The approach may be fundamentally wrong — output a "revised_plan".${PLAN_SOLVE_INSTRUCTIONS}`;

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

  /** Skill precipitation mode. Default: "off". */
  precipitation?: "off" | "post-hoc";

  /** Max iterations for the precipitation sub-agent. Default: 15. */
  precipitationMaxIterations?: number;

  /** Max iterations for each skill-verification fork. Default: 8. */
  skillVerificationMaxIterations?: number;

  /** Memory reflection mode. Default: "off". */
  memoryReflection?: "off" | "post-hoc";

  /** Max iterations for the memory reflection sub-agent. Default: 5. */
  memoryReflectionMaxIterations?: number;

  /** Error reflection mode. Default: "off". */
  reflection?: "off" | "post-hoc";

  /** Max iterations for the reflection sub-agent. Default: 6. */
  reflectionMaxIterations?: number;

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
  private precipitationMode: "off" | "post-hoc";
  private precipitationMaxIterations: number;
  private skillVerificationMaxIterations: number;
  private memoryReflectionMode: "off" | "post-hoc";
  private memoryReflectionMaxIterations: number;
  private reflectionMode: "off" | "post-hoc";
  private reflectionMaxIterations: number;


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
    const mergedConfig: PlanSolveAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_PLAN_SOLVE_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxIterations = config.maxIterations ?? 15;
    this.maxPlanSteps = config.maxPlanSteps ?? 12;
    this.replanThreshold = config.replanThreshold ?? 2;
    this.precipitationMode = config.precipitation ?? "off";
    this.precipitationMaxIterations = config.precipitationMaxIterations ?? 15;
    this.skillVerificationMaxIterations = config.skillVerificationMaxIterations ?? 8;
    this.memoryReflectionMode = config.memoryReflection ?? "off";
    this.memoryReflectionMaxIterations = config.memoryReflectionMaxIterations ?? 5;
    this.reflectionMode = config.reflection ?? "off";
    this.reflectionMaxIterations = config.reflectionMaxIterations ?? 6;

    // Build the full system prompt once all sections are ready
    this.rebuildSystemPrompt();
  }

  async run(input: string): Promise<string> {
    // Consume the skip-reset flag immediately — no early return path
    // may leave it dangling (resume() sets it before calling run()).
    const skipPlanReset = this._skipPlanReset;
    this._skipPlanReset = false;

    // ── Pre-flight: reject oversized input before any setup ───────────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

    // ── Async initialization (MCP connections, etc.) ─────────────────
    await this.init();

    // ── Reload dynamic resources (preferences, skills, MCP) ─────────
    await this.reloadDynamicResources();

    // ── Recover orphaned sub-agent results from a cancelled session ──
    this.recoverOrphanedSubAgentResults();

    // ── Intent detection (zero LLM cost, runs once per run) ────────
    this.detectInputSignals(input);
    this.matchInputSkills(input);

    // ── Create user message ─────────────────────────────────────────
    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    // Reset plan state for this run (skip when resuming a session)
    if (!skipPlanReset) {
      this.currentPlan = [];
      this.hasPlan = false;
      this.consecutiveFailures = 0;
      this.completedSteps = 0;
    }

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

    // Determine if precipitation should run (mode + signals)
    const FAILURE_PRECIPITATE_THRESHOLD = 2;
    let shouldPrecipitate = this.precipitationMode === "post-hoc";
    let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
    if (this.inputSignals.wantsRemember) {
      shouldPrecipitate = true;
      shouldReflectMemory = true;
    }

    // Determine if error reflection should run
    const shouldReflect = this.reflectionMode === "post-hoc";

    // ── Main Plan-Solve loop ────────────────────────────────────────
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Fresh AbortController per iteration so the signal's listener
      // count doesn't accumulate across LLM calls and retries.
      this._abortController = new AbortController();

      // Check if user cancelled (SIGINT)
      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        const cancelMsg =
          `Execution cancelled by user. Session "${sid}" preserved — ` +
          `resume with agent.resume("${sid}", "<your prompt>").`;
        this.fireOnFinish(cancelMsg);
        return cancelMsg;
      }

      // ── Poll sub-agent results ──────────────────────────────────────
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const source = `subagent:${r.name}`;
        const msg = new Message(
          Role.User,
          wrapAndScan(source, r.output),
          { name: source },
        );
        this.contextManager.addMessage(msg.toDict());
      }

      await this.checkAndCompress();

      // Rebuild the system prompt to inject current plan progress
      // and any replan hint if consecutive failures are detected
      const replanHint = this.computeReplanHint();
      this.rebuildContextWithPlan(replanHint);

      const contextMessages = this.contextManager.getContextMessages();

      // Token budget check — skip token counting when no budget is configured
      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) {
        this.fireOnFinish(budgetError);
        return budgetError;
      }

      // Call the LLM — with network error handling.
      // First round: withhold tools to force plan generation. Once a plan
      // exists, pass all tools for execution. This prevents models (esp.
      // weaker ones) from skipping the plan phase and acting like ReAct.
      const toolsForRound = this.hasPlan
        ? this.toolRegistry.getTools()
        : [];
      for (const h of this.hooks) h.onLLMStart?.(contextMessages, toolsForRound);
      let response: LLMResponse;
      try {
        response = await this.llm.chat(
          contextMessages,
          toolsForRound,
          this._abortController?.signal,
        );
      } catch (err: unknown) {
        // Cancellation by user (AbortController) — exit the loop cleanly
        if (this.isCancelled) {
          this.saveCheckpoint("cancelled");
          const sid = this.sessionManager?.getSessionId() ?? "unknown";
          const cancelMsg =
            `Execution cancelled by user. Session "${sid}" preserved — ` +
            `resume with agent.resume("${sid}", "<your prompt>").`;
          this.fireOnFinish(cancelMsg);
          return cancelMsg;
        }
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

      // Capture LLM analysis of any active tool error traces
      if (parsed.thought) {
        this.captureErrorAnalysis(parsed.thought);
      }

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
          this.fireOnFinish(fallback);
          return fallback;
        }

        // Store the truncated message so the LLM has context for where it
        // left off. The continuation instruction is injected AFTER tool
        // execution (if any) so it does not break the tool_use/tool_result
        // pairing required by the Anthropic API.
        this.contextManager.addMessage(assistantMessage.toDict());
      } else {
        // Normal (non-truncated) response — store it and reset the counter.
        this.contextManager.addMessage(assistantMessage.toDict());
        consecutiveTruncations = 0;
      }

      // ── Handle tool calls (execution phase) ─────────────────────
      if (response.tool_calls && response.tool_calls.length > 0) {
        // Intercept hallucinated "answer" tool calls before execution
        const extractedAnswer = this.extractAnswerFromToolCalls(response.tool_calls);
        if (extractedAnswer) {
          this.consecutiveFailures = 0;
          return extractedAnswer;
        }

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

        const mcpWarnedServers = new Set<string>();
        const { hadFailure: roundHadFailure } = await this.executeToolCallsBatch(
          response.tool_calls!,
          mcpWarnedServers,
        );

        // Inject the continuation instruction AFTER tool execution so it
        // does not sit between the assistant's tool_use blocks and their
        // tool_result blocks (which would violate the Anthropic API's
        // requirement that tool_results appear in the immediately next
        // message after tool_use blocks).
        if (isTruncated) {
          const continueMsg = Message.user(
            "Your previous response was cut off (max output tokens reached). " +
            "Continue exactly where you left off — do NOT repeat any content already written."
          );
          this.contextManager.addMessage(continueMsg.toDict());
        }

        // Update consecutive failure count and step progress
        if (roundHadFailure) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= FAILURE_PRECIPITATE_THRESHOLD
              && this.precipitationMode !== "off") {
            shouldPrecipitate = true;
          }
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
        // If truncated, don't return — inject a continuation instruction
        // so the LLM knows to pick up where it left off.
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
            this.fireOnFinish(fallback);
            return fallback;
          }
          // Inject continuation instruction so the LLM knows to complete
          // its truncated response (no tool calls were present).
          const continueMsg = Message.user(
            "Your previous response was cut off (max output tokens reached). " +
            "Continue exactly where you left off — do NOT repeat any content already written."
          );
          this.contextManager.addMessage(continueMsg.toDict());
          this.logger.info("Plan-Solve", "Answer truncated (max_tokens) — continuing in next iteration.");
          continue;
        }
        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        // ── Hold the answer while sub-agents are still running ──────
        if (iteration < this.maxIterations - 1 && this.holdAnswerForPendingSubAgents()) {
          continue;
        }

        this.logger.info("Plan-Solve", "Task complete — returning final answer.");
        // Save final checkpoint as completed
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        // ── Answer verification (blocking, runs before returning) ──────
        let verifiedAnswer = parsed.answer;
        if (this.verificationMode === "post-hoc") {
          try {
            verifiedAnswer = await this.runVerification(input, parsed.answer);
          } catch (err: unknown) {
            this.logger.warn("Verification", `Verification failed: ${err instanceof Error ? err.message : String(err)} — returning original answer.`);
          }
        }

        this.fireOnFinish(verifiedAnswer);

        // ── Skill precipitation (fire-and-forget, post-hoc) ─────────
        if (shouldPrecipitate) {
          this.trackBackground(this.runPrecipitation(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        // ── Memory reflection (fire-and-forget, post-hoc) ────────────
        if (shouldReflectMemory) {
          this.trackBackground(this.runMemoryReflection(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        // ── Error reflection (fire-and-forget, post-hoc) ───────────────
        if (shouldReflect) {
          this.trackBackground(this.runReflection(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("Reflection", `Background reflection failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        return verifiedAnswer;
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
          this.fireOnFinish(stuckMsg);
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
        this.fireOnFinish(stuckMsg);
        return stuckMsg;
      }
    }

    // ── Max iterations reached without final answer ──────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    this.fireOnFinish(timeoutMsg);
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
  protected async *executeStream(input: string): AsyncIterable<string> {
    const sizeError = this.validateInputSize(input);
    if (sizeError) { yield sizeError; return; }

    await this.init();
    await this.reloadDynamicResources();

    this.recoverOrphanedSubAgentResults();

    // ── Intent detection (zero LLM cost, runs once per run) ────────
    this.detectInputSignals(input);
    this.matchInputSkills(input);

    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    this.currentPlan = [];
    this.hasPlan = false;
    this.consecutiveFailures = 0;
    this.completedSteps = 0;

    if (this.checkpointingEnabled) this.saveCheckpoint("active");

    let consecutiveEmptyIterations = 0;
    const EMPTY_ITERATION_LIMIT = 5;

    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    // Determine if precipitation should run (mode + signals)
    const FAILURE_PRECIPITATE_THRESHOLD = 2;
    let shouldPrecipitate = this.precipitationMode === "post-hoc";
    let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
    if (this.inputSignals.wantsRemember) {
      shouldPrecipitate = true;
      shouldReflectMemory = true;
    }

    // Determine if error reflection should run
    const shouldReflect = this.reflectionMode === "post-hoc";

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      this._abortController = new AbortController();

      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        yield `\n\n[Cancelled. Session "${sid}" preserved.]`;
        return;
      }

      // Poll sub-agents
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const source = `subagent:${r.name}`;
        this.contextManager.addMessage(
          new Message(Role.User, wrapAndScan(source, r.output), { name: source }).toDict(),
        );
      }

      await this.checkAndCompress();

      const replanHint = this.computeReplanHint();
      this.rebuildContextWithPlan(replanHint);

      const contextMessages = this.contextManager.getContextMessages();
      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) { yield budgetError; return; }

      // First round: no tools (force plan generation).
      // Buffer the raw output — don't stream raw JSON to the user.
      const isPlanRound = !this.hasPlan;
      const toolsForRound = isPlanRound ? [] : this.toolRegistry.getTools();
      for (const h of this.hooks) h.onLLMStart?.(contextMessages, toolsForRound);

      // ── Streaming LLM call ────────────────────────────────────────
      let rawContent = "";
      let isTruncated = false;
      let toolCallsMap = new Map<number, { id?: string; name?: string; args?: string }>();
      let streamUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      // Filters the structured JSON envelope out of the display stream —
      // consumers see the decoded `answer` text, not `{"thought": ...`.
      const answerExtractor = new StreamingAnswerExtractor();

      try {
        for await (const event of this.llm.chatStream(
          contextMessages,
          toolsForRound,
          this._abortController?.signal,
        )) {
          if (event.type === "chunk") {
            if (event.content) {
              rawContent += event.content;
              const display = answerExtractor.feed(event.content);
              // Buffer plan-round output; stream execution-round output.
              if (!isPlanRound && display) {
                yield display;
                for (const h of this.hooks) h.onChunk?.(display);
              }
            }
            if (event.tool_calls) {
              for (const tc of event.tool_calls) {
                const ex = toolCallsMap.get(tc.index) ?? { args: "" };
                if (tc.id) ex.id = tc.id;
                if (tc.function?.name) ex.name = tc.function.name;
                if (tc.function?.arguments) ex.args = (ex.args ?? "") + tc.function.arguments;
                toolCallsMap.set(tc.index, ex);
              }
            }
          } else if (event.type === "done") {
            streamUsage = event.usage;
            isTruncated = event.stop_reason === "length";
          }
        }
      } catch (err: unknown) {
        if (this.isCancelled) {
          this.saveCheckpoint("cancelled");
          const sid = this.sessionManager?.getSessionId() ?? "unknown";
          yield `\n\n[Cancelled. Session "${sid}" preserved.]`;
          return;
        }
        if (err instanceof LLMNetworkError) {
          for (const h of this.hooks) h.onLLMError?.(err);
          const msg = await this.handleNetworkError(
            err,
            iteration + 1,
            "continue with what you were doing",
          );
          yield `\n\n[Network error: ${err.message}${msg ? " — " + msg : ""}]`;
          return;
        }
        throw err;
      }

      const toolCalls = Array.from(toolCallsMap.entries())
        .filter(([, tc]) => tc.name && tc.args !== undefined)
        .map(([, tc]) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
          type: "function" as const,
          function: { name: tc.name!, arguments: tc.args! },
        }));

      if (streamUsage) {
        this.tokenBudget?.recordUsage(streamUsage.prompt_tokens, streamUsage.completion_tokens);
      }

      for (const h of this.hooks) {
        h.onLLMEnd?.({
          content: rawContent,
          tool_calls: toolCalls,
          usage: streamUsage,
          providerMeta: { model: this.llm.model, isFallback: false },
        });
      }

      const parsed = parsePlanSolveResponse(rawContent);
      if (parsed.thought) this.captureErrorAnalysis(parsed.thought);

      // ── Tool calls → execute and continue ─────────────────────────
      if (toolCalls.length > 0) {
        // Intercept hallucinated "answer" tool calls before execution
        const extractedAnswer = this.extractAnswerFromToolCalls(toolCalls);
        if (extractedAnswer) {
          this.consecutiveFailures = 0;
          yield extractedAnswer;
          yield "\n\n[DONE]";
          return;
        }

        consecutiveEmptyIterations = 0;
        if (parsed.thought) {

          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }

        const assistantMessage = Message.assistant(rawContent, toolCalls);

        if (isTruncated) {
          consecutiveTruncations++;
          if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
            // Don't add truncated junk to context — bail out cleanly.
            const fallback = parsed.answer
              ? parsed.answer + "\n\n[Note: Response may be incomplete due to repeated output limits.]"
              : "I apologize, but I'm unable to complete this response due to output length constraints. " +
                "Please try breaking your request into smaller steps.";
            this.fireOnFinish(fallback);
            yield fallback;
            return;
          }
        } else {
          consecutiveTruncations = 0;
        }

        // Add assistant BEFORE tool execution so tool results follow
        // immediately after (API pairing requirement).
        this.contextManager.addMessage(assistantMessage.toDict());

        const mcpWarnedServers = new Set<string>();
        const { hadFailure } = await this.executeToolCallsBatch(toolCalls, mcpWarnedServers);

        // Inject truncation continuation AFTER tool execution so the
        // assistant(tool_calls) → tool_result pairing is preserved.
        if (isTruncated) {
          this.contextManager.addMessage(
            Message.user(
              "Your previous response was cut off (max output tokens reached). " +
              "Continue exactly where you left off — do NOT repeat any content already written."
            ).toDict(),
          );
        }

        if (hadFailure) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= FAILURE_PRECIPITATE_THRESHOLD
              && this.precipitationMode !== "off") {
            shouldPrecipitate = true;
          }
          if (this.consecutiveFailures >= FAILURE_PRECIPITATE_THRESHOLD
              && this.memoryReflectionMode !== "off") {
            shouldReflectMemory = true;
          }
        } else {
          this.consecutiveFailures = 0;
          if (parsed.currentStep && this.hasPlan) {
            this.completedSteps = Math.max(this.completedSteps, Math.min(parsed.currentStep - 1, this.currentPlan.length));
          } else if (this.hasPlan) {
            this.completedSteps = Math.min(this.completedSteps + 1, this.currentPlan.length);
          }
        }
        if (this.checkpointingEnabled) this.saveCheckpoint("active");
        continue;
      }

      // ── No tool calls ─────────────────────────────────────────────
      const assistantMessage = Message.assistant(rawContent);

      // ── Truncation without tool calls ─────────────────────────────
      if (isTruncated) {
        consecutiveTruncations++;
        if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
          // Don't add truncated junk to context — bail out cleanly.
          const fallback = parsed.answer
            ? parsed.answer + "\n\n[Note: Response may be incomplete due to repeated output limits.]"
            : "I apologize, but I'm unable to complete this response due to output length constraints. " +
              "Please try breaking your request into smaller steps.";
          this.fireOnFinish(fallback);
          yield fallback;
          return;
        }
        // Store truncated message + inject continuation
        this.contextManager.addMessage(assistantMessage.toDict());
        this.contextManager.addMessage(
          Message.user(
            "Your previous response was cut off (max output tokens reached). " +
            "Continue exactly where you left off — do NOT repeat any content already written."
          ).toDict(),
        );
        continue;
      }
      consecutiveTruncations = 0;

      // Normal (non-truncated) response — store in context
      this.contextManager.addMessage(assistantMessage.toDict());

      // ── Final answer ─────────────────────────────────────────────
      if (parsed.answer) {
        if (parsed.thought) {

          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        // ── Hold the answer while sub-agents are still running ──────
        if (iteration < this.maxIterations - 1 && this.holdAnswerForPendingSubAgents()) {
          yield "\n\n[Waiting for sub-agent results...]\n\n";
          continue;
        }

        this.logger.info("Plan-Solve", "Task complete.");

        // Fallback: the envelope couldn't be streamed (no "answer" key
        // found — malformed JSON) — emit the parsed answer now.
        if (!answerExtractor.emitted) {
          yield parsed.answer;
        }

        // ── Answer verification (blocking, runs before returning) ──
        let verifiedAnswer = parsed.answer;
        if (this.verificationMode === "post-hoc") {
          try {
            verifiedAnswer = await this.runVerification(input, parsed.answer);
          } catch (err: unknown) {
            this.logger.warn("Verification", `Verification failed: ${err instanceof Error ? err.message : String(err)} — returning original answer.`);
          }
        }

        this.fireOnFinish(verifiedAnswer);
        if (this.checkpointingEnabled) this.saveCheckpoint("completed");

        if (shouldPrecipitate) {
          this.trackBackground(this.runPrecipitation(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        // ── Memory reflection (fire-and-forget, post-hoc) ────────────
        if (shouldReflectMemory) {
          this.trackBackground(this.runMemoryReflection(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        // ── Error reflection (fire-and-forget, post-hoc) ───────────────
        if (shouldReflect) {
          this.trackBackground(this.runReflection(input, verifiedAnswer)).catch((err: unknown) =>
            this.logger.warn("Reflection", `Background reflection failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        yield "\n\n[DONE]";
        return;
      }

      // ── Initial plan ─────────────────────────────────────────────
      if (!this.hasPlan && parsed.plan && parsed.plan.length > 0) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.plan.slice(0, this.maxPlanSteps);
        this.hasPlan = true;
        const planText = "\n## Plan\n" + this.currentPlan.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n";
        yield planText;
        this.logger.info("Plan", `Created ${this.currentPlan.length}-step plan`);
        for (const h of this.hooks) h.onPlanCreated?.(this.currentPlan);
        if (parsed.thought) {

          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Revised plan ─────────────────────────────────────────────
      if (parsed.revised_plan && parsed.revised_plan.length > 0) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.revised_plan.slice(0, this.maxPlanSteps);
        this.completedSteps = 0;
        this.consecutiveFailures = 0;
        const revText = "\n## Revised Plan\n" + this.currentPlan.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n";
        yield revText;
        this.logger.info("Plan", `Revised — ${this.currentPlan.length} steps`);
        for (const h of this.hooks) h.onPlanRevised?.(this.currentPlan);
        if (parsed.thought) {

          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Thought-only → accumulate, continue ──────────────────────
      if (parsed.thought) {
        consecutiveEmptyIterations++;

        for (const h of this.hooks) h.onThought?.(parsed.thought);
        if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
          yield "\n\n[Unable to make progress. Please try rephrasing.]";
          return;
        }
        continue;
      }

      consecutiveEmptyIterations++;
      if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
        yield "\n\n[Unable to make progress. Please try rephrasing.]";
        return;
      }
    }

    yield `\n\n[Unable to complete within ${this.maxIterations} iterations.]`;
  }

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

  // ─── Precipitation ───────────────────────────────────────────────────

  /**
   * Run post-hoc skill extraction after a successful completion.
   * Best-effort — failures are logged but never affect the answer.
   */
  private async runPrecipitation(
    input: string,
    answer: string,
  ): Promise<void> {
    if (!this.skillsDir) {
      this.logger.warn("Precipitation", "skillsDir not set — skipping.");
      return;
    }

    const { PrecipitateAgent } = await import("../precipitation/precipitate-agent.js");
    try {
      await PrecipitateAgent.runFromAgent({
        input,
        answer,
        skillsDir: this.skillsDir,
        skillManager: this.skillManager,
        llm: this.precipitationLLM ?? this.llm,
        sessionId: this.getSessionId(),
        maxIterations: this.precipitationMaxIterations,
        skillVerificationMaxIterations: this.skillVerificationMaxIterations,
        verifySkills: this.verifySkills,
        skillVerificationLLM: this.skillVerificationLLM,
        logger: this.logger,
        contextMessages: this.contextManager.getContextMessages(),
        hooks: this.hooks,
      });
    } catch (err: unknown) {
      this.logger.error(
        "Precipitation",
        `Skill precipitation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Memory Reflection ──────────────────────────────────────────────

  /**
   * Run post-hoc memory extraction after a successful completion.
   * Best-effort — failures are logged but never affect the answer.
   *
   * Unlike precipitation, no guard for `skillsDir` is needed here:
   * MemoryManager is always created by the base Agent constructor.
   */
  private async runMemoryReflection(
    input: string,
    answer: string,
  ): Promise<void> {
    const { MemoryReflector } = await import("../reflection/memory-reflector.js");

    try {
      const reflector = new MemoryReflector({
        llm: this.memoryReflectorLLM ?? this.llm,
        memoryManager: this.memoryManager,
        maxIterations: this.memoryReflectionMaxIterations,
        logger: this.logger,
        hooks: this.hooks,
      });

      const memories = await reflector.reflect({
        userQuery: input,
        finalAnswer: answer,
        conversation: this.contextManager.getContextMessages(),
        sessionId: this.getSessionId(),
      });

      if (memories.length > 0) {
        this.logger.info(
          "MemoryReflection",
          `Extracted ${memories.length} new memor${memories.length === 1 ? "y" : "ies"}.`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        "MemoryReflection",
        `Memory reflection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Error Reflection ──────────────────────────────────────────────

  /**
   * Dispatch error reflection based on mode.
   * Fire-and-forget — failures are logged but never affect the answer.
   */
  private async runReflection(input: string, answer: string): Promise<void> {
    if (this.reflectionMode === "off") return;
    if (this.reflectionMode === "post-hoc") {
      await this.reflectPostHoc(input, answer);
    }
  }

  /**
   * Fork a ReflectionAgent to review the session for errors and
   * persist findings to the ErrorNotebook.
   */
  private async reflectPostHoc(input: string, answer: string): Promise<void> {
    const { ReflectionAgent } = await import("../reflection/reflection-agent.js");
    const { ErrorNotebook: NB } = await import("../reflection/error-notebook.js");

    // Auto-create notebook if not provided
    const notebook = this.notebook ?? new NB();

    try {
      const reflector = new ReflectionAgent({
        llm: this.reflectionLLM ?? this.llm,
        notebook,
        maxIterations: this.reflectionMaxIterations,
        hooks: this.hooks,
      });

      const entries = await reflector.reflect({
        userQuery: input,
        finalAnswer: answer,
        conversation: this.contextManager.getContextMessages(),
        sessionId: this.getSessionId(),
        scenarios: this.inputSignals.scenarios.length > 0 ? this.inputSignals.scenarios : undefined,
        errorTraces: this.errorTracker?.getAllTraces(),
        complexity: this.inputSignals.complexity,
      });

      if (entries.length > 0) {
        this.logger.info(
          "Reflection",
          `Recorded ${entries.length} finding(s) to the error notebook.`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        "Reflection",
        `Post-hoc reflection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
