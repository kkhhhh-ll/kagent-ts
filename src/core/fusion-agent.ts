import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import { planHasRiskyOps } from "../intent/signal-detector";
import {
  FUSION_ROUTE_INSTRUCTIONS,
  FUSION_EXECUTION_INSTRUCTIONS,
  parseFusionRouteResponse,
  parseFusionResponse,
} from "./response-schema";
import {
  SECURITY_GUIDANCE,
  TOOL_ERROR_RECOVERY,
} from "./system-prompts";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse, LLMResponseErrorCode } from "../llm/interface";
import { wrapAndScan } from "../security/boundaries";
import { StreamingAnswerExtractor } from "./streaming-answer-extractor";
import { SessionState, SessionStatus } from "../session/session-types";
import type { FusionSessionState } from "../session/session-types";


// ─── System Prompt ────────────────────────────────────────────────────────

const DEFAULT_FUSION_SYSTEM_PROMPT = `You are a helpful AI assistant powered by the Fusion Agent paradigm.
You dynamically adapt your strategy to the task's complexity.

For SIMPLE tasks: direct ReAct (Reasoning + Acting) loop.
For COMPLEX tasks: Plan → ReAct loop with plan tracking & dynamic replanning.

You have access to a set of tools you can use to answer the user's question.
${SECURITY_GUIDANCE}
${TOOL_ERROR_RECOVERY}${FUSION_EXECUTION_INSTRUCTIONS}`;

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Callback for plan confirmation.
 *
 * Called after a plan is generated. Return `true` to proceed with execution,
 * `false` to abort and return the plan as the answer.
 */
export type PlanConfirmCallback = (
  plan: string[],
  reason: string,
) => Promise<boolean>;

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * Configuration for the Fusion Agent.
 *
 * Combines routing, plan confirmation, reflection, and loop control options
 * into a single configurable agent.
 */
export interface FusionAgentConfig extends AgentConfig {
  // ── Routing ─────────────────────────────────────────────────────────

  /**
   * How to determine the execution strategy:
   * - "auto":        LLM classifies task complexity (one extra LLM call).
   * - "force-plan":  Always Plan → Execute (skip routing).
   * - "force-react": Always direct ReAct (skip routing + plan).
   *
   * Default: "auto".
   */
  routing?: "auto" | "force-plan" | "force-react";

  // ── Plan ────────────────────────────────────────────────────────────

  /**
   * When to ask for user confirmation of the plan:
   * - "never":  Execute immediately after plan generation.
   * - "always": Always ask before executing.
   * - "auto":   Ask only when risky tool calls are detected in the plan.
   *
   * Default: "auto".
   */
  planConfirmation?: "auto" | "always" | "never";

  /**
   * Callback invoked when plan confirmation is needed.
   * Return `true` to approve the plan, `false` to abort.
   *
   * If not set and confirmation is needed, the plan is returned as-is
   * (no execution).
   */
  onPlanConfirm?: PlanConfirmCallback;

  /** Maximum number of steps in a plan (default: 12). */
  maxPlanSteps?: number;

  // ── Reflection ──────────────────────────────────────────────────────

  /**
   * Error reflection mode:
   * - "off":       No reflection.
   * - "post-hoc":  After execution, fork a ReflectionAgent to review
   *                the session and persist findings to the ErrorNotebook.
   *
   * Default: "off".
   */
  reflection?: "off" | "post-hoc";

  /** Max iterations for the reflection sub-agent. Default: 6. */
  reflectionMaxIterations?: number;

  // ── Loop control ────────────────────────────────────────────────────

  /** Maximum iterations for the execution loop (default: 15). */
  maxIterations?: number;

  /**
   * Number of consecutive tool failures before a replan hint is injected.
   * Set to 0 to disable auto-replanning hints. Default: 2.
   */
  replanThreshold?: number;

  // ── Memory Reflection ───────────────────────────────────────────────

  /** Memory reflection mode. Default: "off". */
  memoryReflection?: "off" | "post-hoc";

  /** Max iterations for the memory reflection sub-agent. Default: 5. */
  memoryReflectionMaxIterations?: number;
}

