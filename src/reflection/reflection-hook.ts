import { AgentHooks } from "../core/hooks";
import { MessageData } from "../messages/types";
import { LLMProvider } from "../llm/interface";
import { ReflectionAgent } from "./reflection-agent";
import { ErrorNotebook } from "./error-notebook";
import { MemoryReflector } from "./memory-reflector";
import { MemoryManager } from "../memory/memory-manager";
import { Logger, ConsoleLogger } from "../logging/logger";

/**
 * Configuration for the reflection hook.
 */
export interface ReflectionHookConfig {
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** ErrorNotebook for persisting error reflection findings (optional — skip to disable error reflection). */
  notebook?: ErrorNotebook;
  /** MemoryManager for persisting extracted memories (optional — skip to disable memory extraction). */
  memoryManager?: MemoryManager;
  /** Max ReAct iterations for the error reflector sub-agent (default: 4). */
  maxErrorIterations?: number;
  /** Max ReAct iterations for the memory reflector sub-agent (default: 5). */
  maxMemoryIterations?: number;
  /**
   * Callback invoked when reflection completes.
   * Receives counts for both error entries and new memories.
   */
  onReflectionComplete?: (entryCount: number, memoryCount: number) => void;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

/**
 * Create an AgentHooks implementation that runs post-execution
 * self-reflection and memory extraction via two forked sub-agents.
 *
 * Both forks run in parallel with their own isolated contexts —
 * neither blocks the main agent's response to the user.
 *
 * ```ts
 * const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });
 * const memory = new MemoryManager({ storageDir: ".memory" });
 * const hook = createReflectionHook({ llm, notebook, memoryManager: memory });
 * const agent = new ReActAgent({ llm, hooks: hook });
 * const answer = await agent.run("...");
 * // After answer is returned, two forks run in parallel:
 * //   1. Error reflector → finds mistakes → persists to notebook
 * //   2. Memory extractor → extracts memories → persists to .memory/
 * ```
 */
export function createReflectionHook(
  config: ReflectionHookConfig,
): AgentHooks & { readonly notebook: ErrorNotebook | null; readonly memoryManager: MemoryManager | null } {
  const { llm, notebook, memoryManager } = config;
  const logger = config.logger ?? new ConsoleLogger();

  // Accumulate state across hook calls
  let userQuery: string | null = null;
  let lastConversation: MessageData[] = [];

  const errorReflector = notebook
    ? new ReflectionAgent({
        llm,
        notebook,
        maxIterations: config.maxErrorIterations,
      })
    : null;

  const memoryReflector = memoryManager
    ? new MemoryReflector({
        llm,
        memoryManager,
        maxIterations: config.maxMemoryIterations,
      })
    : null;

  const hook: AgentHooks = {
    // This hook spawns sub-agents in onFinish — passing it to sub-agents
    // would cause unbounded recursion (sub-agent finishes → spawns more
    // sub-agents → those finish → spawn more...).
    safeForSubAgent: false,

    // ── Capture the full conversation from each LLM call ──────────────
    onLLMStart(messages: MessageData[]): void {
      // Capture the first user message as the original query
      if (!userQuery) {
        const firstUser = messages.find(
          (m) => m.role === "user" && !m.content.startsWith("[Sub-agent"),
        );
        if (firstUser) userQuery = firstUser.content;
      }

      // Keep the latest full conversation snapshot
      lastConversation = messages;
    },

    // ── Run reflection & memory extraction after the agent finishes ──
    onFinish: async (finalAnswer: string) => {
      const sessionId = `session_${Date.now()}`;

      // Snapshot state immediately so an overlapping onLLMStart from a
      // subsequent run doesn't overwrite these while the async reflection
      // is still in progress.
      const query = userQuery ?? "(unknown)";
      const conversation = lastConversation;

      // Run error reflector and memory reflector in parallel.
      // Both are best-effort — failures in one don't affect the other.
      const [errorEntries, memoryEntries] = await Promise.all([
        // Error reflection (skip if no notebook configured)
        (async () => {
          if (!errorReflector) return [];
          try {
            const entries = await errorReflector.reflect({
              userQuery: query,
              finalAnswer,
              conversation,
              sessionId,
            });
            if (entries.length > 0) {
              logger.info(
                "Reflection",
                `Recorded ${entries.length} finding(s) to the error notebook.`,
              );
            }
            return entries;
          } catch (err) {
            logger.warn("Reflection", `Error reflector failed: ${err}`);
            return [];
          }
        })(),

        // Memory extraction (skip if no memoryManager configured)
        (async () => {
          if (!memoryReflector) return [];
          try {
            const memories = await memoryReflector.reflect({
              userQuery: query,
              finalAnswer,
              conversation,
              sessionId,
            });
            if (memories.length > 0) {
              logger.info(
                "Reflection",
                `Extracted ${memories.length} new memor${memories.length === 1 ? "y" : "ies"}.`,
              );
            }
            return memories;
          } catch (err) {
            logger.warn("Reflection", `Memory reflector failed: ${err}`);
            return [];
          }
        })(),
      ]);

      config.onReflectionComplete?.(errorEntries.length, memoryEntries.length);

      // Reset accumulated state so the next agent.run() gets fresh data
      userQuery = null;
      lastConversation = [];
    },
  };

  return { ...hook, notebook: notebook ?? null, memoryManager: memoryManager ?? null };
}
