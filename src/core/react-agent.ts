import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import {
  STRUCTURED_OUTPUT_INSTRUCTIONS,
  parseReActResponse,
} from "./response-schema";
import { SECURITY_GUIDANCE, TOOL_ERROR_RECOVERY } from "./system-prompts";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse, LLMResponseErrorCode } from "../llm/interface";
import { wrapAndScan } from "../security/boundaries";


/**
 * Default system prompt for ReAct-style reasoning.
 * Explains the tool-use loop without requiring JSON format.
 */
const DEFAULT_REACT_SYSTEM_PROMPT = `You are a helpful AI assistant powered by a ReAct (Reasoning + Acting) loop.
You have access to a set of tools you can use to answer the user's question.

Follow this process:
1. Think step by step about what the user needs.
2. Decide whether to use a tool or give the final answer.
3. If using a tool, call it with the correct parameters.
4. Observe the result and decide the next step.
5. Repeat until you have the complete answer.

If no tools are needed, respond with the final answer directly.
Always think step by step before acting.
${SECURITY_GUIDANCE}
${TOOL_ERROR_RECOVERY}${STRUCTURED_OUTPUT_INSTRUCTIONS}`;

/**
 * Configuration specific to the ReAct Agent.
 */
export interface ReActAgentConfig extends AgentConfig {
  /** Maximum iterations for the ReAct loop (default: 10). */
  maxIterations?: number;

  /** Skill precipitation mode. Default: "off". */
  precipitation?: "off" | "post-hoc";

  /** Max iterations for the precipitation sub-agent. Default: 15. */
  precipitationMaxIterations?: number;

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
 * ReAct Agent implementing a Thought → Action → Observation → Final Answer loop.
 *
 * The agent uses `tool_calls` as the sole signal for loop control:
 * - Has tool_calls → execute tools, continue loop
 * - No tool_calls → response content IS the final answer
 *
 * Compatible with any model that supports native function calling
 * (GPT-4, Claude, DeepSeek, etc.). No JSON output format required.
 *
 * Session persistence:
 * When `enableCheckpointing` is set, the agent auto-saves checkpoints after
 * each LLM+tools cycle. On network error, an `interrupted` checkpoint is
 * saved so the user can resume later via `agent.resume(sessionId, input)`.
 */
export class ReActAgent extends Agent {
  private maxIterations: number;
  private precipitationMode: "off" | "post-hoc";
  private precipitationMaxIterations: number;
  private memoryReflectionMode: "off" | "post-hoc";
  private memoryReflectionMaxIterations: number;
  private reflectionMode: "off" | "post-hoc";
  private reflectionMaxIterations: number;

  constructor(config: ReActAgentConfig) {
    const mergedConfig: ReActAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_REACT_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxIterations = config.maxIterations ?? 10;
    this.precipitationMode = config.precipitation ?? "off";
    this.precipitationMaxIterations = config.precipitationMaxIterations ?? 15;
    this.memoryReflectionMode = config.memoryReflection ?? "off";
    this.memoryReflectionMaxIterations = config.memoryReflectionMaxIterations ?? 5;
    this.reflectionMode = config.reflection ?? "off";
    this.reflectionMaxIterations = config.reflectionMaxIterations ?? 6;

    // Build the full system prompt once all sections are ready
    this.rebuildSystemPrompt();
  }

  async run(input: string): Promise<string> {
    // ── Pre-flight: reject oversized input before any setup ───────────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

    // ── Async initialization (MCP connections, sub-agents, etc.) ────────
    await this.init();

    // ── Reload dynamic resources (preferences, skills, MCP) ─────────
    await this.reloadDynamicResources();

    // ── Intent detection (zero LLM cost, runs once per run) ────────
    // Skip for fork / minimal agents that have no side-effect tools
    // (remember, recall, skill) — intents are only actionable by the
    // main agent which can trigger precipitation & memory reflection.
    if (!this.skipAutoTools) {
      this.detectInputSignals(input);
      this.matchInputSkills(input);
    }

    // ── Recover orphaned sub-agent results from a cancelled session ──
    this.recoverOrphanedSubAgentResults();

    // ── Create user message ──────────────────────────────────────────
    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    // Save initial checkpoint (captures user input before any LLM call)
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // Track consecutive empty/short responses (safety valve)
    let consecutiveEmptyResponses = 0;
    const MAX_EMPTY_RESPONSES = 3;

    // Track consecutive max_tokens truncations (to avoid infinite continuation loops)
    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    // Track tool failures → trigger precipitation on hard-won success
    let consecutiveFailures = 0;
    const FAILURE_PRECIPITATE_THRESHOLD = 2;

    // Determine if precipitation should run (mode + signals)
    let shouldPrecipitate = this.precipitationMode === "post-hoc";
    let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
    // User explicitly asked to remember — override mode config
    if (this.inputSignals.wantsRemember) {
      shouldPrecipitate = true;
      shouldReflectMemory = true;
    }

    // Determine if error reflection should run
    const shouldReflect = this.reflectionMode === "post-hoc";

    // ── ReAct loop ────────────────────────────────────────────────────
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      this.logger.info(this.agentName === "main" ? "ReAct" : `ReAct:${this.agentName}`, `Iteration ${iteration + 1}/${this.maxIterations}`);
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

      // Check and compress after sub-agent results are in
      await this.checkAndCompress();

      // Prepare messages for the LLM
      const contextMessages = this.contextManager.getContextMessages();

      // Token budget check — skip token counting when no budget is configured
      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) {
        this.fireOnFinish(budgetError);
        return budgetError;
      }