// ─── FusionAgent ──────────────────────────────────────────────────────────

/**
 * Fusion Agent that dynamically combines ReAct, Plan-and-Solve, and
 * Reflection paradigms based on task complexity.
 *
 * ## Execution flow:
 * ```
 * User Input
 *   ↓
 * [1. Route]    LLM judges complexity → simple / complex
 *   ↓
 * ├─ simple ──→ [3. ReAct Execute Loop]
 * │
 * └─ complex → [2. Plan]  LLM creates step-by-step plan
 *                 ↓
 *               [Confirm?]  Optional user approval
 *                 ↓
 *               [3. ReAct Execute Loop]  With plan tracking
 *   ↓
 * [4. Reflect]  off | post-hoc
 *   ↓
 * Final Answer
 * ```
 *
 * ## Session persistence
 * When `enableCheckpointing` is set, the agent auto-saves checkpoints
 * that include full fusion state (complexity, plan, reflection progress)
 * so the session can be resumed after a network interruption.
 */
export class FusionAgent extends Agent {
  // ── Configuration ───────────────────────────────────────────────────

  private routing: "auto" | "force-plan" | "force-react";
  private planConfirmation: "auto" | "always" | "never";
  private onPlanConfirm?: PlanConfirmCallback;
  private maxPlanSteps: number;

  private maxIterations: number;
  private replanThreshold: number;
  private memoryReflectionMode: "off" | "post-hoc";
  private memoryReflectionMaxIterations: number;

  // ── Runtime state ───────────────────────────────────────────────────

  /** Task complexity determined during routing. */
  private complexity: "simple" | "complex" = "complex";
  /** Whether routing has been completed. */
  private routed = false;
  /** The current plan steps (empty until the plan is created). */
  private currentPlan: string[] = [];
  /** Whether a plan has been created in this run. */
  private hasPlan = false;
  /** How many plan steps have been completed. */
  private completedSteps = 0;
  /** Consecutive tool failures (resets on success). */
  private consecutiveFailures = 0;
  /** Internal flag: when true, run() skips state reset (used by resume()). */
  private _skipStateReset = false;

  /** Routing reason for logging. */
  private routeReason = "";

  constructor(config: FusionAgentConfig) {
    const mergedConfig: FusionAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_FUSION_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.routing = config.routing ?? "auto";
    this.planConfirmation = config.planConfirmation ?? "always";
    this.onPlanConfirm = config.onPlanConfirm;
    this.maxPlanSteps = config.maxPlanSteps ?? 12;
    this.maxIterations = config.maxIterations ?? 15;
    this.replanThreshold = config.replanThreshold ?? 2;
    this.memoryReflectionMode = config.memoryReflection ?? "off";
    this.memoryReflectionMaxIterations = config.memoryReflectionMaxIterations ?? 5;

    this.rebuildSystemPrompt();
  }

  // ─── Main Entry Point ───────────────────────────────────────────────

