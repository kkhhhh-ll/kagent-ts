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
  /**
   * LLM provider for both error reflection and memory extraction.
   *
   * When `reflectionLLM` or `memoryLLM` are set, those take precedence
   * for their respective subsystems — `llm` becomes the fallback for
   * whichever subsystem doesn't have its own provider.
   */
  llm: LLMProvider;

  /**
   * LLM provider for error reflection only.
   * Default: `llm`.
   * Using a different model here provides an independent review perspective.
   */
  reflectionLLM?: LLMProvider;

  /**
   * LLM provider for memory extraction only.
   * Default: `llm`.
   * Memory extraction is a distinct task from error reflection — using a
   * separate model lets you tune cost/quality independently for each.
   */
  memoryLLM?: LLMProvider;

  /** ErrorNotebook for persisting error reflection findings. Independently configurable — omit to disable error reflection. */
  notebook?: ErrorNotebook;
  /** MemoryManager for persisting extracted memories. Independently configurable — omit to disable memory extraction. */
  memoryManager?: MemoryManager;
  /** Max ReAct iterations for the error reflector sub-agent (default: 4). */
  maxErrorIterations?: number;
  /** Max ReAct iterations for the memory reflector sub-agent (default: 5). */
  maxMemoryIterations?: number;
  /** Hooks (e.g. TraceLogger) forwarded to both fork sub-agents. */
  hooks?: AgentHooks | AgentHooks[];
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
 * reflection. Error reflection and memory extraction are independently
 * configurable — enable either, both, or neither. Each can use its own
 * LLM provider (or fall back to the shared `llm`).
 *
 * When both are configured, the two forks run in parallel with their
 * own isolated contexts — neither blocks the main agent's response.
 *
 * ```ts
 * // Both error reflection and memory extraction, with separate models
 * const router = new ModelRouter({
 *   main: new OpenAIProvider({ model: "gpt-4o" }),
 *   reflection: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
 *   memory: new OpenAIProvider({ model: "gpt-4o-mini" }),
 * });
 *
 * const hook = createReflectionHook({
 *   llm: router.forReflection(),           // fallback for both
 *   memoryLLM: router.forMemory(),          // separate model for memory
 *   notebook: errorNotebook,
 *   memoryManager: memoryManager,
 * });
 *
 * // Or use explicit providers directly:
 * const hook2 = createReflectionHook({
 *   llm: mainProvider,
 *   reflectionLLM: new OpenAIProvider({ model: "gpt-4o" }),
 *   memoryLLM: new OpenAIProvider({ model: "gpt-4o-mini" }),
 *   notebook: errorNotebook,
 *   memoryManager: memoryManager,
 * });
 *
 * const agent = new ReActAgent({ llm: router, hooks: hook });
 * const answer = await agent.run("...");
 * // After answer is returned, configured forks run in parallel:
 * //   1. Error reflector (if configured) → finds mistakes → persists to notebook
 * //   2. Memory extractor (if configured) → extracts memories → persists to .memory/
 * ```
 */
export function createReflectionHook(
  config: ReflectionHookConfig,
): AgentHooks & { readonly notebook: ErrorNotebook | null; readonly memoryManager: MemoryManager | null } {
  const { llm, notebook, memoryManager } = config;
  const reflectionLLM = config.reflectionLLM ?? llm;
  const memoryLLM = config.memoryLLM ?? llm;
  const logger = config.logger ?? new ConsoleLogger();

  // Accumulate state across hook calls
  let userQuery: string | null = null;
  let lastConversation: MessageData[] = [];

  const errorReflector = notebook
    ? new ReflectionAgent({
        llm: reflectionLLM,
        notebook,
        maxIterations: config.maxErrorIterations,
        logger,
        hooks: config.hooks,
      })
    : null;

  const memoryReflector = memoryManager
    ? new MemoryReflector({
        llm: memoryLLM,
        memoryManager,
        maxIterations: config.maxMemoryIterations,
        logger,
        hooks: config.hooks,
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
            logger.error("Reflection", `Error reflector failed: ${err instanceof Error ? err.message : String(err)}`);
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
            logger.error("Reflection", `Memory reflector failed: ${err instanceof Error ? err.message : String(err)}`);
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
