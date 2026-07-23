import { LLMProvider } from "../llm/interface";
import { ReActAgent } from "./react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { TraceLogger } from "../trace/trace-logger";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { Tool } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";
import type { AgentHooks } from "./hooks";
import { ContextManager } from "../context/context-manager";
import type { MessageData } from "../messages/types";
import { Role } from "../messages/types";

/**
 * Filter out assistant messages whose tool_calls haven't been answered yet.
 *
 * Context inheritance copies the parent's conversation into the fork, but
 * if the parent just received an LLM response with tool_calls and hasn't
 * executed them yet, those unpaired assistant(tool_calls) messages break
 * the API's tool_call / tool_result pairing requirement.
 *
 * This function removes incomplete turns so the fork only sees settled state.
 */
export function filterIncompleteTurns(messages: MessageData[]): MessageData[] {
  const answeredIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === Role.Tool && msg.tool_call_id) {
      answeredIds.add(msg.tool_call_id);
    }
  }
  return messages.filter((msg) => {
    if (msg.role === Role.Assistant && msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls.every((tc) => answeredIds.has(tc.id));
    }
    return true;
  });
}

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
  const { systemPrompt, llm, preventSubAgents = true } = options;
  const logger = options.logger ?? new ConsoleLogger();

  logger.info("ForkAgent", "Starting fork agent...");

  // ── Inherit parent context ──────────────────────────────────────────
  // Serialize the parent's conversation into a clean text block so the
  // fork sees the content without inheriting raw API messages (which can
  // contain tool_calls / tool result names that break the fork's API calls).
  let serializedContext = "";
  if (options.contextMessages && options.contextMessages.length > 0) {
    const filtered = filterIncompleteTurns(options.contextMessages);
    const lines: string[] = [];
    for (const msg of filtered) {
      if (msg.role === Role.System) continue;
      // Skip tool outputs from tools the fork doesn't have — prevents
      // the model from hallucinating calls to fork_agent, spawn_subagent, etc.
      if (msg.role === Role.Tool && msg.name && msg.name !== "read_file" && msg.name !== "grep_search") {
        continue;
      }
      const content = (msg.content ?? "").trim();
      if (!content) continue;
      if (msg.role === Role.User) {
        lines.push(`User: ${content}`);
      } else if (msg.role === Role.Assistant) {
        lines.push(`Assistant: ${content}`);
      } else if (msg.role === Role.Tool) {
        lines.push(`Tool output: ${content}`);
      }
    }
    serializedContext = lines.join("\n\n");
    logger.info(
      "ForkAgent",
      `Serialized ${options.contextMessages.length} context message(s) from parent agent.`,
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

  const forkLabel = "fork-sync";
  const forkHooks = options.hooks
    ? TraceLogger.wrapHooksForFork(options.hooks, forkLabel)
    : undefined;

  const agent = new ReActAgent({
    llm,
    systemPrompt,
    toolRegistry: tools,
    name: "fork",
    logger,
    hooks: forkHooks,
    // Disable sub-agent discovery explicitly — no falsy string hack.
    disableSubAgents: preventSubAgents,
    // Forks are read-only reviewers — skip `remember`, `recall`, `skill`,
    // and `fork_agent` to prevent recursive sub-fork creation.
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
    // Prepend serialized parent context as a background block so the fork
    // sees the full conversation as plain text — no raw API messages that
    // could break tool-call ordering or hallucinate unavailable tools.
    const enrichedInput = serializedContext
      ? `=== Background Context ===\n\nBelow is the conversation history from the parent agent. You may see references to tools (fork_agent, spawn_subagent, etc.) that the parent used, but these are NOT available to you. You only have the tools listed in your system prompt. Focus on the Task at the bottom, not on replicating the parent's tool usage.\n\n${serializedContext}\n\n=== End Background Context ===\n\n---\n\nTask: ${input}`
      : input;
    const result = await agent.run(enrichedInput);
    logger.info("ForkAgent", "Fork completed.");
    if (!result || !result.trim()) {
      return "Fork agent produced no output. The task may need a smaller scope or a more specific system prompt.";
    }
    return result;
  } finally {
    // Clean up the listener to avoid leaks on repeated forkAgent calls
    // sharing the same signal across multiple executions.
    if (onAbort && options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}