  async run(input: string): Promise<string> {
    // Consume the skip-reset flag immediately
    const skipStateReset = this._skipStateReset;
    this._skipStateReset = false;

    // ── Pre-flight: reject oversized input ───────────────────────────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

    // ── Create fresh abort controller for this run ───────────────────
    this._abortController = new AbortController();

    // ── Async initialization ─────────────────────────────────────────
    await this.init();

    // ── Reload dynamic resources ─────────────────────────────────────
    await this.reloadDynamicResources();

    // ── Recover orphaned sub-agent results ───────────────────────────
    this.recoverOrphanedSubAgentResults();

    // ── Intent detection (zero LLM cost, runs once per run) ────────
    this.detectInputSignals(input);
    this.matchInputContext(input);

    // ── Create user message ──────────────────────────────────────────
    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    // ── Reset runtime state for this run ─────────────────────────────
    if (!skipStateReset) {
      this.complexity = "complex";
      this.routed = false;
      this.routeReason = "";
      this.currentPlan = [];
      this.hasPlan = false;
      this.completedSteps = 0;
      this.consecutiveFailures = 0;
    }

    // Save initial checkpoint
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // ── Phase 1: Route ───────────────────────────────────────────────
    if (this.routing === "auto") {
      const routeResult = await this.route(input);
      this.complexity = routeResult.complexity;
      this.routeReason = routeResult.reason;
      this.routed = true;

      this.logger.info(
        "Fusion",
        `Route: ${this.complexity} — ${this.routeReason}`,
      );
    } else if (this.routing === "force-react") {
      this.complexity = "simple";
      this.routed = true;
      this.logger.info("Fusion", "Route: simple (forced)");
    } else {
      // force-plan
      this.complexity = "complex";
      this.routed = true;
      this.logger.info("Fusion", "Route: complex (forced)");
    }

    // Save checkpoint after routing
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // ── Phase 2: Plan (complex tasks only) ────────────────────────────
    if (this.complexity === "complex") {
      const planResult = await this.createPlan(input);
      if (typeof planResult === "string") {
        // planResult is a string → plan was aborted / returned as answer
        this.fireOnFinish(planResult);
        return planResult;
      }
      // planResult is string[] → plan was confirmed, continue
      this.currentPlan = planResult;
      this.hasPlan = true;
      for (const h of this.hooks) h.onPlanCreated?.(this.currentPlan);

      // Save checkpoint after plan creation
      if (this.checkpointingEnabled) {
        this.saveCheckpoint("active");
      }
    }

    // ── Phase 3: ReAct Execute Loop ───────────────────────────────────
    let answer = await this.executeReActLoop();

    // ── Phase 7: Memory Reflection ────────────────────────────────────
    const FAILURE_THRESHOLD = 2;
    const shouldReflectMemory =
      this.memoryReflectionMode === "post-hoc" ||
      (this.memoryReflectionMode !== "off" &&
        this.consecutiveFailures >= FAILURE_THRESHOLD) ||
      this.inputSignals.wantsRemember;
    if (shouldReflectMemory) {
      this.trackBackground(this.runMemoryReflection(input, answer)).catch((err: unknown) =>
        this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    this.fireOnFinish(answer);
    return answer;
  }

  // ─── Phase 1: Route (Complexity Classification) ─────────────────────

  /**
   * Ask the LLM to classify the task complexity.
   *
   * Sends a lightweight prompt separate from the main conversation so
   * the routing doesn't pollute the execution context.
   */
  private async route(
    input: string,
  ): Promise<{ complexity: "simple" | "complex"; reason: string }> {
    const messages = [
      { role: Role.System, content: FUSION_ROUTE_INSTRUCTIONS },
      { role: Role.User, content: input },
    ];

    try {
      const response = await (this.routeLLM ?? this.llm).chat(messages, [], this._abortController?.signal);
      const parsed = parseFusionRouteResponse(response.content);

      // Record token usage
      if (response.usage) {
        this.tokenBudget?.recordUsage(
          response.usage.prompt_tokens,
          response.usage.completion_tokens,
        );
      }

      return parsed;
    } catch (err: unknown) {
      if (err instanceof LLMNetworkError) {
        this.logger.warn(
          "Fusion",
          `Route LLM call failed: ${err.message}. Defaulting to complex.`,
        );
      }
      // Default to complex for safety
      return {
        complexity: "complex",
        reason: "Route classification failed; defaulting to complex to be safe.",
      };
    }
  }

  // ─── Phase 2: Plan (Plan Generation) ────────────────────────────────

  /**
   * Generate a plan for a complex task.
   *
   * Sends the user input to the LLM with plan-generation instructions.
   * If plan confirmation is configured, asks the user before proceeding.
   *
   * @returns The plan steps (string[]), or the plan text if confirmation
   *          was denied (returned as the final answer string).
   */
  private async createPlan(input: string): Promise<string[] | string> {
    // Rebuild system prompt with plan-generation context
    const planPrompt =
      this.buildSystemPrompt() +
      "\n\nYou are in the PLANNING phase. Analyze the user's request and create a detailed, " +
      "step-by-step plan. Output ONLY: {\"thought\": \"...\", \"plan\": [\"Step 1: ...\", ...]}\n" +
      `Maximum ${this.maxPlanSteps} steps. Each step must be concrete and actionable.`;

    this.contextManager.setSystemMessage(planPrompt);

    const contextMessages = this.contextManager.getContextMessages();

    // Token budget check
    const estimatedInput = this.contextManager.getCurrentTokens();
    const budgetError = this.checkTokenBudget(estimatedInput);
    if (budgetError) return budgetError;

    for (const h of this.hooks) h.onLLMStart?.(
      contextMessages,
      this.toolRegistry.getTools(),
    );

    let response: LLMResponse;
    try {
      // The planning phase should NOT have access to tools — the LLM is
      // supposed to generate a plan, not execute actions.  Passing tools
      // can cause the model (especially weaker ones) to emit tool_calls
      // that are never executed, producing orphaned tool_calls in context
      // that break subsequent API calls.
      response = await this.llm.chat(
        contextMessages,
        [],
        this._abortController?.signal,
      );
    } catch (err: unknown) {
      // Cancellation by user (AbortController)
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
        return this.handleNetworkError(err, 0, "continue creating a plan");
      }
      throw err;
    }

    for (const h of this.hooks) h.onLLMEnd?.(response);

    if (response.usage) {
      this.tokenBudget?.recordUsage(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      );
    }

    const parsed = parseFusionResponse(response.content);

    // Store the assistant message in context.
    // Deliberately strip tool_calls — the planning phase passes no tools
    // to the LLM, but some providers may still hallucinate tool_calls.
    // Orphaned tool_calls in context would break subsequent API calls
    // (which require every tool_call to have a matching tool result).
    const assistantMessage = Message.assistant(response.content);
    this.contextManager.addMessage(assistantMessage.toDict());

    if (parsed.plan && parsed.plan.length > 0) {
      const plan = parsed.plan.slice(0, this.maxPlanSteps);

      this.logger.info("Plan", `Created ${plan.length}-step plan:`);
      for (let i = 0; i < plan.length; i++) {
        this.logger.info("Plan", `  ${i + 1}. ${plan[i]}`);
      }

      // ── Plan confirmation ──────────────────────────────────────────
      const shouldConfirm = this.shouldConfirmPlan(plan);
      if (shouldConfirm && this.onPlanConfirm) {
        const confirmed = await this.confirmPlanWithTimeout(plan);
        if (!confirmed) {
          // User rejected the plan — return it as the answer
          const planText =
            `I've created the following plan for your task. ` +
            `Please review and let me know if you'd like any changes:\n\n` +
            plan.map((s, i) => `${i + 1}. ${s}`).join("\n") +
            `\n\nYou can resume execution by saying "proceed" or "execute the plan".`;
          return planText;
        }
      } else if (shouldConfirm && !this.onPlanConfirm) {
        // Confirmation needed but no callback — return plan as answer
        const planText =
          `I've created the following plan for your task:\n\n` +
          plan.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          `\n\n(Plan confirmation is required but no confirmation callback is configured. ` +
          `Send your approval to continue, or set planConfirmation to "never" to auto-execute.)`;
        return planText;
      }

      if (parsed.thought) {
        this.logger.info("Thought", parsed.thought);
        for (const h of this.hooks) h.onThought?.(parsed.thought);
      }

      return plan;
    }

    // LLM didn't generate a plan — fall back to ReAct
    this.logger.info(
      "Fusion",
      "No plan generated by LLM — falling back to direct ReAct.",
    );
    this.complexity = "simple";
    return [];
  }

  /**
   * Determine whether plan confirmation is needed based on the
   * planConfirmation setting and plan content.
   */
  private shouldConfirmPlan(_plan: string[]): boolean {
    switch (this.planConfirmation) {
      case "always":
        return true;
      case "never":
        return false;
      case "auto":
        // Auto: only confirm for genuinely destructive operations.
        // Low-risk ops (deploy, migrate, reset) are routine and
        // shouldn't interrupt the user every time.
        return planHasRiskyOps(_plan) === "high";
      default:
        return false;
    }
  }

  /**
   * Call the plan confirmation callback with a timeout, so the agent
   * never hangs indefinitely waiting for human review.
   *
   * Uses the same {@link approvalTimeoutMs} / {@link approvalTimeoutStrategy}
   * config inherited from {@link AgentConfig}.
   */
  private async confirmPlanWithTimeout(plan: string[]): Promise<boolean> {
    const signal = (this as any)._abortController?.signal as AbortSignal | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const result = await Promise.race([
        this.onPlanConfirm!(plan, this.routeReason),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), (this as any).approvalTimeoutMs ?? 120_000);
        }),
        new Promise<"cancelled">((resolve) => {
          if (signal?.aborted) {
            resolve("cancelled");
            return;
          }
          onAbort = () => resolve("cancelled");
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);

      if (result === "timeout") {
        this.logger.warn(
          "Fusion",
          `Plan confirmation timed out (${(this as any).approvalTimeoutMs ?? 120_000}ms) — ` +
          `showing plan for manual review.`,
        );
        return false;
      }

      if (result === "cancelled") {
        this.logger.info("Fusion", "Plan confirmation cancelled (agent aborted).");
        return false;
      }

      return result;
    } catch {
      this.logger.warn("Fusion", "Plan confirmation callback threw — showing plan for review.");
      return false;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  }

