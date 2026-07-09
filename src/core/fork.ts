import { LLMProvider } from "../llm/interface";
import { ReActAgent } from "./react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { Tool } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";

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
 * const result = await forkAgent(llm, "Analyze this session...", {
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
    subAgentsDir: preventSubAgents ? "" : undefined,
  });

  const result = await agent.run(input);
  logger.info("ForkAgent", "Fork completed.");
  return result;
}
