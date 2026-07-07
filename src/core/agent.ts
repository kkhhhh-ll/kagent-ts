import { LLMProvider, ToolCall } from "../llm/interface";
import { LLMNetworkError } from "../llm/errors";
import { ModelRouter } from "../llm/model-router";
import { Message } from "../messages/message";
import { SECURITY_GUIDANCE, SUB_AGENT_DELEGATION } from "./system-prompts";
import { wrapAndScan } from "../security/boundaries";
import { ContextManager } from "../context/context-manager";
import { Tool } from "./types";
import { ToolRegistry } from "../tools/tool-registry";
import { ToolErrorTracker } from "../tools/error-tracker";
import { ToolOutputTruncator } from "../tools/tool-output-truncator";
import { ToolResult, ToolErrorCode, toolError } from "../tools/types";
import { validateToolArgs } from "../tools/tool-validator";
import { SkillManager } from "../skills/skill-manager";
import { MemoryManager } from "../memory/memory-manager";
import { ProjectRules } from "../rules/project-rules";
import { SessionManager } from "../session/session-manager";
import { SessionState, SessionStatus, AgentType } from "../session/session-types";
import { countTokens } from "../utils/token-counter";
import { PreferenceManager } from "../preferences/preference-manager";
import { AgentHooks } from "./hooks";
import { McpClientManager } from "../mcp/mcp-client-manager";
import type { McpServerConfig } from "../mcp/mcp-types";
import { SubAgentManager } from "../subagent/subagent-manager";
import type { SubAgentResult } from "../subagent/subagent-types";
import { RAGManager } from "../rag/rag-manager";
import type { RAGConfig } from "../rag/rag-types";
import { createSearchKnowledgeTool, createListKnowledgeDocumentsTool } from "../rag/search-knowledge";
import { createListSubagentsTool } from "../tools/builtin/list-subagents";
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent";
import { createListErrorsTool } from "../tools/builtin/list-errors";
import { createSkillTool } from "../tools/builtin/skill";
import { createRememberTool } from "../tools/builtin/remember";
import { createRecallTool } from "../tools/builtin/recall";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin";
import { Logger, ConsoleLogger } from "../logging/logger";
import { TokenBudget, TokenBudgetConfig } from "../llm/token-budget";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Callback for human-in-the-loop tool approval.
 *
 * Called before executing a tool marked `requireApproval: true`.
 * Return `true` to approve execution, `false` to deny it.
 */
export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<boolean>;

/**
 * Base configuration for any Agent.
 */
export interface AgentConfig {
  llm: LLMProvider;
  contextManager?: ContextManager;

  /**
   * Plain tool array (legacy). If `toolRegistry` is provided, this is ignored.
   * If neither is set, defaults to an empty tool list.
   */
  tools?: Tool[];

  /**
   * A pre-configured ToolRegistry with circuit-breaker support.
   * Takes precedence over the plain `tools` array.
   */
  toolRegistry?: ToolRegistry;

  /**
   * Max bytes a tool output can be before it is automatically truncated.
   * When a tool returns a result larger than this, the first 2 KB are kept
   * in context and the full output is saved to disk for on-demand reading.
   *
   * Set to 0 (default) to disable truncation.
   *
   * Only used when `toolRegistry` is NOT provided (the framework creates
   * its own registry).
   */
  toolOutputMaxBytes?: number;

  /**
   * Number of retry attempts allowed per tool before its circuit
   * breaker opens. Only used with the plain `tools` array path
   * (ignored when `toolRegistry` is provided).
   * Default: 2 (3 total attempts: 1 initial + 2 retries).
   */
  toolRetryCount?: number;

  /**
   * Error tracker for recording tool failure chains.
   * Only used with the plain `tools` array path
   * (ignored when `toolRegistry` is provided).
   */
  toolErrorTracker?: ToolErrorTracker;

  /**
   * A pre-configured SkillManager. If provided, `skillsDir` is ignored.
   */
  skillManager?: SkillManager;

  /**
   * Path to a directory of file-based skills.
   *
   * Each subdirectory should contain a `SKILL.md` file with YAML-like
   * frontmatter (name, description, keywords) and a body that serves
   * as the system prompt. Optional `reference/` and `scripts/`
   * subdirectories provide additional context and tools.
   *
   * Skills are lazily loaded: only metadata is registered upfront;
   * full content loads on activation.
   */
  skillsDir?: string;

  /**
   * Path to the long-term memory storage directory.
   * Default: ".memory". The MemoryManager persists facts, rules, and
   * decisions across sessions using an index (MEMORY.md) + individual
   * markdown files.
   */
  memoryDir?: string;

  /**
   * Path to a project rules file (e.g. "RULES.md") or directory (e.g.
   * ".rules/"). Rules are user-authored, always injected into the system
   * prompt, and reloaded at the start of each run.
   */
  rulesPath?: string;

  /**
   * Optional system prompt string appended to the default system prompt.
   * Provides a base instruction layer that is always injected into the
   * system prompt for every run.
   */
  systemPrompt?: string;

  /**
   * Lifecycle hooks for observing agent execution.
   * Accepts a single AgentHooks or an array of them.
   */
  hooks?: AgentHooks | AgentHooks[];

  /**
   * Human-in-the-loop approval callback.
   *
   * Called before executing tools marked `requireApproval: true`.
   * Return `true` to approve, `false` to deny (the tool is skipped and
   * an APPROVAL_DENIED result is injected into context).
   *
   * If not provided, tools with `requireApproval: true` are ALWAYS DENIED
   * (safe default — no silent execution of dangerous tools).
   */
  onToolApproval?: ApprovalCallback;

  /**
   * Maximum time (ms) to wait for the `onToolApproval` callback before
   * applying the timeout strategy. Prevents the agent from hanging
   * indefinitely when the human reviewer is unavailable.
   *
   * Default: 120_000 (2 minutes).
   */
  approvalTimeoutMs?: number;

  /**
   * What to do when `onToolApproval` does not respond within
   * `approvalTimeoutMs`.
   *
   * - `"deny"` (default): Treat the tool as denied. Safe for destructive
   *   operations — the LLM must find a different approach.
   * - `"allow"`: Execute the tool anyway. Use only for non-destructive
   *   tools in trusted environments.
   *
   * Default: "deny".
   */
  approvalTimeoutStrategy?: "deny" | "allow";

  /**
   * Logger instance for framework-internal messages.
   * Defaults to {@link ConsoleLogger} (writes to `console` with `[Tag]` prefix).
   * Pass a {@link SilentLogger} to suppress all framework output.
   */
  logger?: Logger;

  // ─── User Preferences ───────────────────────────────────────────────

