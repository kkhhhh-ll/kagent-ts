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
import { StreamingAnswerExtractor } from "./streaming-answer-extractor";

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
  /** Memory reflection mode. Default: "off". */
  memoryReflection?: "off" | "post-hoc";
  /** Max iterations for the memory reflection sub-agent. Default: 5. */
  memoryReflectionMaxIterations?: number;
}

/**
 * ReAct Agent implementing a Thought → Action → Observation → Final Answer loop.
 *
 * The agent uses `tool_calls` as the sole signal for loop control:
 * - Has tool_calls → execute tools, continue loop
 * - No tool_calls → response content IS the final answer
 * Session persistence:
 * When `enableCheckpointing` is set, the agent auto-saves checkpoints after
 * each LLM+tools cycle. On network error, an `interrupted` checkpoint is
 * saved so the user can resume later via `agent.resume(sessionId, input)`.
 */
export class ReActAgent extends Agent {
  private memoryReflectionMode: "off" | "post-hoc";
  private memoryReflectionMaxIterations: number;

  constructor(config: ReActAgentConfig) {
    const mergedConfig: ReActAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_REACT_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.memoryReflectionMode = config.memoryReflection ?? "off";
    this.memoryReflectionMaxIterations =
      config.memoryReflectionMaxIterations ?? 5;

    // Build the full system prompt once all sections are ready
    this.rebuildSystemPrompt();
  }

