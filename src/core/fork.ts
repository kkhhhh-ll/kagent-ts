import { LLMProvider } from "../llm/interface";
import { ReActAgent } from "./react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { Tool } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";
import type { AgentHooks } from "./hooks";

/**
 * Options for {@link forkAgent}.
 */
export interface ForkOptions {
  /** System prompt for the forked agent. */
  systemPrompt: string;
  /** LLM provider (defaults to the parent agent's LLM when called via {@link Agent.fork}). */
  llm: LLMProvider;
  /** Tools available to the fork. Defaults to read_file + grep_search. */
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
}

/**
 * Fork a lightweight ReActAgent and run it to completion.
 *
 * Returns the agent's final answer string. The fork runs in its own
 * isolated context with read-only tools by default — ideal for
 * post-hoc analysis, extraction, or verification tasks.
 *
 * The fork does NOT go through the SubAgentManager; it is a direct,
 * inline agent invocation.
 *
 * @example
 * ```ts
 * const result = await forkAgent("Analyze this session...", {
 *   systemPrompt: "You are a code reviewer...",
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

  const tools = new ToolRegistry();
  if (options.tools && options.tools.length > 0) {
    tools.registerMany(options.tools);
  } else {
    tools.register(ReadFileTool);
    tools.register(GrepSearchTool);
  }

  const agent = new ReActAgent({
    llm,
    systemPrompt,
    toolRegistry: tools,
    maxIterations,
    logger,
    hooks: options.hooks,
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