  /**
   * Path to the preferences markdown file.
   * Default: ".kagent/preferences.md". Preferences are loaded
   * automatically and auto-reloaded before each run.
   */
  preferencesPath?: string;

  // ─── Session Persistence ─────────────────────────────────────────────

  /**
   * Optional session ID for checkpoint persistence.
   * If set (or if `sessionDir` is set), a SessionManager is created.
   */
  sessionId?: string;

  /**
   * Directory for session checkpoint files (default: `.kagent-sessions/`).
   */
  sessionDir?: string;

  /**
   * Enable automatic checkpoint saving during the run loop.
   * When true, snapshots are saved after each LLM+tools cycle so the
   * session can be resumed after a network interruption.
   *
   * Default: false (existing consumers see no behavior change).
   */
  enableCheckpointing?: boolean;

  // ─── MCP Server Configuration ─────────────────────────────────────────

  /**
   * MCP (Model Context Protocol) server configurations for dynamic tool
   * discovery. Each key is the server name used as a prefix for discovered
   * tools (e.g., a server named "filesystem" exposing tool "read" becomes
   * available as "filesystem_read").
   *
   * Servers are connected asynchronously when `run()` is called (the
   * constructor is synchronous). If a connection fails, a warning is
   * logged and the other servers still connect.
   *
   * Prefer {@link mcpConfigPath} for persistent, shareable configuration.
   * Inline `mcpServers` takes precedence over file-based config when the
   * same server name appears in both.
   *
   * @example
   * ```ts
   * mcpServers: {
   *   filesystem: {
   *     command: "npx",
   *     args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
   *   },
   * }
   * ```
   */
  mcpServers?: Record<string, McpServerConfig>;

  /**
   * Path to a JSON file containing MCP server configurations.
   *
   * The file should contain a JSON object mapping server names to
   * {@link McpServerConfig} objects — the same shape as {@link mcpServers}.
   *
   * Loaded at construction time (synchronously). Merged with inline
   * `mcpServers` — inline entries with the same name take precedence.
   *
   * This is the recommended way to configure MCP servers: keep
   * credentials and server details in a standalone file that can be
   * gitignored, shared across agents, or generated by tooling.
   *
   * @example mcp.json
   * ```json
   * {
   *   "filesystem": {
   *     "command": "npx",
   *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
   *   },
   *   "weather": {
   *     "url": "http://localhost:3001/sse"
   *   }
   * }
   * ```
   */
  mcpConfigPath?: string;

  // ─── Sub-Agent Configuration ───────────────────────────────────────────

  /**
   * Path to a directory of sub-agent definitions (AGENT.md files).
   *
   * Each subdirectory should contain an `AGENT.md` file with YAML-like
   * frontmatter (name, description, tools, skills) and a body that serves
   * as the system prompt.
   *
   * Sub-agents can be spawned by the main agent via the `spawn_subagent`
   * tool. They run asynchronously; results are injected back as user
   * messages.
   *
   * @example
   * ```
   * subagents/
   * ├── code-reviewer/
   * │   └── AGENT.md
   * └── researcher/
   *     └── AGENT.md
   * ```
   */
  subAgentsDir?: string;

  /**
   * LLM provider for sub-agents spawned by the main agent.
   *
   * When set, sub-agents use this provider instead of the main agent's LLM.
   * This enables model routing — use a cheaper/faster model for simple
   * sub-agent tasks while keeping the main model for complex reasoning.
   *
   * When omitted, sub-agents inherit the main agent's `llm` provider.
   *
   * @example
   * ```ts
   * const agent = new ReActAgent({
   *   llm: new OpenAIProvider({ model: "gpt-4o" }),
   *   subAgentLLM: new OpenAIProvider({ model: "gpt-4o-mini" }),
   *   subAgentsDir: "./subagents",
   * });
   * ```
   */
  subAgentLLM?: LLMProvider;

  /**
   * Lifecycle hooks for sub-agents spawned by the main agent.
   *
   * These hooks are passed to every sub-agent created via `spawn_subagent`,
   * enabling tracing, metrics, and logging of sub-agent execution. If not
   * set, sub-agents run without hooks (their internal execution is invisible
   * to the main agent's observers).
   *
   * Accepts a single {@link AgentHooks}, an array, or a factory function
   * `(name, runId) => AgentHooks | AgentHooks[]` called each time a
   * sub-agent is spawned — use the factory to create per-sub-agent
   * {@link TraceLogger} instances for isolated trace files.
   *
   * **WARNING**: Be careful with hooks that spawn MORE sub-agents (e.g.
   * {@link ReflectionHook}) — passing them here causes unbounded recursion.
   * Only pass pure-observation hooks ({@link TraceLogger}, evaluators, etc.).
   *
   * @example
   * ```ts
   * const mainTrace = new TraceLogger({ sessionId: "main" });
   * const agent = new ReActAgent({
   *   llm: provider,
   *   hooks: mainTrace,
   *   subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId),
   *   subAgentsDir: "./subagents",
   * });
   * ```
   */
  subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /**
   * RAG (Retrieval-Augmented Generation) configuration.
   *
   * When set, documents from `documentsDir` are indexed at startup and the
   * `search_knowledge` tool is registered so the LLM can retrieve relevant
   * context before answering.
   *
   * @example
   * ```ts
   * rag: {
   *   documentsDir: "./docs",
   *   embeddingProvider: new OpenAIEmbeddingProvider({ apiKey: "..." }),
   *   topK: 5,
   * }
   * ```
   */
  rag?: RAGConfig;

  /**
   * Token budget configuration for session-level cost control.
   * When set, the agent stops making LLM calls when cumulative token
   * consumption exceeds `maxTotalTokens`. The budget resets on
   * `clearConversation()` and `reset()`.
   */
  tokenBudgetConfig?: TokenBudgetConfig;

  /**
   * Enable parallel execution of tool calls within a single LLM response.
   *
   * When `true` (default), tool calls from the same LLM response that are
   * all parallel-safe (no `sequential: true` marks) execute concurrently
   * via `Promise.allSettled`. This reduces per-turn latency from
   * `sum(latency)` to `max(latency)`.
   *
   * Set to `false` to always execute tools one at a time (legacy behaviour).
   */
  enableParallelToolExecution?: boolean;

  /**
   * Working directory for this agent.
   *
   * When set, sub-agents spawned by this agent receive this as their
   * working directory so file operations and bash commands are scoped
   * to the correct location.  Used by the OrchestratorAgent to point
   * each sub-agent at its isolated git worktree.
   */
  workdir?: string;
}