  async run(input: string): Promise<string> {
    this._acquireRunLock();

    this._cancelled = false;

    try {
      // ── Pre-flight: reject oversized input before any setup ───────────
      const sizeError = this.validateInputSize(input);
      if (sizeError) return sizeError;

      // ── Async initialization (MCP connections, sub-agents, etc.) ────────
      await this.init();

      // ── Reload dynamic resources (preferences, skills, MCP) ─────────
      await this.reloadDynamicResources();

      // ── Recover orphaned sub-agent results from a cancelled session ──
      this.recoverOrphanedSubAgentResults();

      if (!this.skipAutoTools) {
        this.detectInputSignals(input);
        this.matchInputContext(input);
      }

      // ── Create user message ──────────────────────────────────────────
      const userMessage = Message.user(input);
      this.contextManager.addMessage(userMessage.toDict());

      // Save initial checkpoint (captures user input before any LLM call)
      if (this.checkpointingEnabled) {
        this.saveCheckpoint("active");
      }

      // Track consecutive max_tokens truncations (to avoid infinite continuation loops)
      let consecutiveTruncations = 0;
      const MAX_TRUNCATION_CONTINUES = 3;

      let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
      // User explicitly asked to remember — override mode config
      if (this.inputSignals.wantsRemember) {
        shouldReflectMemory = true;
      }
      // ── ReAct loop ────────────────────────────────────────────────────
      let iteration = 0;
      while (true) {
        this.logger.info(
          this.agentName === "main" ? "ReAct" : `ReAct:${this.agentName}`,
          `Iteration ${iteration + 1} begin`,
        );
        this._abortController = new AbortController();

        if (this.isCancelled) {
          this.saveCheckpoint("cancelled");
          const sid = this.sessionManager?.getSessionId() ?? "";
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
          const msg = new Message(Role.User, wrapAndScan(source, r.output), {
            name: source,
          });
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
        this.fireHook((h) =>
          h.onLLMStart?.(contextMessages, this.toolRegistry.getTools()),
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
            const sid = this.sessionManager?.getSessionId() ?? "";
            const cancelMsg =
              `Execution cancelled by user. Session "${sid}" preserved — ` +
              `resume with agent.resume("${sid}", "<your prompt>").`;
            this.fireOnFinish(cancelMsg);
            return cancelMsg;
          }
          if (err instanceof LLMNetworkError) {
            this.fireHook((h) => h.onLLMError?.(err));
            return this.handleNetworkError(
              err,
              iteration + 1,
              "continue with my previous request",
            );
          }
          throw err; // Unknown error — propagate
        }
        this.fireHook((h) => h.onLLMEnd?.(response));

        // Record token usage against the session budget
        if (response.usage) {
          this.tokenBudget?.recordUsage(
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
          );
        }

        // Parse the response content (for logging / error analysis)
        const rawContent = response.content;
        const parsed = parseReActResponse(response.content);

        // Create assistant message from the response
        const assistantMessage = Message.assistant(
          rawContent,
          response.tool_calls,
        );

        // ── Handle max_tokens truncation ───────────────────────────────
        const isTruncated =
          response.responseError?.code === LLMResponseErrorCode.MAX_TOKENS;
        if (isTruncated) {
          consecutiveTruncations++;
          if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
            const fallback =
              "answer" in parsed && parsed.answer
                ? parsed.answer +
                  "\n\n[Note: Response may be incomplete due to repeated output limits.]"
                : "I apologize, but I'm unable to complete this response due to output length constraints. " +
                  "Please try breaking your request into smaller steps.";
            this.fireOnFinish(fallback);
            return fallback;
          }
          this.contextManager.addMessage(assistantMessage.toDict());
        } else {
          this.contextManager.addMessage(assistantMessage.toDict());
          consecutiveTruncations = 0;
        }

        const toolCalls = response.tool_calls ?? [];

        // ── Tool calls → still executing, loop back after running tools ──
        if (toolCalls.length > 0) {
          // Log reasoning if present
          if (parsed.thought) {
            this.logger.info("Thought", parsed.thought);
            this.fireHook((h) => h.onThought?.(parsed.thought));
          }
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
          const { hadSpawnCalls } = await this.executeToolCallsBatch(
            toolCalls,
            mcpWarnedServers,
          );
          // Inject continuation AFTER tool execution (Anthropic API pairing)
          if (isTruncated) {
            const continueMsg = Message.user(
              "Your previous response was cut off (max output tokens reached). " +
                "Continue exactly where you left off — do NOT repeat any content already written.",
            );
            this.contextManager.addMessage(continueMsg.toDict());
          }
          await this.collectFastSubAgentResults(hadSpawnCalls);

          if (this.checkpointingEnabled) {
            this.saveCheckpoint("active");
          }

          iteration++;
          continue;
        }
        const answer = parsed.answer || rawContent;

        // Empty response — ask the model to try again (single retry, not a counter)
        if (!answer.trim()) {
          const retryMsg = Message.user(
            "Your last response was empty. Please provide a complete answer.",
          );
          this.contextManager.addMessage(retryMsg.toDict());
          this.logger.info("ReAct", "Empty answer — retrying once.");
          iteration++;
          continue;
        }

        // If truncated, don't return yet — inject continuation
        if (isTruncated) {
          const continueMsg = Message.user(
            "Your previous response was cut off (max output tokens reached). " +
              "Continue exactly where you left off — do NOT repeat any content already written.",
          );
          this.contextManager.addMessage(continueMsg.toDict());
          this.logger.info(
            "ReAct",
            "Answer truncated (max_tokens) — continuing in next iteration.",
          );
          iteration++;
          continue;
        }

        // ── Hold the answer while sub-agents are still running ──────────
        if (this.holdAnswerForPendingSubAgents()) {
          iteration++;
          continue;
        }

        // Normal answer — return content
        this.logger.info("Answer", answer);

        this.fireOnFinish(answer);
        if (this.checkpointingEnabled) this.saveCheckpoint("completed");

        // ── Memory reflection (fire-and-forget, post-hoc) ────────────
        if (shouldReflectMemory) {
          this.trackBackground(this.runMemoryReflection(input, answer)).catch(
            (err: unknown) =>
              this.logger.warn(
                "MemoryReflection",
                `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
          );
        }

        return answer;
      }
    } finally {
      this._isRunning = false;
    }
  }

  // ─── Streaming ────────────────────────────────────────────────────────

  protected async *executeStream(input: string): AsyncIterable<string> {
    this._acquireRunLock();
    try {
      const sizeError = this.validateInputSize(input);
      if (sizeError) {
        yield sizeError;
        return;
      }

      await this.init();
      await this.reloadDynamicResources();

      this.recoverOrphanedSubAgentResults();

      if (!this.skipAutoTools) {
        this.detectInputSignals(input);
        this.matchInputContext(input);
      }

      const userMessage = Message.user(input);
      this.contextManager.addMessage(userMessage.toDict());

      if (this.checkpointingEnabled) this.saveCheckpoint("active");

      // Track consecutive max_tokens truncations (to avoid infinite continuation loops)
      let consecutiveTruncations = 0;
      const MAX_TRUNCATION_CONTINUES = 3;

      let shouldReflectMemory = this.memoryReflectionMode === "post-hoc";
      // User explicitly asked to remember — override mode config
      if (this.inputSignals.wantsRemember) {
        shouldReflectMemory = true;
      }

      let iteration = 0;
      while (true) {
        this.logger.info(
          this.agentName === "main" ? "ReAct" : `ReAct:${this.agentName}`,
          `Iteration ${iteration + 1}`,
        );
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
          const msg = new Message(Role.User, wrapAndScan(source, r.output), {
            name: source,
          });
          this.contextManager.addMessage(msg.toDict());
        }

        await this.checkAndCompress();
        const contextMessages = this.contextManager.getContextMessages();

        const budgetError = this.checkTokenBudget(
          this.tokenBudget ? this.contextManager.getCurrentTokens() : 0,
        );
        if (budgetError) {
          yield budgetError;
          return;
        }

        this.fireHook((h) =>
          h.onLLMStart?.(contextMessages, this.toolRegistry.getTools()),
        );

        // ── Streaming LLM call ──────────────────────────────────────────
        let rawContent = "";
        let isTruncated = false;
        let toolCallsAccumulated: Map<
          number,
          { id?: string; name?: string; args?: string }
        > = new Map();
        let usageInfo:
          | {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            }
          | undefined;
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
                  this.fireHook((h) => h.onChunk?.(display));
                }
              }
              if (event.tool_calls) {
                for (const tc of event.tool_calls) {
                  const existing = toolCallsAccumulated.get(tc.index) ?? {
                    args: "",
                  };
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments)
                    existing.args =
                      (existing.args ?? "") + tc.function.arguments;
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
            this.fireHook((h) => h.onLLMError?.(err));
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
            id:
              tc.id ??
              `call_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
            type: "function" as const,
            function: { name: tc.name!, arguments: tc.args! },
          }));

        if (usageInfo) {
          this.tokenBudget?.recordUsage(
            usageInfo.prompt_tokens,
            usageInfo.completion_tokens,
          );
        }

        // Hook: LLM end
        this.fireHook((h) =>
          h.onLLMEnd?.({
            content: rawContent,
            tool_calls: toolCalls,
            usage: usageInfo,
            providerMeta: { model: this.llm.model, isFallback: false },
          }),
        );

        const parsed = parseReActResponse(rawContent);

        // ── Tool calls → execute and continue ───────────────────────────
        if (toolCalls.length > 0) {
          if (parsed.thought) {
            this.fireHook((h) => h.onThought?.(parsed.thought));
          }

          const assistantMessage = Message.assistant(rawContent, toolCalls);

          if (isTruncated) {
            consecutiveTruncations++;
            if (consecutiveTruncations > MAX_TRUNCATION_CONTINUES) {
              const fallback = parsed.answer
                ? parsed.answer +
                  "\n\n[Note: Response may be incomplete due to repeated output limits.]"
                : "I apologize, but I'm unable to complete this response due to output length constraints. " +
                  "Please try breaking your request into smaller steps.";
              this.fireOnFinish(fallback);
              yield fallback;
              return;
            }
          } else {
            consecutiveTruncations = 0;
          }
          this.contextManager.addMessage(assistantMessage.toDict());

          const mcpWarnedServers = new Set<string>();
          const { hadSpawnCalls } = await this.executeToolCallsBatch(
            toolCalls,
            mcpWarnedServers,
          );

          if (isTruncated) {
            this.contextManager.addMessage(
              Message.user(
                "Your previous response was cut off (max output tokens reached). " +
                  "Continue exactly where you left off — do NOT repeat any content already written.",
              ).toDict(),
            );
          }

          // Opportunistic fast wait for sub-agent results.
          await this.collectFastSubAgentResults(hadSpawnCalls);

          if (this.checkpointingEnabled) this.saveCheckpoint("active");
          iteration++;
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
              ? parsed.answer +
                "\n\n[Note: Response may be incomplete due to repeated output limits.]"
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
                "Continue exactly where you left off — do NOT repeat any content already written.",
            ).toDict(),
          );
          continue;
        }
        consecutiveTruncations = 0;

