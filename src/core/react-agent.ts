import { Agent, AgentConfig } from "./agent";
import { Message } from "../messages/message";
import {
  STRUCTURED_OUTPUT_INSTRUCTIONS,
  parseReActResponse,
} from "./response-schema";
import { LLMNetworkError } from "../llm/openai-provider";
import { LLMResponse } from "../llm/interface";
import { STRUCTURED_OUTPUT_REMINDER } from "./response-schema";

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

=== Tool Error Recovery ===
When a tool returns an error:
1. READ the error message carefully — understand WHY it failed.
2. ANALYZE whether the parameters were correct. Common issues:
   - Wrong file path (check spelling, use absolute paths)
   - Missing or incorrect arguments
   - The tool may need different input formats
3. RETRY with corrected parameters if you can fix the issue.
4. If the same tool fails repeatedly, try a COMPLETELY DIFFERENT approach.
5. If a tool is disabled after too many failures, DO NOT try to use it again.
   Find another way to accomplish the task.${STRUCTURED_OUTPUT_INSTRUCTIONS}

=== Sub-Agent Delegation ===
You have the ability to spawn sub-agents for parallel or specialized work. When facing a non-trivial task, evaluate it against these criteria:

SPAWN A SUB-AGENT when:
1. The task can be completed independently (doesn't depend on conversation history)
2. The task will produce a lot of intermediate output (e.g. running tests, searching entire codebase)
3. The task belongs to a specific domain (code review, security scan, i18n check, etc.)
4. Multiple independent tasks can run at the same time

PREFER THE MAIN AGENT when the task depends on conversation context or is quick to complete.

How to delegate:
- Call \`list_subagents\` to see available sub-agents and their capabilities (tools, skills)
- Choose the best match, then call \`spawn_subagent\` with the name and a clear task description
- Sub-agents run asynchronously; their results arrive as user messages wrapped in <subagent-result> tags
- You can continue working while sub-agents run in the background`;

/**
 * Configuration specific to the ReAct Agent.
 */
export interface ReActAgentConfig extends AgentConfig {
  /** Maximum iterations for the ReAct loop (default: 10). */
  maxIterations?: number;

  /**
   * Enable progressive skill disclosure.
   * When true, skills are auto-detected from user input and loaded
   * into the system prompt on demand (default: true).
   */
  enableSkillAutoDetect?: boolean;
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
  private enableSkillAutoDetect: boolean;

  constructor(config: ReActAgentConfig) {
    // Set default ReAct system prompt if none provided
    const mergedConfig: ReActAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_REACT_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxIterations = config.maxIterations ?? 10;
    this.enableSkillAutoDetect = config.enableSkillAutoDetect ?? true;

    // If skills are registered, rebuild the system prompt so the
    // available-skills hint is included in the initial prompt.
    if (this.skillManager.activeCount > 0) {
      this.rebuildSystemPrompt();
    }
  }

  async run(input: string): Promise<string> {
    // ── Async initialization (MCP connections, sub-agents, etc.) ────────
    await this.init();

    // ── Progressive disclosure ─────────────────────────────────────────
    if (this.enableSkillAutoDetect && this.skillManager.count > 0) {
      const activated = this.skillManager.detectAndActivate(input);
      if (activated.length > 0) {
        this.rebuildSystemPrompt();
        console.log(`[Skills] Auto-activated: ${activated.join(", ")}`);
      }
    }

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

    // ── ReAct loop ────────────────────────────────────────────────────
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Check if user cancelled (SIGINT)
      if (this.isCancelled) {
        this.sessionManager?.deleteSession(
          this.sessionManager.getSessionId(),
        );
        const cancelMsg = "Execution cancelled by user. Session discarded.";
        for (const h of this.hooks) h.onFinish?.(cancelMsg);
        return cancelMsg;
      }

      // Check and compress if needed
      await this.checkAndCompress();

      // ── Poll sub-agent results ──────────────────────────────────────
      const subResults = await this.pollSubAgentResults();
      for (const r of subResults) {
        const msg = Message.user(
          `[Sub-agent "${r.name}" (${r.subAgentId}) completed]\n\n${r.output}`,
        );
        this.contextManager.addMessage(msg.toDict());
      }

      // Prepare messages for the LLM
      const contextMessages = this.contextManager.getContextMessages();

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
          return this.handleNetworkError(err, iteration + 1);
        }
        throw err; // Unknown error — propagate
      }
      for (const h of this.hooks) h.onLLMEnd?.(response);

      // Parse the response content as structured JSON
      const parsed = parseReActResponse(response.content);
      const rawContent = response.content;

      // Create assistant message from the response
      const assistantMessage = Message.assistant(
        rawContent,
        response.tool_calls,
      );

      // Store in context
      this.contextManager.addMessage(assistantMessage.toDict());

      // Check if LLM wants to call tools
      if (response.tool_calls && response.tool_calls.length > 0) {
        consecutiveEmptyIterations = 0;

        // Log the reasoning thought and capture as error analysis
        if (parsed.thought) {
          console.log(`[Thought] ${parsed.thought}`);
          for (const h of this.hooks) h.onThought?.(parsed.thought);
          this.captureAnalysisFromThought(parsed.thought);
        }

        for (const toolCall of response.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          for (const h of this.hooks) h.onToolStart?.(toolCall.function.name, args);

          // Execute via ToolRegistry — includes circuit breaker protection
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

          // Determine success vs error and fire appropriate hook
          if (result.startsWith("Error")) {
            for (const h of this.hooks) h.onToolError?.(toolCall.function.name, result);
          } else {
            for (const h of this.hooks) h.onToolEnd?.(toolCall.function.name, result);
          }

          // Track this result for error analysis if it indicates a failure
          this.trackToolErrorForAnalysis(toolCall.function.name, result);

          // Create tool result message
          const toolMessage = Message.tool(
            result,
            toolCall.id,
            toolCall.function.name,
          );

          this.contextManager.addMessage(toolMessage.toDict());
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

        console.log(`[Thought] ${parsed.thought}`);
        for (const h of this.hooks) h.onThought?.(parsed.thought);
        this.captureAnalysisFromThought(parsed.thought);

        // If stuck in unproductive thought-only loop, inject format reminder
        if (consecutiveEmptyIterations >= 3) {
          console.log(
            `[ReAct] ${consecutiveEmptyIterations} consecutive thought-only iterations — ` +
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
        `  agent.resume("${sid}", "continue with my previous request")\n\n` +
        `Or start a new session by calling agent.run() again with a fresh input.`
      );
    }

    // Checkpointing not enabled — just report the error
    return (
      `[Network Error] ${err.message}\n\n` +
      `Please check your network connection and try again.`
    );
  }
}