/**
 * Abstract base Agent class.
 *
 * Provides the shared infrastructure:
 * - LLM provider
 * - Context window management
 * - Tool registry (with circuit breaker support)
 * - Skill manager (progressive disclosure)
 * - User preferences (system-prompt injection)
 * - Session manager (checkpoint persistence & resume)
 * - Abort controller (cancellation via SIGINT)
 *
 * Subclasses implement the actual agent logic (e.g., ReActAgent).
 */
export abstract class Agent {
  protected llm: LLMProvider;
  protected contextManager: ContextManager;
  protected toolRegistry: ToolRegistry;
  protected skillManager: SkillManager;

  /** Long-term memory (rules + project facts) persisted across sessions. */
  protected memoryManager!: MemoryManager;

  /** User-defined project rules loaded from disk. */
  protected projectRules!: ProjectRules;

  /** The original core system prompt (before skill sections are appended). */
  protected coreSystemPrompt: string;

  /** Preference manager for loading and injecting user preferences. */
  protected preferenceManager: PreferenceManager;

  /** Lifecycle hooks for observing agent execution. */
  protected hooks: AgentHooks[] = [];

  /** Logger for framework-internal messages. */
  protected logger: Logger;

  /** Token budget for session-level cost control (optional). */
  protected tokenBudget?: TokenBudget;

  /** Human-in-the-loop approval callback (from AgentConfig). */
  protected onToolApproval?: ApprovalCallback;

  /** Max ms to wait for approval before applying timeout strategy. */
  private approvalTimeoutMs: number;

  /** Timeout strategy: "deny" (safe default) or "allow". */
  private approvalTimeoutStrategy: "deny" | "allow";

  /** Whether to execute independent tool calls in parallel (default: true). */
  protected enableParallelToolExecution: boolean;

  // ─── Session & Cancellation ─────────────────────────────────────────

  /** Session manager for checkpoint persistence (optional). */
  protected sessionManager?: SessionManager;

  /** Whether auto-checkpointing is enabled. */
  protected checkpointingEnabled = false;

  /** Whether the current run has been cancelled by the user. */
  protected _cancelled = false;

  /** Controller for aborting in-flight LLM requests on cancellation. */
  protected _abortController?: AbortController;

  // ─── MCP (Model Context Protocol) ─────────────────────────────────────

  /** MCP server configurations (from AgentConfig). */
  protected mcpServerConfigs?: Record<string, McpServerConfig>;

  /** MCP client manager for dynamic tool discovery (lazily initialized). */
  protected mcpClientManager?: McpClientManager;

  /** Guards async init() from running more than once per instance. */
  private _mcpInitialized = false;

  // ─── RAG ────────────────────────────────────────────────────────────────

  /** RAG manager (lazily initialized in init()). */
  protected ragManager?: RAGManager;

  /** RAG configuration (from AgentConfig). */
  protected ragConfig?: RAGConfig;

  // ─── Sub-Agent ────────────────────────────────────────────────────────

  /** Sub-agent manager (lazily initialized in init()). */
  protected subAgentManager?: SubAgentManager;

  /** Sub-agent definitions directory (from AgentConfig). */
  protected subAgentsDir?: string;

  /** LLM provider for sub-agents (defaults to main llm if not set). */
  protected subAgentLLM?: LLMProvider;

  /** Hooks for sub-agents (from AgentConfig). */
  protected subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /** Skills directory path (from AgentConfig). */
  protected skillsDir?: string;

  /** Working directory for this agent (from AgentConfig). */
  protected workdir?: string;

  constructor(config: AgentConfig) {
    this._cancelled = false;
    this.llm = config.llm;
    this.logger = config.logger ?? new ConsoleLogger();
    this.onToolApproval = config.onToolApproval;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 120_000;
    this.approvalTimeoutStrategy = config.approvalTimeoutStrategy ?? "deny";
    this.enableParallelToolExecution = config.enableParallelToolExecution ?? true;
    this.contextManager = config.contextManager ?? new ContextManager(undefined, this.logger);

    // Prefer toolRegistry; fall back to plain tools array
    if (config.toolRegistry) {
      this.toolRegistry = config.toolRegistry;
    } else {
      const truncator = (config.toolOutputMaxBytes && config.toolOutputMaxBytes > 0)
        ? new ToolOutputTruncator(config.toolOutputMaxBytes)
        : undefined;
      this.toolRegistry = new ToolRegistry(
        config.toolRetryCount,
        config.toolErrorTracker,
        truncator,
      );
      if (config.tools && config.tools.length > 0) {
        this.toolRegistry.registerMany(config.tools);
      }
    }

    // Skill manager — file-based progressive disclosure
    if (config.skillManager) {
      this.skillManager = config.skillManager;
    } else {
      this.skillManager = new SkillManager(this.logger);
    }

    // Register file-based skills if a directory is configured
    if (config.skillsDir) {
      this.skillManager.registerFromDirectory(config.skillsDir);
    }

    // Memory — long-term facts, rules, and project context
    this.memoryManager = new MemoryManager(config.memoryDir);

    // Project rules — user-authored, always injected
    this.projectRules = new ProjectRules(config.rulesPath, this.logger);

    // Store core system prompt and set it
    this.coreSystemPrompt = config.systemPrompt ?? "";
    if (this.coreSystemPrompt) {
      this.contextManager.setSystemMessage(this.coreSystemPrompt);
    }

    // Session manager — only created when session ID or session dir is provided
    if (config.sessionId || config.sessionDir) {
      this.sessionManager = new SessionManager({
        sessionId: config.sessionId,
        sessionDir: config.sessionDir,
      });
    }
    this.checkpointingEnabled = config.enableCheckpointing ?? false;
    this.mcpServerConfigs = Agent.loadMcpConfig(
      config.mcpConfigPath,
      config.mcpServers,
      this.logger,
    );
    this.subAgentsDir = config.subAgentsDir;
    this.subAgentHooks = config.subAgentHooks;
    this.skillsDir = config.skillsDir;
    this.workdir = config.workdir;
    this.ragConfig = config.rag;

    // Resolve sub-agent LLM:
    // 1. Explicit `subAgentLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forSubAgent()
    // 3. Fallback → sub-agents share the main `llm`
    if (config.subAgentLLM) {
      this.subAgentLLM = config.subAgentLLM;
    } else if (config.llm instanceof ModelRouter) {
      this.subAgentLLM = config.llm.forSubAgent();
    }

    // Token budget — session-level cost control
    if (config.tokenBudgetConfig) {
      this.tokenBudget = new TokenBudget(config.tokenBudgetConfig);
    }

    // ── Hooks ──────────────────────────────────────────────────────────────
    const rawHooks = config.hooks ?? [];
    this.hooks = Array.isArray(rawHooks) ? rawHooks : [rawHooks];

    // ── User Preferences ─────────────────────────────────────────────────
    this.preferenceManager = new PreferenceManager(
      { filePath: config.preferencesPath ?? ".kagent/preferences.md" },
      this.logger,
    );
  }

