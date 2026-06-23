import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import {
  STRUCTURED_OUTPUT_INSTRUCTIONS,
  STRUCTURED_OUTPUT_REMINDER,
  parseReActResponse,
} from "./response-schema";
import { TOOL_ERROR_RECOVERY, SUB_AGENT_DELEGATION } from "./system-prompts";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse, LLMResponseErrorCode } from "../llm/interface";
import { ToolResult, ToolErrorCode, toolError } from "../tools/types";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin";

/**
 * Default system prompt for ReAct-style reasoning with structured JSON output.
 *
 * The LLM is instructed to respond with JSON so the agent can reliably
 * parse thoughts and final answers — no free-text format ambiguity.
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
${TOOL_ERROR_RECOVERY}${STRUCTURED_OUTPUT_INSTRUCTIONS}
${SUB_AGENT_DELEGATION}`;

/**
 * Configuration specific to the ReAct Agent.
 */
export interface ReActAgentConfig extends AgentConfig {
  /** Maximum iterations for the ReAct loop (default: 10). */
  maxIterations?: number;
}

/**
 * ReAct Agent implementing a structured Thought → Action → Observation → Final Answer loop.
 *
 * The agent uses structured JSON output from the LLM:
 * - Intermediate steps:  {"thought": "..."}
 * - Final answer:        {"thought": "...", "answer": "..."}
 * - Tool calls via native function calling (OpenAI tool_calls)
 *
 * Session persistence:
 * When `enableCheckpointing` is set, the agent auto-saves checkpoints after
 * each LLM+tools cycle. On network error, an `interrupted` checkpoint is
 * saved so the user can resume later via `agent.resume(sessionId, input)`.
 */
export class ReActAgent extends Agent {
  private maxIterations: number;

  constructor(config: ReActAgentConfig) {
    // Set default ReAct system prompt if none provided
    const mergedConfig: ReActAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_REACT_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxIterations = config.maxIterations ?? 10;

    // Build the full system prompt once all sections are ready
    this.rebuildSystemPrompt();
  }

  async run(input: string): Promise<string> {
    // ── Async initialization (MCP connections, sub-agents, etc.) ────────
    await this.init();

    // ── Reload dynamic resources (preferences, skills, MCP) ─────────
    await this.reloadDynamicResources();

    // ── Recover orphaned sub-agent results from a cancelled session ──
    this.recoverOrphanedSubAgentResults();

    // ── Pre-flight: reject oversized input before any LLM call ───────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

    // ── Create user message ──────────────────────────────────────────
    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

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

    // ── ReAct loop ────────────────────────────────────────────────────
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

      // ── Poll sub-agent results ──────────────────────────────────────
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const msg = Message.user(
          `[Sub-agent "${r.name}" (${r.subAgentId}) completed]\n\n${r.output}`,
        );
        this.contextManager.addMessage(msg.toDict());
      }

      // Check and compress after sub-agent results are in
      await this.checkAndCompress();

      // Prepare messages for the LLM
      const contextMessages = this.contextManager.getContextMessages();

      // Token budget check — stop if the session budget is exhausted
      const budgetError = this.checkTokenBudget(this.contextManager.getCurrentTokens());
      if (budgetError) {
        for (const h of this.hooks) h.onFinish?.(budgetError);
        return budgetError;
      }

