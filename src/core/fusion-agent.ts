import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import {
  FUSION_ROUTE_INSTRUCTIONS,
  FUSION_EXECUTION_INSTRUCTIONS,
  INLINE_REFLECTION_PROMPT,
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
import { SessionState, SessionStatus } from "../session/session-types";
import type { FusionSessionState } from "../session/session-types";
import { ReflectionAgent } from "../reflection/reflection-agent";
import { ErrorNotebook } from "../reflection/error-notebook";

// ─── System Prompt ────────────────────────────────────────────────────────

const DEFAULT_FUSION_SYSTEM_PROMPT = `You are a helpful AI assistant powered by the Fusion Agent paradigm.
You dynamically adapt your strategy to the task's complexity.

For SIMPLE tasks: direct ReAct (Reasoning + Acting) loop.
For COMPLEX tasks: Plan → Execute → Reflect.

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
   * Reflection mode:
   * - "off":       No reflection.
   * - "post-hoc":  After execution, run ReflectionAgent to review the session.
   * - "inline":    Within the loop, pause every N steps to self-check.
   * - "both":      Inline + post-hoc.
   *
   * Default: "off".
   */
  reflection?: "off" | "post-hoc" | "inline" | "both";

  /**
   * How often (in iterations) to trigger inline reflection.
   * Also triggers on first tool failure in a run.
   * Default: 3.
   */
  reflectionInterval?: number;

  /**
   * ErrorNotebook instance for persisting reflection findings.
   * Required when reflection is "post-hoc" or "both".
   */
  notebook?: ErrorNotebook;

  // ── Loop control ────────────────────────────────────────────────────

  /** Maximum iterations for the execution loop (default: 15). */
  maxIterations?: number;

  /**
   * Number of consecutive tool failures before a replan hint is injected.
   * Set to 0 to disable auto-replanning hints. Default: 2.
   */
  replanThreshold?: number;

  // ── Precipitation ──────────────────────────────────────────────────

  /**
   * Skill precipitation. Runs after Phase 4 (Reflection).
   * Default: "off".
   */
  precipitation?: "off" | "post-hoc";

  /** Max iterations for the precipitation sub-agent. Default: 15. */
  precipitationMaxIterations?: number;
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
 * [4. Reflect]  off | post-hoc | inline | both
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
  private reflectionMode: "off" | "post-hoc" | "inline" | "both";
  private reflectionInterval: number;
  private notebook?: ErrorNotebook;
  private maxIterations: number;
  private replanThreshold: number;
  private precipitationMode: "off" | "post-hoc";
  private precipitationMaxIterations: number;

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
  /** How many inline reflections have been done in this run. */
  private inlineReflectionsDone = 0;
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
    this.planConfirmation = config.planConfirmation ?? "auto";
    this.onPlanConfirm = config.onPlanConfirm;
    this.maxPlanSteps = config.maxPlanSteps ?? 12;
    this.reflectionMode = config.reflection ?? "off";
    this.reflectionInterval = config.reflectionInterval ?? 3;
    this.notebook = config.notebook;
    this.maxIterations = config.maxIterations ?? 15;
    this.replanThreshold = config.replanThreshold ?? 2;
    this.precipitationMode = config.precipitation ?? "off";
    this.precipitationMaxIterations = config.precipitationMaxIterations ?? 15;

    // Validate: notebook required for post-hoc/both modes
    if (
      (this.reflectionMode === "post-hoc" || this.reflectionMode === "both") &&
      !this.notebook
    ) {
      throw new Error(
        "FusionAgent: 'notebook' (ErrorNotebook) is required when reflection is 'post-hoc' or 'both'.",
      );
    }

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
      this.inlineReflectionsDone = 0;
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
    const answer = await this.executeReActLoop();

    // ── Phase 4: Reflection (best-effort, non-blocking) ──────────────
    this.runReflection(input, answer).catch((err) =>
      this.logger.warn("Reflection", `Background reflection failed: ${err instanceof Error ? err.message : String(err)}`),
    );

    // ── Phase 5: Precipitation (skill extraction) ─────────────────────
    // Trigger on: post-hoc mode, or hard-won success (failures→success), or user intent
    const FAILURE_THRESHOLD = 2;
    const shouldPrecipitate =
      this.precipitationMode === "post-hoc" ||
      (this.precipitationMode !== "off" &&
        this.consecutiveFailures >= FAILURE_THRESHOLD) ||
      (this.precipitationMode !== "off" &&
        /remember|save (this|it)|记住|保存|記住|儲存|记录下来/i.test(input));
    if (shouldPrecipitate) {
      this.runPrecipitation(input, answer).catch((err) =>
        this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
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
      const response = await this.llm.chat(messages, [], this._abortController?.signal);
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

    // Store the assistant message in context
    const assistantMessage = Message.assistant(
      response.content,
      response.tool_calls,
    );
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
        // Auto: check if plan contains risky keywords
        // (deploy, delete, drop, migration, etc.)
        const riskyKeywords = [
          "deploy", "delete", "drop", "migrate", "truncate",
          "destroy", "purge", "reset", "format",
        ];
        const planText = _plan.join(" ").toLowerCase();
        return riskyKeywords.some((kw) => planText.includes(kw));
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

      // Capture LLM analysis of active tool error traces
      if (parsed.thought) {
        this.captureErrorAnalysis(parsed.thought);
      }

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
        const { hadFailure } = await this.executeToolCallsBatch(
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

          // Inline reflection on first failure if enabled
          if (
            (this.reflectionMode === "inline" ||
              this.reflectionMode === "both") &&
            this.inlineReflectionsDone === 0
          ) {
            await this.reflectInline(iteration);
          }
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

        // Inline reflection at regular intervals
        if (
          (this.reflectionMode === "inline" ||
            this.reflectionMode === "both") &&
          (iteration + 1) % this.reflectionInterval === 0
        ) {
          await this.reflectInline(iteration);
        }

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

  // ─── Phase 4: Reflection ────────────────────────────────────────────

  /**
   * Run the configured reflection strategy.
   */
  private async runReflection(
    input: string,
    answer: string,
  ): Promise<void> {
    if (this.reflectionMode === "off") return;

    // ── Post-hoc reflection ──────────────────────────────────────────
    if (
      this.reflectionMode === "post-hoc" ||
      this.reflectionMode === "both"
    ) {
      await this.reflectPostHoc(input, answer);
    }

    // Inline reflection is done during the loop — nothing extra here
  }

  /**
   * Inline reflection: pause execution and ask the LLM to self-check
   * its progress. Results are logged and injected into context.
   */
  private async reflectInline(iteration: number): Promise<void> {
    this.inlineReflectionsDone++;
    this.logger.info(
      "Reflection",
      `Inline reflection #${this.inlineReflectionsDone} at iteration ${iteration + 1}`,
    );

    const reflectionMsg = Message.user(INLINE_REFLECTION_PROMPT);
    this.contextManager.addMessage(reflectionMsg.toDict());

    // Do NOT call the LLM here — the reflection prompt is injected as a
    // user message and will be processed in the next iteration of the
    // main loop. This keeps the reflection lightweight and naturally
    // integrated into the flow.

    // Save checkpoint after inline reflection
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }
  }

  /**
   * Post-hoc reflection: after execution completes, run the
   * ReflectionAgent to review the full session.
   */
  private async reflectPostHoc(
    input: string,
    answer: string,
  ): Promise<void> {
    if (!this.notebook) return;

    this.logger.info("Reflection", "Starting post-hoc reflection...");

    try {
      const reflector = new ReflectionAgent({
        llm: this.llm,
        notebook: this.notebook,
      });

      const contextMessages = this.contextManager.getContextMessages();

      const entries = await reflector.reflect({
        userQuery: input,
        finalAnswer: answer,
        conversation: contextMessages,
        sessionId: this.sessionManager?.getSessionId() ?? "unknown",
      });

      if (entries.length > 0) {
        this.logger.info(
          "Reflection",
          `Post-hoc complete — ${entries.length} finding(s) written to notebook.`,
        );
        for (const entry of entries) {
          this.logger.info(
            "Reflection",
            `  [${entry.category}] ${entry.description}`,
          );
        }
      } else {
        this.logger.info("Reflection", "Post-hoc complete — no issues found.");
      }
    } catch (err: unknown) {
      this.logger.warn(
        "Reflection",
        `Post-hoc reflection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Phase 5: Precipitation ──────────────────────────────────────────

  /**
   * Run the configured skill precipitation strategy.
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
        llm: this.llm,
        sessionId: this.sessionManager?.getSessionId() ?? "unknown",
        maxIterations: this.precipitationMaxIterations,
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

    // Rebuild system prompt so new skills show up immediately
    if (this.skillManager.getAll().length > 0) {
      this.rebuildSystemPrompt();
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
        routed: this.routed,
        currentPlan: this.currentPlan,
        hasPlan: this.hasPlan,
        completedSteps: this.completedSteps,
        consecutiveFailures: this.consecutiveFailures,
        reflectionEnabled: this.reflectionMode !== "off",
        inlineReflectionsDone: this.inlineReflectionsDone,
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
      this.routed = fs.routed;
      this.currentPlan = fs.currentPlan;
      this.hasPlan = fs.hasPlan;
      this.completedSteps = fs.completedSteps;
      this.consecutiveFailures = fs.consecutiveFailures;
      this.inlineReflectionsDone = fs.inlineReflectionsDone;
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

    // Reset state
    this.currentPlan = [];
    this.hasPlan = false;
    this.consecutiveFailures = 0;
    this.completedSteps = 0;
    this.inlineReflectionsDone = 0;

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

    // Determine if precipitation should run (mode + signals)
    const FAILURE_THRESHOLD = 2;
    let shouldPrecipitate = this.precipitationMode === "post-hoc";
    if (this.precipitationMode !== "off" && /remember|save (this|it)|记住|保存|記住|儲存|记录下来/i.test(input)) {
      shouldPrecipitate = true;
      this.logger.info("Precipitation", "User intent to remember detected — will precipitate.");
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      this._abortController = new AbortController();

      if (this.isCancelled) {
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

      try {
        for await (const event of this.llm.chatStream(
          contextMessages,
          this.toolRegistry.getTools(),
          this._abortController?.signal,
        )) {
          if (event.type === "chunk") {
            if (event.content) {
              rawContent += event.content;
              // Stop yielding once [Answer] appears (duplicate content)
              if (!/\[Answer\]/i.test(rawContent)) {
                yield event.content;
                for (const h of this.hooks) h.onChunk?.(event.content);
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
          const sid = this.sessionManager?.getSessionId() ?? "unknown";
          yield `\n\n[Cancelled. Session "${sid}" preserved.]`;
          return;
        }
        if (err instanceof LLMNetworkError) {
          for (const h of this.hooks) h.onLLMError?.(err);
          yield `\n\n[Network error: ${err.message}]`;
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
        h.onLLMEnd?.({ content: rawContent, tool_calls: toolCalls, usage: streamUsage });
      }

      const parsed = parseFusionResponse(rawContent);
      if (parsed.thought) this.captureErrorAnalysis(parsed.thought);

      const assistantMessage = Message.assistant(rawContent, toolCalls.length > 0 ? toolCalls : undefined);
      this.contextManager.addMessage(assistantMessage.toDict());

      // ── Truncation → continue in next iteration ────────────────────
      if (isTruncated) {
        this.contextManager.addMessage(
          Message.user(
            "Your previous response was cut off (max output tokens reached). " +
            "Continue exactly where you left off — do NOT repeat any content already written."
          ).toDict(),
        );
        continue;
      }

      // ── Tool calls ────────────────────────────────────────────────
      if (toolCalls.length > 0) {
        consecutiveEmptyIterations = 0;
        if (parsed.thought) {
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        const mcpWarnedServers = new Set<string>();
        const { hadFailure } = await this.executeToolCallsBatch(toolCalls, mcpWarnedServers);

        if (hadFailure) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= FAILURE_THRESHOLD
              && this.precipitationMode !== "off") {
            shouldPrecipitate = true;
          }
          if (
            (this.reflectionMode === "inline" || this.reflectionMode === "both") &&
            this.inlineReflectionsDone === 0
          ) {
            await this.reflectInline(iteration);
          }
        } else {
          this.consecutiveFailures = 0;
          if (parsed.currentStep && this.hasPlan) {
            this.completedSteps = Math.max(this.completedSteps, Math.min(parsed.currentStep - 1, this.currentPlan.length));
          } else if (this.hasPlan) {
            this.completedSteps = Math.min(this.completedSteps + 1, this.currentPlan.length);
          }
        }

        if (
          (this.reflectionMode === "inline" || this.reflectionMode === "both") &&
          (iteration + 1) % this.reflectionInterval === 0
        ) {
          await this.reflectInline(iteration);
        }

        if (this.checkpointingEnabled) this.saveCheckpoint("active");
        continue;
      }

      // ── Final answer ──────────────────────────────────────────────
      if (parsed.answer) {
        if (parsed.thought) {
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }
        this.logger.info("Fusion", "Task complete.");
        this.fireOnFinish(parsed.answer);
        if (this.checkpointingEnabled) this.saveCheckpoint("completed");

        if (shouldPrecipitate) {
          this.runPrecipitation(input, parsed.answer).catch((err) =>
            this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

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