  /**
   * Run the agent with the given user input and return the final response.
   */
  abstract run(input: string): Promise<string>;

  // ─── Tool Management ─────────────────────────────────────────────────

  /**
   * Add a tool to the agent's registry.
   */
  addTool(tool: Tool): void {
    this.toolRegistry.register(tool);
  }

  /**
   * Get the tool registry (for advanced management).
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  // ─── Skill Management ────────────────────────────────────────────────

  /**
   * Get the SkillManager (for advanced management).
   */
  getSkillManager(): SkillManager {
    return this.skillManager;
  }

  /**
   * Activate a skill by name and rebuild the system prompt to include it.
   *
   * @returns true if the skill was newly activated.
   */
  activateSkill(name: string): boolean {
    const activated = this.skillManager.activate(name);
    if (activated) {
      this.rebuildSystemPrompt();
    }
    return activated;
  }

  /**
   * Deactivate a skill and rebuild the system prompt.
   */
  deactivateSkill(name: string): boolean {
    const deactivated = this.skillManager.deactivate(name);
    if (deactivated) {
      this.rebuildSystemPrompt();
    }
    return deactivated;
  }

  /**
   * Register an additional lifecycle hook.
   * Multiple hooks can be registered to observe agent execution.
   */
  addHook(hook: AgentHooks): void {
    this.hooks.push(hook);
  }

  /**
   * Rebuild the system message.
   *
   * Sections are assembled in priority order:
   *   1. Core prompt           (agent identity + instructions)
   *   2. Project rules         (user-authored, always injected)
   *   3. Preferences           (user-set language / verbosity / style)
   *   4. Error recovery rules  (tool failure recovery guidance)
   *   5. Long-term memories    (index of persisted facts + rules)
   *   6. Available skills      (inactive skills the LLM can activate)
   *   7. Active skill content  (full instructions for activated skills)
   *
   * Empty sections are silently skipped.
   */
  /**
   * Build the full system prompt from all sections.
   *
   * Subclasses that need to append extra content (e.g. plan progress)
   * should call this and concatenate, instead of duplicating the assembly.
   */
  protected buildSystemPrompt(): string {
    const sections = [
      this.coreSystemPrompt,
      SECURITY_GUIDANCE,
      this.hasSubAgents() ? SUB_AGENT_DELEGATION : "",
      this.projectRules.buildPrompt(),
      this.preferenceManager.buildPrompt(),
      this.memoryManager.buildPromptHint(),
      this.skillManager.buildAvailableSkillsHint(),
      this.skillManager.buildSkillsPrompt(),
    ].filter(Boolean);

    return sections.join("");
  }

  protected rebuildSystemPrompt(): void {
    this.contextManager.setSystemMessage(this.buildSystemPrompt());
  }

  /**
   * Pre-iteration maintenance: compress context window if needed.
   */
  protected async checkAndCompress(): Promise<void> {
    await this.contextManager.checkAndCompress(this.llm);
  }