      // Call the LLM with all registered tools — with network error handling
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
          return this.handleNetworkError(err, iteration + 1, "continue with my previous request");
        }
        throw err; // Unknown error — propagate
      }
      for (const h of this.hooks) h.onLLMEnd?.(response);

      // Record token usage against the session budget
      if (response.usage) {
        this.tokenBudget?.recordUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      // Parse the response content as structured JSON
      const parsed = parseReActResponse(response.content);
      const rawContent = response.content;

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

      // Check if LLM wants to call tools
      if (response.tool_calls && response.tool_calls.length > 0) {
        consecutiveEmptyIterations = 0;

        // Log the reasoning thought
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

          // ── Human-in-the-loop approval check ─────────────────────────
          const tool = this.toolRegistry.getTool(toolCall.function.name);
          if (tool?.requireApproval) {
            const approved = await this.checkToolApproval(toolCall.function.name, args);
            if (!approved) {
              const result: ToolResult = toolError(
                ToolErrorCode.APPROVAL_DENIED,
                `[FATAL:APPROVAL_DENIED] Tool "${toolCall.function.name}" requires approval and was denied. ` +
                `Do NOT retry this tool. Find a different approach.`,
                "fatal",
              );
              for (const h of this.hooks) h.onToolError?.(toolCall.function.name, result.content);
              const toolMessage = Message.tool(result.content, toolCall.id, toolCall.function.name);
              this.contextManager.addMessage(toolMessage.toDict());
              continue;
            }
          }

          // Execute via ToolRegistry — never throws.
          const result: ToolResult = await this.toolRegistry.execute(
            toolCall.function.name,
            args,
          );

          if (result.success) {
            for (const h of this.hooks) h.onToolEnd?.(toolCall.function.name, result.content);
          } else {
            for (const h of this.hooks) h.onToolError?.(toolCall.function.name, result.content);
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

        // Save checkpoint after complete tool execution round
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("active");
        }

        // Continue the loop for the next Thought
        continue;
      }

      // No tool calls — extract the final answer from the JSON
      if ("answer" in parsed && parsed.answer) {
        // If truncated, don't return — the continuation instruction is
        // already in context; next iteration will pick up where it left off.
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
          this.logger.info("ReAct", "Answer truncated (max_tokens) — continuing in next iteration.");
          continue;
        }
        for (const h of this.hooks) h.onFinish?.(parsed.answer);
        // Save final checkpoint as completed
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        return parsed.answer;
      }

      // JSON has "thought" but no "answer" — continue the loop
      // (the agent is still reasoning)
      if (parsed.thought) {
        consecutiveEmptyIterations++;

        this.logger.info("Thought", parsed.thought);
        for (const h of this.hooks) h.onThought?.(parsed.thought);

        // If stuck in unproductive thought-only loop, inject format reminder
        if (consecutiveEmptyIterations >= 3) {
          this.logger.info(
            "ReAct",
            `${consecutiveEmptyIterations} consecutive thought-only iterations — ` +
            `injecting format reminder.`,
          );
          const reminderMsg = Message.assistant(STRUCTURED_OUTPUT_REMINDER);
          this.contextManager.addMessage(reminderMsg.toDict());
        }

        // If exceeded limit, bail out
        if (consecutiveEmptyIterations >= EMPTY_ITERATION_LIMIT) {
          const stuckMsg =
            "I apologize, but I'm having difficulty making progress on your request. " +
            "Please try rephrasing or breaking it down into smaller, more specific steps.";
          const stuckAssistantMessage = Message.assistant(stuckMsg);
          this.contextManager.addMessage(stuckAssistantMessage.toDict());
          for (const h of this.hooks) h.onFinish?.(stuckMsg);
          return stuckMsg;
        }

        // Save checkpoint after a thought-only iteration
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("active");
        }
        continue;
      }

      // Empty response (no thought, no answer, no tool calls)
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

    // ── Max iterations reached without final answer ───────────────────
    const timeoutMsg =
      `I apologize, but I was unable to complete the task within ${this.maxIterations} iterations. ` +
      `Please try breaking your request into smaller steps.`;
    const timeoutAssistantMessage = Message.assistant(timeoutMsg);
    this.contextManager.addMessage(timeoutAssistantMessage.toDict());
    for (const h of this.hooks) h.onFinish?.(timeoutMsg);
    return timeoutMsg;
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

  // ─── Private Helpers ─────────────────────────────────────────────────

  // handleNetworkError is inherited from the base Agent class.
}