      // Call the LLM with all registered tools
      for (const h of this.hooks) h.onLLMStart?.(contextMessages, this.toolRegistry.getTools());
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
          return this.handleNetworkError(err, iteration + 1, "continue with my previous request");
        }
        throw err; // Unknown error — propagate
      }
      for (const h of this.hooks) h.onLLMEnd?.(response);

      // Record token usage against the session budget
      if (response.usage) {
        this.tokenBudget?.recordUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      // Parse the response content (for logging / error analysis)
      const rawContent = response.content;
      const parsed = parseReActResponse(response.content);

      // Capture LLM analysis of any active tool error traces
      if (parsed.thought) {
        this.captureErrorAnalysis(parsed.thought);
      }

      // Create assistant message from the response
      const assistantMessage = Message.assistant(
        rawContent,
        response.tool_calls,
      );

      // ── Handle max_tokens truncation ───────────────────────────────
      const isTruncated = response.responseError?.code === LLMResponseErrorCode.MAX_TOKENS;
      if (isTruncated) {
        consecutiveTruncations++;
        if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
          // Bail out — too many consecutive truncations, return what we have.
          // Don't add the truncated message to context; it's incomplete junk.
          const fallback = ("answer" in parsed && parsed.answer)
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

      const toolCalls = response.tool_calls ?? [];

      // ── Tool calls → still executing, loop back after running tools ──
      if (toolCalls.length > 0) {
        // Log reasoning if present
        if (parsed.thought) {
          this.logger.info("Thought", parsed.thought);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }

        // If the LLM response shows non-truncation quality issues, warn
        if (response.responseError &&
            response.responseError.code !== LLMResponseErrorCode.MAX_TOKENS &&
            response.responseError.code !== LLMResponseErrorCode.OK) {
          const warnMsg = Message.system(
            `LLM response quality issue: ${response.responseError.message}`
          );
          this.contextManager.addMessage(warnMsg.toDict());
        }

        const mcpWarnedServers = new Set<string>();
        const { hadFailure } = await this.executeToolCallsBatch(toolCalls, mcpWarnedServers);
        if (hadFailure) {
          consecutiveFailures++;
          if (consecutiveFailures >= FAILURE_PRECIPITATE_THRESHOLD
              && this.precipitationMode !== "off") {
            shouldPrecipitate = true;
          }
        } else {
          consecutiveFailures = 0;
          consecutiveEmptyResponses = 0;
        }

        // Inject continuation AFTER tool execution (Anthropic API pairing)
        if (isTruncated) {
          const continueMsg = Message.user(
            "Your previous response was cut off (max output tokens reached). " +
            "Continue exactly where you left off — do NOT repeat any content already written."
          );
          this.contextManager.addMessage(continueMsg.toDict());
        }

        if (this.checkpointingEnabled) {
          this.saveCheckpoint("active");
        }

        continue;
      }

      // ── No tool calls → this IS the final answer ────────────────────
      // Prefer explicit answer field (legacy JSON), fall back to raw content.
      const answer = parsed.answer || rawContent;

      // If truncated, don't return yet — inject continuation
      if (isTruncated) {
        if (iteration === this.maxIterations - 1) {
          const fallback = answer +
            "\n\n[Note: Response may be incomplete due to output length constraints.]";
          this.fireOnFinish(fallback);
          return fallback;
        }
        const continueMsg = Message.user(
          "Your previous response was cut off (max output tokens reached). " +
          "Continue exactly where you left off — do NOT repeat any content already written."
        );
        this.contextManager.addMessage(continueMsg.toDict());
        this.logger.info("ReAct", "Answer truncated (max_tokens) — continuing in next iteration.");
        continue;
      }

      // Check for empty / extremely short response (safety valve)
      if (!rawContent || rawContent.trim().length < 5) {
        consecutiveEmptyResponses++;
        if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
          const stuckMsg =
            "I apologize, but I'm having difficulty responding. " +
            "Please try rephrasing your request.";
          const stuckMsgObj = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckMsgObj.toDict());
          this.fireOnFinish(stuckMsg);
          return stuckMsg;
        }
        continue;
      }

      // Normal answer — return content
      this.logger.info("Answer", answer);

      // ── Answer verification (blocking, runs before returning) ──────
      let verifiedAnswer = answer;
      if (this.verificationMode === "post-hoc") {
        try {
          verifiedAnswer = await this.runVerification(input, answer);
        } catch (err: unknown) {
          this.logger.warn(
            "Verification",
            `Verification failed: ${err instanceof Error ? err.message : String(err)} — returning original answer.`,
          );
        }
      }

      this.fireOnFinish(verifiedAnswer);
      if (this.checkpointingEnabled) this.saveCheckpoint("completed");

      // ── Skill precipitation (fire-and-forget, post-hoc) ─────────
      if (shouldPrecipitate) {
        this.runPrecipitation(input, verifiedAnswer).catch((err: unknown) =>
          this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      // ── Memory reflection (fire-and-forget, post-hoc) ────────────
      if (shouldReflectMemory) {
        this.runMemoryReflection(input, verifiedAnswer).catch((err: unknown) =>
          this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      // ── Error reflection (fire-and-forget, post-hoc) ───────────────
      if (shouldReflect) {
        this.runReflection(input, verifiedAnswer).catch((err: unknown) =>
          this.logger.warn("Reflection", `Background reflection failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      return verifiedAnswer;
    }

    // ── Max iterations reached without final answer ───────────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    this.fireOnFinish(timeoutMsg);
    return timeoutMsg;
  }

  // ─── Streaming ────────────────────────────────────────────────────────

  protected async *executeStream(input: string): AsyncIterable<string> {
    const sizeError = this.validateInputSize(input);
    if (sizeError) { yield sizeError; return; }

    await this.init();
    await this.reloadDynamicResources();

    // ── Intent detection (zero LLM cost, runs once per run) ────────
    // Skip for fork / minimal agents — same rationale as run().
    if (!this.skipAutoTools) {
      this.detectInputSignals(input);
      this.matchInputSkills(input);
    }

    this.recoverOrphanedSubAgentResults();

    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    if (this.checkpointingEnabled) this.saveCheckpoint("active");

    // Track consecutive empty/short responses (safety valve)
    let consecutiveEmptyResponses = 0;
    const MAX_EMPTY_RESPONSES = 3;

    // Track consecutive max_tokens truncations (to avoid infinite continuation loops)
    let consecutiveTruncations = 0;
    const MAX_TRUNCATION_CONTINUES = 3;

    // Track tool failures → trigger precipitation on hard-won success
    let consecutiveFailures = 0;
    const FAILURE_PRECIPITATE_THRESHOLD = 2;

    // Determine if precipitation should run (mode + signals)
    let shouldPrecipitate = this.precipitationMode === "post-hoc";
    let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
    // User explicitly asked to remember — override mode config
    if (this.inputSignals.wantsRemember) {
      shouldPrecipitate = true;
      shouldReflectMemory = true;
    }

    // Determine if error reflection should run
    const shouldReflect = this.reflectionMode === "post-hoc";

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      this.logger.info(this.agentName === "main" ? "ReAct" : `ReAct:${this.agentName}`, `Iteration ${iteration + 1}/${this.maxIterations}`);
      this._abortController = new AbortController();

      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        yield `\n\n[Cancelled. Session "${sid}" preserved.]`;
        return;
      }

      // Poll sub-agent results
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const source = `subagent:${r.name}`;
        const msg = new Message(Role.User, wrapAndScan(source, r.output), { name: source });
        this.contextManager.addMessage(msg.toDict());
      }

      await this.checkAndCompress();
      const contextMessages = this.contextManager.getContextMessages();

      const budgetError = this.checkTokenBudget(
        this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
      );
      if (budgetError) { yield budgetError; return; }

      for (const h of this.hooks) h.onLLMStart?.(contextMessages, this.toolRegistry.getTools());

      // ── Streaming LLM call ──────────────────────────────────────────
      let rawContent = "";
      let isTruncated = false;
      let toolCallsAccumulated: Map<number, { id?: string; name?: string; args?: string }> = new Map();
      let usageInfo: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

      try {
        for await (const event of this.llm.chatStream(
          contextMessages,
          this.toolRegistry.getTools(),
          this._abortController?.signal,
        )) {
          if (event.type === "chunk") {
            if (event.content) {
              rawContent += event.content;
              yield event.content;
              for (const h of this.hooks) h.onChunk?.(event.content);
            }
            if (event.tool_calls) {
              for (const tc of event.tool_calls) {
                const existing = toolCallsAccumulated.get(tc.index) ?? { args: "" };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.args = (existing.args ?? "") + tc.function.arguments;
                toolCallsAccumulated.set(tc.index, existing);
              }
            }
          } else if (event.type === "done") {
            usageInfo = event.usage;
            // Track truncation for continuation handling below
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
            "continue with my previous request",
          );
          yield `\n\n[Network error: ${err.message}${msg ? " — " + msg : ""}]`;
          return;
        }
        throw err;
      }

      // Build tool calls from accumulated deltas
      const toolCalls = Array.from(toolCallsAccumulated.entries())
        .filter(([, tc]) => tc.name && tc.args !== undefined)
        .map(([, tc]) => ({
          id: tc.id ?? `call_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          type: "function" as const,
          function: { name: tc.name!, arguments: tc.args! },
        }));

      if (usageInfo) {
        this.tokenBudget?.recordUsage(usageInfo.prompt_tokens, usageInfo.completion_tokens);
      }

      // Hook: LLM end
      for (const h of this.hooks) {
        h.onLLMEnd?.({
          content: rawContent,
          tool_calls: toolCalls,
          usage: usageInfo,
          providerMeta: { model: this.llm.model, isFallback: false },
        });
      }

      const parsed = parseReActResponse(rawContent);
      if (parsed.thought) this.captureErrorAnalysis(parsed.thought);

      // ── Tool calls → execute and continue ───────────────────────────
      if (toolCalls.length > 0) {
        if (parsed.thought) {
          for (const h of this.hooks) h.onThought?.(parsed.thought);
        }

        const assistantMessage = Message.assistant(rawContent, toolCalls);

        if (isTruncated) {
          consecutiveTruncations++;
          if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
            // Don't add truncated junk to context — bail out cleanly.
            // fireOnFinish before yield so hooks fire even if consumer
            // closes the iterator after receiving the chunk.
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

        // Add assistant message (with tool_calls) to context BEFORE tool
        // execution so tool results appear immediately after — required
        // by the OpenAI / Anthropic API pairing rules.
        this.contextManager.addMessage(assistantMessage.toDict());

        const mcpWarnedServers = new Set<string>();
        const { hadFailure } = await this.executeToolCallsBatch(toolCalls, mcpWarnedServers);

        if (hadFailure) {
          consecutiveFailures++;
          if (consecutiveFailures >= FAILURE_PRECIPITATE_THRESHOLD
              && this.precipitationMode !== "off") {
            shouldPrecipitate = true;
          }
        } else {
          consecutiveFailures = 0;
          consecutiveEmptyResponses = 0;
        }

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

        if (this.checkpointingEnabled) this.saveCheckpoint("active");
        continue;
      }

      // ── No tool calls ───────────────────────────────────────────────
      const assistantMessage = Message.assistant(rawContent);

      // ── Truncation without tool calls ──────────────────────────────
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

      // ── No tool calls → final answer (already streamed) ─────────────
      const answer = parsed.answer || rawContent;

      // Empty/short response check
      if (!rawContent || rawContent.trim().length < 5) {
        consecutiveEmptyResponses++;
        if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
          const stuckMsg =
            "I apologize, but I'm having difficulty responding. " +
            "Please try rephrasing your request.";
          const stuckMsgObj = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckMsgObj.toDict());
          this.fireOnFinish(stuckMsg);
          yield stuckMsg;
          return;
        }
        continue;
      }

      this.fireOnFinish(answer);
      if (this.checkpointingEnabled) this.saveCheckpoint("completed");

      // ── Skill precipitation (fire-and-forget, post-hoc) ─────────
      if (shouldPrecipitate) {
        this.runPrecipitation(input, answer).catch((err: unknown) =>
          this.logger.warn("Precipitation", `Background precipitation failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      // ── Memory reflection (fire-and-forget, post-hoc) ────────────
      if (shouldReflectMemory) {
        this.runMemoryReflection(input, answer).catch((err: unknown) =>
          this.logger.warn("MemoryReflection", `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      // ── Error reflection (fire-and-forget, post-hoc) ───────────────
      if (shouldReflect) {
        this.runReflection(input, answer).catch((err: unknown) =>
          this.logger.warn("Reflection", `Background reflection failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      yield "\n\n[DONE]";
      return;
    }

    yield `\n\n[Unable to complete within ${this.maxIterations} iterations.]`;
  }

  // ─── Resume ──────────────────────────────────────────────────────────

  /**
   * Resume a previously interrupted session.
   *
   * Loads the saved session state (messages, system prompt) so the agent
   * can continue from where it left off. The `input` is treated as a new
   * user message appended to the restored conversation.
   *
   * @param sessionId The session ID to resume.
   * @param input     New user input to continue the conversation.
   * @returns The agent's final response.
   */
  async resume(sessionId: string, input: string): Promise<string> {
    this.loadAndRestoreSession(sessionId);
    return this.run(input);
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

  // ─── Private Helpers ─────────────────────────────────────────────────

  // handleNetworkError is inherited from the base Agent class.
}
