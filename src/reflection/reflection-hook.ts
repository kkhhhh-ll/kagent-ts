import { AgentHooks } from "../core/hooks";
import { MessageData } from "../messages/types";
import { LLMProvider } from "../llm/interface";
import { ReflectionAgent } from "./reflection-agent";
import { ErrorNotebook } from "./error-notebook";

/**
 * Configuration for the reflection hook.
 */
export interface ReflectionHookConfig {
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** ErrorNotebook for persisting findings. */
  notebook: ErrorNotebook;
  /** Max reflection iterations (default: 3). */
  maxIterations?: number;
  /**
   * Callback invoked with the final reflection findings.
   * Use this to log, alert, or post-process.
   */
  onReflectionComplete?: (entryCount: number, score?: number) => void;
}

/**
 * Create an AgentHooks implementation that runs post-execution
 * self-reflection via a ReflectionAgent.
 *
 * Attach this hook to any agent to automatically review each session:
 *
 * ```ts
 * const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });
 * const hook = createReflectionHook({ llm, notebook });
 * const agent = new ReActAgent({ llm, hooks: hook });
 * const answer = await agent.run("...");
 * // Reflection runs automatically after onFinish
 * ```
 *
 * How it works:
 * - Captures the full conversation from the last LLM call's message array.
 * - On `onFinish`, spawns a ReflectionAgent that analyses the session's
 *   conversation + answer against the user's original query.
 * - Findings are persisted to the ErrorNotebook (错题本).
 * - The notebook can later be queried: `hook.notebook.buildRulesPrompt()`
 *   to inject learned rules into future sessions' system prompts.
 */
export function createReflectionHook(
  config: ReflectionHookConfig,
): AgentHooks & { readonly notebook: ErrorNotebook } {
  const { llm, notebook, maxIterations } = config;

  // Accumulate state across hook calls
  let userQuery: string | null = null;
  let lastConversation: MessageData[] = [];

  const reflector = new ReflectionAgent({ llm, notebook, maxIterations });

  const hook: AgentHooks = {
    // ── Capture the full conversation from each LLM call ──────────────
    onLLMStart(messages: MessageData[]): void {
      // Capture the first user message as the original query
      if (!userQuery) {
        const firstUser = messages.find(
          (m) => m.role === "user" && !m.content.startsWith("[Sub-agent"),
        );
        if (firstUser) userQuery = firstUser.content;
      }

      // Keep the latest full conversation snapshot.
      // By the time onFinish fires, this will hold the messages
      // sent in the last LLM call (full history up to that point).
      lastConversation = messages;
    },

    // ── Run reflection after the agent finishes ──────────────────────
    onFinish: async (finalAnswer: string) => {
      try {
        const entries = await reflector.reflect({
          userQuery: userQuery ?? "(unknown)",
          finalAnswer,
          conversation: lastConversation,
          sessionId: `session_${Date.now()}`,
        });

        if (entries.length > 0) {
          console.log(
            `[Reflection] Recorded ${entries.length} finding(s) to the error notebook.`,
          );
        }

        config.onReflectionComplete?.(entries.length);
      } catch (err) {
        // Reflection is best-effort — never crash the main agent.
        console.warn("[Reflection] Reflection agent failed:", err);
      }
    },
  };

  return { ...hook, notebook };
}
