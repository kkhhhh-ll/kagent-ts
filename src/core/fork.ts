import { LLMProvider } from "../llm/interface";
import { ReActAgent } from "./react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { Tool } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";
import type { AgentHooks } from "./hooks";
import { ContextManager } from "../context/context-manager";
import type { MessageData } from "../messages/types";
import { Role } from "../messages/types";

/**
 * Whitelist of tool names allowed in fork agents.
 *
 * Forks are read-only reviewers — they verify existing information, not
 * modify the world. Any tool NOT in this set passed via `options.tools`
 * is silently dropped with a warning log.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReadFileTool.name,
  GrepSearchTool.name,
]);

/**
 * Options for {@link forkAgent}.
 */
export interface ForkOptions {
  /** System prompt for the forked agent. */
  systemPrompt: string;
  /** LLM provider (defaults to the parent agent's LLM when called via {@link Agent.fork}). */
  llm: LLMProvider;
  /**
   * Tools available to the fork. Defaults to read_file + grep_search.
   *
   * **Only read-only tools are permitted.** Any tool whose name is not in
   * the {@link READ_ONLY_TOOL_NAMES} whitelist is silently dropped with a
   * warning log — fork agents are reviewers, not executors.
   */
  tools?: Tool[];
  /** Maximum ReAct iterations (default: 5). */
  maxIterations?: number;
  /** Prevent the fork from auto-discovering sub-agents. Default: true. */
  preventSubAgents?: boolean;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
  /**
   * Optional AbortSignal. When the signal fires, the fork agent's in-flight
   * LLM request is cancelled and its ReAct loop terminates. Use this to
   * enforce a hard deadline without leaking LLM API calls.
   */
  signal?: AbortSignal;
  /**
   * Optional hooks (e.g. TraceLogger) forwarded to the fork's ReActAgent.
   * When omitted, the fork runs without hook instrumentation.
   */
  hooks?: AgentHooks | AgentHooks[];
  /**
   * Optional context messages to inherit from a parent agent.
   *
   * When provided, these messages are pre-populated into the fork's context
   * BEFORE the task `input` is added. System-role messages are filtered out
   * so the fork keeps its own system prompt. This enables prompt caching on
   * the shared prefix and eliminates the need to serialize the conversation
   * into the `input` string.
   */
  contextMessages?: MessageData[];
}

/**
 * Fork a lightweight ReActAgent and run it to completion.
 *
 * Returns the agent's final answer string. The fork runs with read-only
 * tools by default — ideal for post-hoc analysis, extraction, or
 * verification tasks.
 *
 * When `contextMessages` is provided, the fork inherits the parent agent's
 * conversation history (minus system messages). This enables prompt caching
 * on the shared prefix and eliminates the need to serialize the conversation
 * into the `input` string. The `input` then only needs to carry the task
 * instruction and any metadata not present in the conversation.
 *
 * The fork does NOT go through the SubAgentManager; it is a direct,
 * inline agent invocation.
 *
 * @example
 * ```ts
 * // With context inheritance (recommended):
 * const result = await forkAgent("Review the conversation above and extract skills.", {
 *   systemPrompt: "You are a skill extractor...",
 *   contextMessages: parentContext.getContextMessages(),
 *   maxIterations: 5,
 * });
 * ```
 */
export async function forkAgent(
  input: string,
  options: ForkOptions,
): Promise<string> {
  const { systemPrompt, llm, maxIterations = 5, preventSubAgents = true } = options;
  const logger = options.logger ?? new ConsoleLogger();

  logger.info("ForkAgent", `Starting fork with max ${maxIterations} iteration(s)...`);

  // ── Inherit parent context ──────────────────────────────────────────
  // Pre-populate a ContextManager with the parent agent's messages so the
  // fork "sees" the full conversation instead of a serialized summary.
  // System messages are filtered out — the fork has its own system prompt.
  let contextManager: ContextManager | undefined;
  if (options.contextMessages && options.contextMessages.length > 0) {
    contextManager = new ContextManager();
    for (const msg of options.contextMessages) {
      if (msg.role !== Role.System) {
        contextManager.addMessage(msg);
      }
    }
    logger.info(
      "ForkAgent",
      `Inherited ${options.contextMessages.length} context message(s) from parent agent.`,
    );
  }

  const tools = new ToolRegistry();
  if (options.tools && options.tools.length > 0) {
    const allowed: Tool[] = [];
    const rejected: string[] = [];
    for (const t of options.tools) {
      if (READ_ONLY_TOOL_NAMES.has(t.name)) {
        allowed.push(t);
      } else {
        rejected.push(t.name);
      }
    }
    if (rejected.length > 0) {
      logger.warn(
        "ForkAgent",
        `Rejected ${rejected.length} non-read-only tool(s): ${rejected.join(", ")}. ` +
          `Only ${Array.from(READ_ONLY_TOOL_NAMES).join(", ")} are permitted in fork agents.`,
      );
    }
    if (allowed.length > 0) {
      tools.registerMany(allowed);
    } else {
      // All passed tools were rejected — fall back to safe defaults.
      logger.warn(
        "ForkAgent",
        "All provided tools were rejected; falling back to default read-only tools.",
      );
      tools.register(ReadFileTool);
      tools.register(GrepSearchTool);
    }
  } else {
    tools.register(ReadFileTool);
    tools.register(GrepSearchTool);
  }

  const agent = new ReActAgent({
    llm,
    systemPrompt,
    toolRegistry: tools,
    name: "fork",
    maxIterations,
    logger,
    hooks: options.hooks,
    contextManager,
    // Disable sub-agent discovery explicitly — no falsy string hack.
    disableSubAgents: preventSubAgents,
    // Skip auto-registration of side-effect tools (`remember`, `recall`,
    // `skill`, `list_errors`) so the fork only has the explicitly
    // configured tools (read_file + grep_search by default).
    skipAutoTools: true,
  });

  // Wire the external signal to the agent's built-in cancellation mechanism.
  // `agent.cancel()` aborts the in-flight LLM request AND sets the
  // `_cancelled` flag so the ReAct loop terminates at the next check.
  let onAbort: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Fork aborted before execution.");
    }
    onAbort = () => agent.cancel();
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await agent.run(input);
    logger.info("ForkAgent", "Fork completed.");
    return result;
  } finally {
    // Clean up the listener to avoid leaks on repeated forkAgent calls
    // sharing the same signal across multiple executions.
    if (onAbort && options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}