        // Normal (non-truncated) response — store in context
        this.contextManager.addMessage(assistantMessage.toDict());

        // ── No tool calls → final answer (already streamed) ─────────────
        const answer = parsed.answer || rawContent;

        // ── Hold the answer while sub-agents are still running ──────────
        if (this.holdAnswerForPendingSubAgents()) {
          yield "\n\n[Waiting for sub-agent results...]\n\n";
          iteration++;
          continue;
        }

        if (!answerExtractor.emitted) {
          yield answer;
        }

        this.fireOnFinish(answer);
        if (this.checkpointingEnabled) this.saveCheckpoint("completed");

        // ── Memory reflection (fire-and-forget, post-hoc) ────────────
        if (shouldReflectMemory) {
          this.trackBackground(this.runMemoryReflection(input, answer)).catch(
            (err: unknown) =>
              this.logger.warn(
                "MemoryReflection",
                `Background memory reflection failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
          );
        }

        yield "\n\n[DONE]";
        return;
      }
    } finally {
      this._isRunning = false;
    }
  }

  // ─── Resume ──────────────────────────────────────────────────────────

  /**
   * Resume a previously interrupted session.
   * @param sessionId The session ID to resume.
   * @param input     New user input to continue the conversation.
   * @returns The agent's final response.
   */
  async resume(sessionId: string, input: string): Promise<string> {
    this.loadAndRestoreSession(sessionId);
    return this.run(input);
  }

  // ─── Memory Reflection ──────────────────────────────────────────────

  /**
   * Run post-hoc memory extraction after a successful completion.
   * MemoryManager is always created by the base Agent constructor.
   */
  private async runMemoryReflection(
    input: string,
    answer: string,
  ): Promise<void> {
    const { MemoryReflector } =
      await import("../reflection/memory-reflector.js");

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
}