  /**
   * Reload preferences from disk if the file was manually edited.
   * Called once at the start of each run so edits between runs take
   * effect without restarting the agent process — but they won't
   * change mid-run behavior.
   */
  protected reloadPreferencesIfChanged(): boolean {
    if (this.preferenceManager?.reloadIfChanged()) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /**
   * Re-scan the skills directory for new SKILL.md files added between runs.
   * New skills are registered and become available to the LLM immediately.
   */
  protected reloadSkillsFromDirectory(): boolean {
    if (!this.skillsDir) return false;
    const added = this.skillManager.reloadFromDirectory(this.skillsDir);
    if (added.length > 0) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /**
   * Re-read the MEMORY.md index from disk if it was manually edited
   * between runs. The index is a lightweight list of memory names +
   * descriptions — full content is loaded on demand via the recall tool.
   */
  protected reloadMemoryIfChanged(): boolean {
    if (this.memoryManager.reloadIfChanged()) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /**
   * Load MCP server config from a JSON file, merge with inline overrides.
   *
   * File-based config is the recommended approach for persistent, shareable
   * MCP configuration. Inline `mcpServers` entries with the same server
   * name take precedence over file entries.
   *
   * @param configPath  Path to the JSON config file (optional).
   * @param inline      Inline MCP server configs from AgentConfig (optional).
   * @param logger      Logger for warnings.
   * @returns Merged config map, or `undefined` if neither source is provided.
   */
  private static loadMcpConfig(
    configPath: string | undefined,
    inline: Record<string, McpServerConfig> | undefined,
    logger: Logger,
  ): Record<string, McpServerConfig> | undefined {
    let fileConfig: Record<string, McpServerConfig> = {};

    if (configPath) {
      const resolved = path.resolve(configPath);
      try {
        const raw = fs.readFileSync(resolved, "utf-8");
        fileConfig = JSON.parse(raw);
        if (typeof fileConfig !== "object" || fileConfig === null) {
          logger.warn("MCP", `"${resolved}" is not a valid JSON object — ignoring.`);
          fileConfig = {};
        }
      } catch (err) {
        logger.warn("MCP", `Failed to load MCP config from "${resolved}": ${err instanceof Error ? err.message : err}`);
        fileConfig = {};
      }
    }

    // Merge: inline takes precedence over file for same server name
    const merged = { ...fileConfig, ...inline };

    if (Object.keys(merged).length === 0) return undefined;
    return merged;
  }

  /**
   * Incrementally connect to MCP servers that were added to the config
   * since the last run. Already-connected servers are left untouched.
   */
  protected async reconnectMCPIfNeeded(): Promise<void> {
    if (!this.mcpClientManager || !this.mcpServerConfigs) return;

    const newServers: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(this.mcpServerConfigs)) {
      if (!this.mcpClientManager.hasServer(name)) {
        newServers[name] = config;
      }
    }

    if (Object.keys(newServers).length === 0) return;

    const errors = await this.mcpClientManager.connectAll(newServers);
    if (errors.length > 0) {
      this.logger.warn(
        "MCP",
        `${errors.length} new server(s) failed to connect: ` +
        errors.map((e) => e.serverName).join(", "),
      );
    }
  }

  /**
   * Reload all dynamic resources at the start of a run.
   * Picks up changes made between conversation turns.
   */
  protected async reloadDynamicResources(): Promise<void> {
    this.reloadPreferencesIfChanged();  // rebuilds internally if changed
    const rulesChanged = this.projectRules.reloadIfChanged();
    this.reloadSkillsFromDirectory();   // rebuilds internally if changed
    this.reloadMemoryIfChanged();       // rebuilds internally if changed

    if (rulesChanged) {
      this.rebuildSystemPrompt();
    }

    await this.reconnectMCPIfNeeded();
  }

  /**
   * After a resume, recover results from sub-agents that were cancelled
   * mid-run. Completed results are injected into context so the LLM can
   * see them; still-running sub-agents get a notice.
   */
  protected recoverOrphanedSubAgentResults(): void {
    if (!this.subAgentManager) return;

    const orphaned = this.subAgentManager.collectOrphanedResults();
    for (const r of orphaned) {
      const msg = Message.user(
        `[Sub-agent "${r.name}" (${r.subAgentId}) — recovered after interruption]\n\n${r.output}`,
      );
      this.contextManager.addMessage(msg.toDict());
    }

    // If some cancelled sub-agents are still running, let the LLM know
    const stillRunning = this.subAgentManager.getActiveCount();
    if (stillRunning > 0) {
      const msg = Message.user(
        `[System] ${stillRunning} sub-agent(s) from the previous session are still running. ` +
        `Their results will appear when ready. Do not re-spawn them.`,
      );
      this.contextManager.addMessage(msg.toDict());
    }
  }

  /**
   * Validate that user input won't overwhelm the context window.
   *
   * Returns a user-facing error string if the input is too large,
   * or `null` if it passes the check.
   */
  protected validateInputSize(input: string): string | null {
    const { maxTokens } = this.contextManager.getState();
    const inputTokens = countTokens(input);

    // Reserve ~20% for system prompt + tools + response overhead
    const maxSafeInput = Math.floor(maxTokens * 0.8);

    if (inputTokens > maxSafeInput) {
      return (
        `Your input is too large (~${inputTokens} tokens). ` +
        `The maximum safe input size is ~${maxSafeInput} tokens ` +
        `(context window: ${maxTokens} tokens, with 20% reserved for system overhead). ` +
        `Please split your request into smaller parts.`
      );
    }

    return null;
  }

  /**
   * Check whether a tool that requires approval should be executed.
   *
   * @returns `true` if approved, `false` if denied (or no callback configured).
   */
  /**
   * Check whether a tool requiring human approval should be executed.
   *
   * Waits for the {@link onToolApproval} callback, but enforces a timeout
   * so the agent never hangs indefinitely waiting for a human who may be
   * away. Also respects the agent-wide {@link AbortSignal} so cancelling
   * the session interrupts any pending approval.
   *
   * @returns `true` if approved, `false` if denied / timed out / cancelled.
   */
  protected async checkToolApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.onToolApproval) {
      this.logger.warn(
        "Approval",
        `Tool "${toolName}" requires approval but no onToolApproval configured — denied.`,
      );
      return false;
    }

    const signal = this._abortController?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const result = await Promise.race([
        this.onToolApproval(toolName, args),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), this.approvalTimeoutMs);
        }),
        // Also race against cancellation: if the agent is aborted, stop waiting
        new Promise<"cancelled">((resolve) => {
          if (signal?.aborted) {
            resolve("cancelled");
            return;
          }
          onAbort = () => resolve("cancelled");
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);

      if (result === "timeout") {
        this.logger.warn(
          "Approval",
          `Timeout (${this.approvalTimeoutMs}ms) waiting for approval of "${toolName}" — ` +
          `strategy: ${this.approvalTimeoutStrategy}.`,
        );
        return this.approvalTimeoutStrategy === "allow";
      }

      if (result === "cancelled") {
        this.logger.info(
          "Approval",
          `Approval for "${toolName}" cancelled (agent aborted) — denied.`,
        );
        return false;
      }

      return result;
    } catch {
      this.logger.warn(
        "Approval",
        `Approval callback threw for "${toolName}" — denied.`,
      );
      return false;
    } finally {
      // Clean up listeners to prevent accumulation on the shared AbortSignal
      // across many tool-approval calls in a single agent run (Node.js warns at >10).
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Execute a batch of tool calls from a single LLM response.
   *
   * When `enableParallelToolExecution` is true and all tools in the batch are
   * parallel-safe (`sequential` is not set), tools execute concurrently via
   * `Promise.allSettled`. Otherwise, they execute one at a time (serial).
   *
   * Handles the full lifecycle for each tool call:
   * 1. Parse JSON arguments (malformed args → error result, no execution)
   * 2. HITL approval check for tools marked `requireApproval`
   * 3. Hook notifications (`onToolStart`, `onToolEnd`, `onToolError`)
   * 4. Execution via `ToolRegistry.execute()`
   * 5. Context injection (all results added after execution completes)
   * 6. Post-execution: sub-agent spawn tracking, MCP failure warnings
   *
   * @param toolCalls       The tool calls from the LLM response.
   * @param mcpWarnedServers Set tracking which MCP servers have already
   *                         been warned about in this batch.
   * @returns Whether any tool in the batch failed.
   */
  protected async executeToolCallsBatch(
    toolCalls: ToolCall[],
    mcpWarnedServers: Set<string>,
  ): Promise<{ hadFailure: boolean }> {
    // Per-slot state: parsed args + eventual result
    interface Slot {
      toolCall: ToolCall;
      args: Record<string, unknown>;
      result?: ToolResult;
    }

    // ── Step 1: Parse & validate all arguments up front ──────────────
    const slots: Slot[] = [];
    for (const tc of toolCalls) {
      // 1a. JSON syntax check
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        const result = toolError(
          ToolErrorCode.ARGUMENTS_PARSE_ERROR,
          `[RETRYABLE:ARGUMENTS_PARSE_ERROR] Failed to parse arguments for tool "${tc.function.name}". ` +
            `The raw arguments were: ${tc.function.arguments || "(empty)"}\n\n` +
            `Please re-invoke the tool with correctly formatted JSON arguments.`,
          "retryable",
        );
        for (const h of this.hooks) h.onToolError?.(tc.function.name, result.content, tc.id);
        slots.push({ toolCall: tc, args: {}, result });
        continue;
      }

      // 1b. JSON Schema validation against the tool's parameter definition
      const tool = this.toolRegistry.getTool(tc.function.name);
      if (tool) {
        const validationError = validateToolArgs(tc.function.name, tool.parameters, args);
        if (validationError) {
          for (const h of this.hooks) h.onToolError?.(tc.function.name, validationError.content, tc.id);
          slots.push({ toolCall: tc, args, result: validationError });
          continue;
        }
      }

      slots.push({ toolCall: tc, args });
    }

    // ── Step 2: HITL approval — check all requiring tools upfront ────
    for (const slot of slots) {
      if (slot.result) continue; // already failed at parse stage
      const tool = this.toolRegistry.getTool(slot.toolCall.function.name);
      if (tool?.requireApproval) {
        const approved = await this.checkToolApproval(
          slot.toolCall.function.name,
          slot.args,
        );
        if (!approved) {
          slot.result = toolError(
            ToolErrorCode.APPROVAL_DENIED,
            `[FATAL:APPROVAL_DENIED] Tool "${slot.toolCall.function.name}" requires approval and was denied. ` +
              `Do NOT retry this tool. Find a different approach.`,
            "fatal",
          );
          for (const h of this.hooks) h.onToolError?.(slot.toolCall.function.name, slot.result.content, slot.toolCall.id);
        }
      }
    }

    // ── Step 3: Decide serial vs parallel ──────────────────────────────
    const executable = slots.filter((s) => !s.result);
    const allParallelSafe = executable.every((s) => {
      const tool = this.toolRegistry.getTool(s.toolCall.function.name);
      return !tool?.sequential;
    });
    const shouldParallelize =
      this.enableParallelToolExecution &&
      allParallelSafe &&
      executable.length > 1;

    // ── Step 4: Execute ────────────────────────────────────────────────
    if (shouldParallelize) {
      // Log and fire hooks before concurrent execution
      for (const slot of executable) {
        this.logger.info("Action", slot.toolCall.function.name);
        for (const h of this.hooks) h.onToolStart?.(slot.toolCall.function.name, slot.args, slot.toolCall.id);
      }

      // Execute all in parallel.
      // Each task fires its own onToolEnd / onToolError hooks so the
      // TraceLogger (and other hook consumers) see events in actual
      // completion order rather than array order.
      await Promise.allSettled(
        executable.map(async (slot) => {
          const result = await this.toolRegistry.execute(
            slot.toolCall.function.name,
            slot.args,
          );
          slot.result = result;

          if (result.success) {
            for (const h of this.hooks) h.onToolEnd?.(slot.toolCall.function.name, result.content, slot.toolCall.id);
          } else {
            for (const h of this.hooks) h.onToolError?.(slot.toolCall.function.name, result.content, slot.toolCall.id);
          }
        }),
      );
    } else {
      // Serial path (legacy behaviour or forced by sequential tools)
      for (const slot of executable) {
        this.logger.info("Action", slot.toolCall.function.name);
        for (const h of this.hooks) h.onToolStart?.(slot.toolCall.function.name, slot.args, slot.toolCall.id);

        slot.result = await this.toolRegistry.execute(
          slot.toolCall.function.name,
          slot.args,
        );

        if (slot.result.success) {
          for (const h of this.hooks) h.onToolEnd?.(slot.toolCall.function.name, slot.result.content, slot.toolCall.id);
        } else {
          for (const h of this.hooks) h.onToolError?.(slot.toolCall.function.name, slot.result.content, slot.toolCall.id);
        }
      }
    }

    // ── Step 5: Inject results into context & post-process ─────────────
    let hadFailure = false;
    for (const slot of slots) {
      const result = slot.result!;
      const toolName = slot.toolCall.function.name;

      const toolMessage = Message.tool(
        wrapAndScan(`tool:${toolName}`, result.content),
        slot.toolCall.id,
        toolName,
      );
      this.contextManager.addMessage(toolMessage.toDict());

      if (!result.success) {
        hadFailure = true;
      }

      // Sub-agent spawned — purely informational; results arrive
      // asynchronously and will be injected via pollSubAgentResults().
      if (result.success && slot.toolCall.function.name === "spawn_subagent") {
        this.logger.info(
          "SubAgent",
          `Spawned "${slot.args.name ?? "unknown"}" — ` +
            `result will arrive in a later iteration.`,
        );
      }

      // MCP tool failure — warn about potential connection loss.
      // Only warn once per server per batch to avoid duplicate messages.
      if (
        !result.success &&
        !BUILTIN_TOOL_NAMES.has(slot.toolCall.function.name)
      ) {
        const serverName =
          slot.toolCall.function.name.split("_")[0] ?? "unknown";
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
                `further calls to this server may fail.`,
            );
            const mcpWarn = Message.system(
              `MCP server "${serverName}" appears to be disconnected: ${result.content.slice(0, 200)}`,
            );
            this.contextManager.addMessage(mcpWarn.toDict());
          }
        }
      }
    }

    return { hadFailure };
  }

  /**
   * Check whether the token budget allows another LLM call.
   *
   * @param estimatedInputTokens  Approximate tokens in the upcoming request
   *                              (system prompt + context messages).
   * @returns A user-facing error string if the budget is exhausted,
   *          or `null` if the call can proceed.
   */
  protected checkTokenBudget(estimatedInputTokens: number): string | null {
    if (!this.tokenBudget) return null;

    const status = this.tokenBudget.checkBeforeCall(estimatedInputTokens);
    if (status.isExhausted) {
      return (
        `Token budget exhausted: ${status.totalTokensUsed.toLocaleString()}/${status.maxTotalTokens.toLocaleString()} tokens used ` +
        `across ${status.callCount} LLM calls. ` +
        `Start a new conversation with agent.newTopic() or agent.clearConversation() to reset the budget.`
      );
    }

    // One-shot warning at 80 %
    if (this.tokenBudget.shouldWarn()) {
      this.logger.warn(
        "TokenBudget",
        `Warning: ${Math.round(status.totalTokensUsed / status.maxTotalTokens * 100)}% of budget used ` +
        `(${status.totalTokensUsed.toLocaleString()}/${status.maxTotalTokens.toLocaleString()} tokens).`,
      );
    }

    return null;
  }

  // ─── Cancellation ────────────────────────────────────────────────────

  /**
   * Cancel the current run.
   *
   * Aborts any in-flight LLM request via the AbortController, sets the
   * cancellation flag, and cancels all running sub-agents. The agent loop
   * will save a "cancelled" checkpoint and exit at its next iteration.
   * The session is preserved on disk and can be resumed later.
   */
  cancel(): void {
    // Abort the in-flight LLM request first so the agent doesn't keep
    // waiting for a response that's about to be discarded anyway.
    this._abortController?.abort();
    this._cancelled = true;
    this.subAgentManager?.cancelAll();
  }

  /**
   * Whether the run has been cancelled by the user.
   */
  get isCancelled(): boolean {
    return this._cancelled;
  }

  // ─── Session Persistence ─────────────────────────────────────────────

  /**
   * Build a base SessionState from the current agent state.
   * Subclasses override this to include agent-specific state (e.g. plan).
   */
  protected buildBaseSessionState(status: SessionStatus): SessionState {
    return {
      sessionId: this.sessionManager?.getSessionId() ?? "unknown",
      agentType: this.getAgentType(),
      systemPrompt: this.coreSystemPrompt,
      messages: this.contextManager.getContextMessages(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status,
    };
  }

  /**
   * Save a session checkpoint to disk (if session manager is configured).
   */
  protected saveCheckpoint(status: SessionStatus = "active"): void {
    if (!this.sessionManager) return;

    const state = this.buildBaseSessionState(status);
    this.sessionManager.saveCheckpoint(state);
  }

  /**
   * Handle an LLMNetworkError: save an interrupted checkpoint if
   * checkpointing is enabled, and return a user-facing message with
   * resume instructions.
   *
   * @param err               The network error that occurred.
   * @param iteration         The current iteration number (for the log).
   * @param resumeInstruction What the user should type to resume
   *                          (e.g. "continue with my previous request").
   */
  protected handleNetworkError(
    err: LLMNetworkError,
    iteration: number,
    resumeInstruction: string = "continue",
  ): string {
    if (this.checkpointingEnabled) {
      this.saveCheckpoint("interrupted");
    }

    const sid = this.sessionManager?.getSessionId() ?? "unknown";

    this.logger.error(
      "Network Error",
      `${err.cause}: ${err.message}`,
    );

    if (this.checkpointingEnabled && this.sessionManager) {
      return (
        `[Network Error] ${err.message}\n\n` +
        `Your session "${sid}" has been saved (iteration ${iteration}).\n` +
        `After your network is restored, resume with:\n` +
        `  agent.resume("${sid}", "${resumeInstruction}")\n\n` +
        `Or start a new session by calling agent.run() again with a fresh input.`
      );
    }

    // Checkpointing not enabled — just report the error
    return (
      `[Network Error] ${err.message}\n\n` +
      `Please check your network connection and try again.`
    );
  }

  /**
   * Restore agent state from a previously saved session.
   *
   * Loads the session file, restores the system prompt and message history
   * into the context manager.
   *
   * @throws if the session is not found or is corrupt.
   */
  protected loadAndRestoreSession(sessionId: string): SessionState {
    if (!this.sessionManager) {
      throw new Error(
        "Cannot resume: no SessionManager configured. " +
        "Pass `sessionId` or `sessionDir` to the agent constructor."
      );
    }

    const state = this.sessionManager.loadSession(sessionId);
    if (!state) {
      throw new Error(`Session not found or corrupt: "${sessionId}"`);
    }

    // Validate agent type
    const expectedType = this.getAgentType();
    if (state.agentType !== expectedType) {
      throw new Error(
        `Session "${sessionId}" was created by a ${state.agentType} agent, ` +
        `but this agent is type "${expectedType}". Cannot resume.`
      );
    }

    // Clear cancellation state — the user explicitly chose to resume
    this._cancelled = false;
    this._abortController = undefined; // will be recreated in run()

    // Sync session manager to the restored session ID so subsequent
    // checkpoints write to the correct file
    this.sessionManager.setSessionId(state.sessionId);

    // Restore system prompt
    this.coreSystemPrompt = state.systemPrompt;
    this.contextManager.clear();
    this.contextManager.setSystemMessage(state.systemPrompt);

    // Restore all messages into context
    for (const msg of state.messages) {
      this.contextManager.addMessage(msg);
    }

    return state;
  }

  // ─── Conversation Lifecycle ─────────────────────────────────────────

  /**
   * Clear the current conversation history and reset the context.
   *
   * The system prompt (core prompt + preferences + skills) is preserved
   * so the agent can start a fresh conversation with the same setup.
   * Use this to begin a new topic without creating a new agent instance.
   */
  clearConversation(): void {
    this.contextManager.clear();
    this.tokenBudget?.reset();
  }

  /**
   * Continue the current conversation with a follow-up input.
   *
   * Equivalent to `run()` but conveys the semantics of a multi-turn
   * conversation continuation. Messages from previous calls are preserved
   * in context, so the LLM sees the full conversation history.
   *
   * @param input The follow-up message from the user.
   * @returns The agent's response.
   */
  async chat(input: string): Promise<string> {
    return this.run(input);
  }

  /**
   * Start a new topic with a fresh conversation.
   *
   * Clears the message history (preserving the system prompt and
   * configuration) and runs the input as the first message of a
   * new conversation. The token budget is also reset.
   *
   * @param input The first message of the new topic.
   * @returns The agent's response.
   */
  async newTopic(input: string): Promise<string> {
    this.clearConversation();
    return this.run(input);
  }

  /**
   * The number of messages in the current conversation (excluding the
   * system message). Use this to check whether there is an active
   * conversation or to monitor context growth.
   */
  get conversationLength(): number {
    return this.contextManager.getMessages().length;
  }

  /**
   * Get the cumulative token consumption and cost for the current session.
   * Returns null if no `tokenBudgetConfig` was configured.
   */
  getSessionCost() {
    return this.tokenBudget?.getSessionCost() ?? null;
  }

  /**
   * Reset the agent to its initial state.
   *
   * Clears conversation history, session, and all runtime state.
   * After calling reset(), the agent behaves as if newly constructed.
   */
  reset(): void {
    this._abortController?.abort();
    this._cancelled = false;
    this.contextManager.clear();
    this.coreSystemPrompt = "";
    this.tokenBudget?.reset();
    this.subAgentManager?.cancelAll();
    if (this.sessionManager) {
      this.sessionManager.deleteSession(this.sessionManager.getSessionId());
    }
  }

  /**
   * Return the agent type identifier for session metadata.
   * Subclasses override this ("react" or "plan-solve").
   */
  protected getAgentType(): AgentType {
    return "react";
  }

  // ─── MCP / Async Initialization ─────────────────────────────────────────

  /**
   * Initialize async resources (MCP connections, tool discovery).
   *
   * Idempotent — safe to call multiple times; the actual work happens
   * only on the first invocation. Subclasses SHOULD call `await this.init()`
   * at the start of `run()`.
   *
   * If MCP servers are configured:
   * 1. Creates an McpClientManager bound to the tool registry.
   * 2. Connects to each server and registers discovered tools.
   * 3. Logs warnings for any servers that fail to connect.
   */
  protected async init(): Promise<void> {
    if (this._mcpInitialized) return;
    this._mcpInitialized = true;

    // ── Error tracking tool ──────────────────────────────────────────
    try { this.toolRegistry.register(createListErrorsTool(this.toolRegistry)); } catch { this.logger.debug("Init", `"list_errors" already registered — keeping existing.`); }

    // ── MCP connections ──────────────────────────────────────────────
    if (this.mcpServerConfigs && Object.keys(this.mcpServerConfigs).length > 0) {
      this.mcpClientManager = new McpClientManager(this.toolRegistry, this.logger);
      const errors = await this.mcpClientManager.connectAll(this.mcpServerConfigs);

      if (errors.length > 0) {
        this.logger.warn(
          "MCP",
          `${errors.length} of ${Object.keys(this.mcpServerConfigs).length} server(s) failed to connect.`,
        );
      }
    }

    // ── Sub-agent registry ───────────────────────────────────────────
    if (this.subAgentsDir) {
      this.subAgentManager = new SubAgentManager();
      this.subAgentManager.setLogger(this.logger);
      this.subAgentManager.bind(this.llm, this.toolRegistry, this.skillManager, this.skillsDir, undefined, undefined, this.subAgentLLM, this.subAgentHooks);
      this.subAgentManager.registerFromDirectory(this.subAgentsDir);

      // Register sub-agent tools into the tool registry
      try { this.toolRegistry.register(createListSubagentsTool(this.subAgentManager)); } catch { this.logger.debug("Init", `"list_subagents" already registered — keeping existing.`); }
      try { this.toolRegistry.register(createSpawnSubagentTool(this.subAgentManager)); } catch { this.logger.debug("Init", `"spawn_subagent" already registered — keeping existing.`); }
    }

    // ── RAG knowledge base ─────────────────────────────────────────────
    if (this.ragConfig) {
      this.ragManager = new RAGManager(this.ragConfig, this.logger);
      await this.ragManager.index();
      try { this.toolRegistry.register(createSearchKnowledgeTool(this.ragManager)); } catch { this.logger.debug("Init", `"search_knowledge" already registered — keeping existing.`); }
      try { this.toolRegistry.register(createListKnowledgeDocumentsTool(this.ragManager)); } catch { this.logger.debug("Init", `"list_knowledge_documents" already registered — keeping existing.`); }
    }

    // ── Skill tool (LLM-driven activation) ────────────────────────────
    try { this.toolRegistry.register(createSkillTool(this.skillManager, () => this.rebuildSystemPrompt())); } catch { this.logger.debug("Init", `"skill" already registered — keeping existing.`); }

    // ── Remember / Recall tools (long-term memory) ────────────────────
    try { this.toolRegistry.register(createRememberTool(this.memoryManager)); } catch { this.logger.debug("Init", `"remember" already registered — keeping existing.`); }
    try { this.toolRegistry.register(createRecallTool(this.memoryManager)); } catch { this.logger.debug("Init", `"recall" already registered — keeping existing.`); }
  }

  /**
   * Gracefully shut down the agent.
   *
   * Aborts any in-flight LLM request, cancels running sub-agents, waits
   * for them to finish, and disconnects all MCP servers. Safe to call
   * even if init() was never called or nothing was configured.
   */
  async shutdown(): Promise<void> {
    // Abort the in-flight LLM request so the process doesn't hang on an
    // open HTTP connection that would otherwise outlive this call.
    this._abortController?.abort();

    // Cancel sub-agents first, then await cleanup. Cancel-before-await
    // ensures sub-agents stuck on LLM calls resolve quickly instead of
    // waiting for the full timeout / max iteration count.
    this.subAgentManager?.cancelAll();
    await this.subAgentManager?.awaitAll();

    await this.mcpClientManager?.disconnectAll();
  }

  // ─── Sub-Agent ────────────────────────────────────────────────────────

  /**
   * Check whether sub-agents are available.
   *
   * Used by `buildSystemPrompt()` to decide whether to include sub-agent
   * delegation instructions. Returns true only when a SubAgentManager is
   * configured AND has at least one registered definition.
   */
  protected hasSubAgents(): boolean {
    return this.subAgentManager?.hasDefinitions() === true;
  }

  /**
   * Spawn a sub-agent by definition name.
   *
   * The sub-agent runs asynchronously — this method returns immediately.
   * Call `pollSubAgentResults()` at the start of each iteration to
   * collect completed results.
   *
   * @param name  The registered sub-agent definition name.
   * @param input The task description for the sub-agent.
   * @returns The unique run ID.
   */
  protected spawnSubAgent(name: string, input: string): string {
    if (!this.subAgentManager) {
      throw new Error("No SubAgentManager configured. Set `subAgentsDir` in AgentConfig.");
    }
    return this.subAgentManager.spawn(name, input);
  }

  /**
   * Poll for completed sub-agent results.
   *
   * Should be called at the start of each ReAct iteration to inject
   * sub-agent outputs into the main agent's context.
   */
  protected async pollSubAgentResults(): Promise<SubAgentResult[]> {
    if (!this.subAgentManager) return [];
    return this.subAgentManager.pollCompleted();
  }

  // ─── Error Trace & Analysis ──────────────────────────────────────────

  /**
   * Get the error tracker (if configured via the ToolRegistry).
   */
  get errorTracker(): ToolErrorTracker | undefined {
    return this.toolRegistry.getErrorTracker();
  }

  /**
   * Call after a tool returns a result — checks if the result indicates
   * a tool failure (retryable or fatal) and saves the trace ID so the
   * next LLM analysis thought can be captured.
   *
   * @param toolName The name of the tool that was executed.
   * @param result   The structured ToolResult returned by ToolRegistry.execute().
   */
  /**
   * Capture the LLM's reasoning as error analysis for any active tool error traces.
   *
   * Call this after parsing the LLM's `thought` from each response. If any tools
   * have an open failure chain (active trace), the thought is recorded as the
   * LLM's analysis of what went wrong and how to proceed.
   *
   * This feeds the error→analysis pipeline:
   *  1. Tool fails     → recordFailure() creates an active trace
   *  2. LLM sees error → its next thought IS the analysis
   *  3. Analysis       → recordAnalysis() attaches the LLM's reasoning to the trace
   *
   * For cross-session learning, use ErrorNotebook (错题本) via ReflectionHook.
   *
   * @param thought The LLM's reasoning (from parsed.thought).
   */
  protected captureErrorAnalysis(thought: string): void {
    if (!thought) return;
    const tracker = this.toolRegistry.getErrorTracker();
    if (!tracker) return;

    const activeTraces = tracker.getActiveTraces();
    for (const { traceId } of activeTraces) {
      tracker.recordAnalysis(traceId, thought);
    }
  }

  /**
   * Generate a markdown report of all recorded tool error traces.
   */
  generateErrorReport(): string {
    const tracker = this.errorTracker;
    if (!tracker) return "# Tool Error Trace Report\n\n*Error tracker not configured.*\n";
    return tracker.generateMarkdownReport();
  }
}