  // ─── Phase 3: ReAct Execute Loop ────────────────────────────────────

  /**
   * Main execution loop with ReAct reasoning, plan tracking, and optional
   * inline reflection.
   */
  private async executeReActLoop(): Promise<string> {
    // Rebuild system prompt for execution mode
    this.rebuildContextWithPlan();

    let consecutiveEmptyIterations = 0;
    const EMPTY_ITERATION_LIMIT = 5;

    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Fresh AbortController per iteration so the signal's listener
      // count doesn't accumulate across LLM calls and retries.
      this._abortController = new AbortController();

      // ── Check cancellation ──────────────────────────────────────────
      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        const cancelMsg =
          `Execution cancelled by user. Session "${sid}" preserved — ` +
          `resume with agent.resume("${sid}", "<your prompt>").`;
        return cancelMsg;
      }

      // ── Poll sub-agent results ──────────────────────────────────────
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const source = `subagent:${r.name}`;
        const msg = new Message(Role.User, wrapAndScan(source, r.output), {
          name: source,
        });
        this.contextManager.addMessage(msg.toDict());
      }

      await this.checkAndCompress();

      // ── Rebuild system prompt (plan progress + replan hint) ─────────
      this.rebuildContextWithPlan();

      // ── Token budget ────────────────────────────────────────────────
      const contextMessages = this.contextManager.getContextMessages();
      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) return budgetError;

      // ── LLM call ────────────────────────────────────────────────────
      for (const h of this.hooks) h.onLLMStart?.(
        contextMessages,
        this.toolRegistry.getTools(),
      );

      let response: LLMResponse;
      try {
        response = await this.llm.chat(
          contextMessages,
          this.toolRegistry.getTools(),
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
          return this.handleNetworkError(
            err,
            iteration + 1,
            "continue with what you were doing",
          );
        }
        throw err;
      }

      for (const h of this.hooks) h.onLLMEnd?.(response);

      if (response.usage) {
        this.tokenBudget?.recordUsage(
          response.usage.prompt_tokens,
          response.usage.completion_tokens,
        );
      }

      const parsed = parseFusionResponse(response.content);


      // ── Store assistant message ─────────────────────────────────────
      const assistantMessage = Message.assistant(
        response.content,
        response.tool_calls,
      );

      // ── Handle max_tokens truncation ────────────────────────────────
      const isTruncated =
        response.responseError?.code === LLMResponseErrorCode.MAX_TOKENS;

      if (isTruncated) {
        consecutiveTruncations++;
        if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
          const fallback = parsed.answer
            ? parsed.answer +
              "\n\n[Note: Response may be incomplete due to repeated output limits.]"
            : "I apologize, but I'm unable to complete this response due to output length constraints. " +
              "Please try breaking your request into smaller steps.";
          return fallback;
        }

        // Store the truncated message so the LLM has context for where it
        // left off. The continuation instruction is injected AFTER tool
        // execution (if any) so it does not break the tool_use/tool_result
        // pairing required by the Anthropic API.
        this.contextManager.addMessage(assistantMessage.toDict());
      } else {
        this.contextManager.addMessage(assistantMessage.toDict());
        consecutiveTruncations = 0;
      }

      // ── Tool calls ──────────────────────────────────────────────────
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

        // Non-truncation quality issues
        if (
          response.responseError &&
          response.responseError.code !== LLMResponseErrorCode.MAX_TOKENS &&
          response.responseError.code !== LLMResponseErrorCode.OK
        ) {
          const warnMsg = Message.system(
            `LLM response quality issue: ${response.responseError.message}`,
          );
          this.contextManager.addMessage(warnMsg.toDict());
        }

        const mcpWarnedServers = new Set<string>();
        const { hadFailure, hadSpawnCalls } = await this.executeToolCallsBatch(
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
              "Continue exactly where you left off — do NOT repeat any content already written.",
          );
          this.contextManager.addMessage(continueMsg.toDict());
        }

        // Update failure counter and step progress
        if (hadFailure) {
          this.consecutiveFailures++;
          this.logger.info(
            "Fusion",
            `Consecutive failures: ${this.consecutiveFailures}` +
              (this.replanThreshold > 0 &&
              this.consecutiveFailures >= this.replanThreshold
                ? ` — threshold reached`
                : ""),
          );

        } else {
          this.consecutiveFailures = 0;

          // Advance completed steps
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

        // Save checkpoint
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("active");
        }

        // Opportunistic fast wait for sub-agent results.
        await this.collectFastSubAgentResults(hadSpawnCalls);

        continue;
      }

      // ── Final answer ────────────────────────────────────────────────
      if (parsed.answer) {
        if (isTruncated) {
          consecutiveEmptyIterations = 0;
          if (parsed.thought) {
            this.logger.info("Thought", parsed.thought);
            for (const h of this.hooks) h.onThought?.(parsed.thought);
          }
          if (iteration === this.maxIterations - 1) {
            return (
              parsed.answer +
              "\n\n[Note: Response may be incomplete due to output length constraints.]"
            );
          }
          // Inject continuation instruction so the LLM knows to complete
          // its truncated response (no tool calls were present).
          const continueMsg = Message.user(
            "Your previous response was cut off (max output tokens reached). " +
              "Continue exactly where you left off — do NOT repeat any content already written.",
          );
          this.contextManager.addMessage(continueMsg.toDict());
          this.logger.info(
            "Fusion",
            "Answer truncated — continuing in next iteration.",
          );
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

        this.logger.info("Fusion", "Task complete — returning final answer.");

        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        return parsed.answer;
      }

      // ── Plan creation (if LLM generates plan mid-execution) ─────────
      if (
        !this.hasPlan &&
        parsed.plan &&
        Array.isArray(parsed.plan) &&
        parsed.plan.length > 0
      ) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.plan.slice(0, this.maxPlanSteps);
        this.hasPlan = true;
        this.logger.info(
          "Plan",
          `Created ${this.currentPlan.length}-step plan mid-execution:`,
        );
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

      // ── Plan revision ───────────────────────────────────────────────
      if (
        parsed.revised_plan &&
        Array.isArray(parsed.revised_plan) &&
        parsed.revised_plan.length > 0
      ) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.revised_plan.slice(0, this.maxPlanSteps);
        this.completedSteps = 0;
        this.consecutiveFailures = 0;
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

      // ── Thought-only iteration ──────────────────────────────────────
      if (parsed.thought) {
        consecutiveEmptyIterations++;
        this.logger.info("Thought", parsed.thought);
        for (const h of this.hooks) h.onThought?.(parsed.thought);

        if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
          const stuckMsg =
            "I apologize, but I'm having difficulty making progress on your request. " +
            "Please try rephrasing or breaking it down into smaller, more specific steps.";
          const stuckAssistantMessage = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckAssistantMessage.toDict());
          return stuckMsg;
        }

        continue;
      }

      // ── Empty response ──────────────────────────────────────────────
      consecutiveEmptyIterations++;
      if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
        const stuckMsg =
          "I apologize, but I'm having difficulty making progress on your request. " +
          "Please try rephrasing or breaking it down into smaller, more specific steps.";
        const stuckAssistantMessage = Message.assistant(stuckMsg);
        this.contextManager.addMessage(stuckAssistantMessage.toDict());
        return stuckMsg;
      }
    }

    // ── Max iterations reached ────────────────────────────────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    return timeoutMsg;
  }



  // ─── Memory Reflection ──────────────────────────────────────────────

  /**
   * Run post-hoc memory extraction after a successful completion.
   * Best-effort — failures are logged but never affect the answer.
   *
   * No guard for `skillsDir` is needed here:
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

  // ─── System Prompt Management ───────────────────────────────────────

  /**
   * Rebuild the system prompt to include plan progress and replan hints.
   *
   * Called each iteration so the LLM always sees the up-to-date state.
   */
  private rebuildContextWithPlan(): void {
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
    const replanHint = this.computeReplanHint();
    if (replanHint) {
      prompt += `\n\n${replanHint}`;
    }

    this.contextManager.setSystemMessage(prompt);
  }

  /**
   * Compute a replan hint based on consecutive failure count.
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

  // ─── Session Persistence ────────────────────────────────────────────

  /**
   * Agent type identifier for session metadata.
   */
  protected getAgentType(): "fusion" {
    return "fusion";
  }

  /**
   * Include fusion-specific state in session checkpoints.
   */
  protected buildBaseSessionState(status: SessionStatus): SessionState {
    const base = super.buildBaseSessionState(status);
    return {
      ...base,
      planState: undefined, // Clear PlanSolve state — fusion uses its own
      fusionState: {
        complexity: this.complexity,
        routeReason: this.routeReason,
        routed: this.routed,
        currentPlan: this.currentPlan,
        hasPlan: this.hasPlan,
        completedSteps: this.completedSteps,
        consecutiveFailures: this.consecutiveFailures,
      },
    };
  }

  /**
   * Restore fusion state from a saved session.
   */
  protected loadAndRestoreSession(sessionId: string): SessionState {
    const state = super.loadAndRestoreSession(sessionId);

    if (state.fusionState) {
      const fs = state.fusionState as FusionSessionState;
      this.complexity = fs.complexity;
      this.routeReason = fs.routeReason ?? "";
      this.routed = fs.routed;
      this.currentPlan = fs.currentPlan;
      this.hasPlan = fs.hasPlan;
      this.completedSteps = fs.completedSteps;
      this.consecutiveFailures = fs.consecutiveFailures;
    }

    return state;
  }

  // ─── Resume ─────────────────────────────────────────────────────────

  /**
   * Resume a previously interrupted session.
   *
   * Restores messages, system prompt, plan state, and fusion metadata
   * so the agent can continue from where it left off.
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
    this.matchInputContext(input);

    // Reset state
    this.currentPlan = [];
    this.hasPlan = false;
    this.consecutiveFailures = 0;
    this.completedSteps = 0;

    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());
    if (this.checkpointingEnabled) this.saveCheckpoint("active");

    // ── Phase 1: Route (non-streaming) ──────────────────────────────
    if (this.routing === "auto") {
      const routeResult = await this.route(input);
      this.complexity = routeResult.complexity;
      this.routeReason = routeResult.reason;
      this.routed = true;
      yield `[Route: ${routeResult.complexity} — ${routeResult.reason}]\n\n`;
    } else {
      this.complexity = this.routing === "force-react" ? "simple" : "complex";
      this.routed = true;
    }

    // ── Phase 2: Plan for complex tasks (non-streaming, no tools) ──
    if (this.complexity === "complex") {
      const planResult = await this.createPlan(input);
      if (typeof planResult === "string") { yield planResult; return; }
      if (planResult.length > 0) {
        this.currentPlan = planResult;
        this.hasPlan = true;
        const planText = "\n## Plan\n" + planResult.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n";
        yield planText;
        for (const h of this.hooks) h.onPlanCreated?.(planResult);
      }
    }

    // ── Phase 3: Streaming Execute Loop ─────────────────────────────
    this.rebuildContextWithPlan();

    let consecutiveEmptyIterations = 0;
    const EMPTY_ITERATION_LIMIT = 5;

    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    // Determine if memory reflection should run (mode + signals)
    let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
    if (this.inputSignals.wantsRemember) {
      shouldReflectMemory = true;
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      this._abortController = new AbortController();

      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        yield `\n\n[Cancelled. Session "${sid}" preserved.]`;
        return;
      }

      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const source = `subagent:${r.name}`;
        this.contextManager.addMessage(
          new Message(Role.User, wrapAndScan(source, r.output), { name: source }).toDict(),
        );
      }

      await this.checkAndCompress();
      this.rebuildContextWithPlan();

      const contextMessages = this.contextManager.getContextMessages();
      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) { yield budgetError; return; }

      for (const h of this.hooks) h.onLLMStart?.(contextMessages, this.toolRegistry.getTools());

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
          this.toolRegistry.getTools(),
          this._abortController?.signal,
        )) {
          if (event.type === "chunk") {
            if (event.content) {
              rawContent += event.content;
              const display = answerExtractor.feed(event.content);
              if (display) {
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

      const parsed = parseFusionResponse(rawContent);


      // ── Tool calls ────────────────────────────────────────────────
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
        const { hadFailure, hadSpawnCalls } = await this.executeToolCallsBatch(toolCalls, mcpWarnedServers);

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
        } else {
          this.consecutiveFailures = 0;
          if (parsed.currentStep && this.hasPlan) {
            this.completedSteps = Math.max(this.completedSteps, Math.min(parsed.currentStep - 1, this.currentPlan.length));
          } else if (this.hasPlan) {
            this.completedSteps = Math.min(this.completedSteps + 1, this.currentPlan.length);
          }
        }

        if (this.checkpointingEnabled) this.saveCheckpoint("active");

        // Opportunistic fast wait for sub-agent results.
        await this.collectFastSubAgentResults(hadSpawnCalls);

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

      // ── Final answer ──────────────────────────────────────────────
      if (parsed.answer) {
        if (parsed.thought) {
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        // ── Hold the answer while sub-agents are still running ──────
        if (iteration < this.maxIterations - 1 && this.holdAnswerForPendingSubAgents()) {
          yield "\n\n[Waiting for sub-agent results...]\n\n";
          continue;
        }

        this.logger.info("Fusion", "Task complete.");

        // Fallback: the envelope couldn't be streamed (no "answer" key
        // found — malformed JSON) — emit the parsed answer now.
        if (!answerExtractor.emitted) {
          yield parsed.answer;
        }

        const answer = parsed.answer;

        this.fireOnFinish(answer);
        if (this.checkpointingEnabled) this.saveCheckpoint("completed");

        // ── Memory reflection (fire-and-forget, post-hoc) ──────
        if (shouldReflectMemory) {
          this.trackBackground(this.runMemoryReflection(input, answer)).catch((err: unknown) =>
            this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        yield "\n\n[DONE]";
        return;
      }

      // ── Mid-execution plan ────────────────────────────────────────
      if (!this.hasPlan && parsed.plan && parsed.plan.length > 0) {
        consecutiveEmptyIterations = 0;
        this.currentPlan = parsed.plan.slice(0, this.maxPlanSteps);
        this.hasPlan = true;
        const planText = "\n## Plan\n" + this.currentPlan.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n";
        yield planText;
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
        for (const h of this.hooks) h.onPlanRevised?.(this.currentPlan);
        if (parsed.thought) {

          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        continue;
      }

      // ── Thought only ──────────────────────────────────────────────
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
    this._skipStateReset = true;
    return this.run(input);
  }
}
