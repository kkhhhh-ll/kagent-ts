import { LLMProvider } from "../llm/interface";
import { LLMNetworkError } from "../llm/errors";
import { ModelRouter } from "../llm/model-router";
import { Message } from "../messages/message";
import { ContextManager } from "../context/context-manager";
import { Tool } from "./types";
import { ToolRegistry } from "../tools/tool-registry";
import { ToolErrorTracker } from "../tools/error-tracker";
import { ToolOutputTruncator } from "../tools/tool-output-truncator";
import { SkillManager } from "../skills/skill-manager";
import { MemoryManager } from "../memory/memory-manager";
import { ProjectRules } from "../rules/project-rules";
import { SessionManager } from "../session/session-manager";
import { SessionState, SessionStatus, AgentType } from "../session/session-types";
import { countTokens } from "../utils/token-counter";
import { PreferenceManager } from "../preferences/preference-manager";
import { Preferences } from "../preferences/types";
import { AgentHooks } from "./hooks";
import { McpClientManager } from "../mcp/mcp-client-manager";
import type { McpServerConfig } from "../mcp/mcp-types";
import { SubAgentManager } from "../subagent/subagent-manager";
import type { SubAgentResult } from "../subagent/subagent-types";
import { createListSubagentsTool } from "../tools/builtin/list-subagents";
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent";
import { createListErrorsTool } from "../tools/builtin/list-errors";
import { createSkillTool } from "../tools/builtin/skill";
import { createRememberTool } from "../tools/builtin/remember";
import { createRecallTool } from "../tools/builtin/recall";
import { Logger, ConsoleLogger } from "../logging/logger";
import { TokenBudget, TokenBudgetConfig } from "../llm/token-budget";

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
   * Logger instance for framework-internal messages.
   * Defaults to {@link ConsoleLogger} (writes to `console` with `[Tag]` prefix).
   * Pass a {@link SilentLogger} to suppress all framework output.
   */
  logger?: Logger;

  // ─── User Preferences ───────────────────────────────────────────────

  /**
   * Explicit user preferences: key-value pairs of plain-text directives
   * injected into the system prompt so the LLM always honors them.
   *
   * Example:
   * ```ts
   * preferences: {
   *   codeStyle: "Use TypeScript with functional style.",
   *   language: "Always respond in Chinese.",
   * }
   * ```
   */
  preferences?: Preferences;

  /**
   * A pre-configured PreferenceManager for file-based persistence.
   * When provided, preferences auto-load on construction and persist
   * on every set/delete operation.
   */
  preferenceManager?: PreferenceManager;

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
   * @example
   * ```ts
   * mcpServers: {
   *   filesystem: {
   *     command: "npx",
   *     args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
   *   },
   *   weather: {
   *     url: "http://localhost:3001/sse",
   *   },
   * }
   * ```
   */
  mcpServers?: Record<string, McpServerConfig>;

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
   * Token budget configuration for session-level cost control.
   * When set, the agent stops making LLM calls when cumulative token
   * consumption exceeds `maxTotalTokens`. The budget resets on
   * `clearConversation()` and `reset()`.
   */
  tokenBudgetConfig?: TokenBudgetConfig;
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

  /** User preferences — plain-text directives injected into the system prompt. */
  protected preferences: Preferences = {};

  /** Preference manager for file-based persistence (optional). */
  protected preferenceManager?: PreferenceManager;

  /** Lifecycle hooks for observing agent execution. */
  protected hooks: AgentHooks[] = [];

  /** Logger for framework-internal messages. */
  protected logger: Logger;

  /** Token budget for session-level cost control (optional). */
  protected tokenBudget?: TokenBudget;

  /** Human-in-the-loop approval callback (from AgentConfig). */
  protected onToolApproval?: ApprovalCallback;

  // ─── Session & Cancellation ─────────────────────────────────────────

  /** Session manager for checkpoint persistence (optional). */
  protected sessionManager?: SessionManager;

  /** Whether auto-checkpointing is enabled. */
  protected checkpointingEnabled = false;

  /** Whether the current run has been cancelled by the user. */
  protected _cancelled = false;

  // ─── MCP (Model Context Protocol) ─────────────────────────────────────

  /** MCP server configurations (from AgentConfig). */
  protected mcpServerConfigs?: Record<string, McpServerConfig>;

  /** MCP client manager for dynamic tool discovery (lazily initialized). */
  protected mcpClientManager?: McpClientManager;

  /** Guards async init() from running more than once per instance. */
  private _mcpInitialized = false;

  // ─── Sub-Agent ────────────────────────────────────────────────────────

  /** Sub-agent manager (lazily initialized in init()). */
  protected subAgentManager?: SubAgentManager;

  /** Sub-agent definitions directory (from AgentConfig). */
  protected subAgentsDir?: string;

  /** LLM provider for sub-agents (defaults to main llm if not set). */
  protected subAgentLLM?: LLMProvider;

  /** Skills directory path (from AgentConfig). */
  protected skillsDir?: string;

  constructor(config: AgentConfig) {
    this._cancelled = false;
    this.llm = config.llm;
    this.logger = config.logger ?? new ConsoleLogger();
    this.onToolApproval = config.onToolApproval;
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
    this.projectRules = new ProjectRules(config.rulesPath);

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
    this.mcpServerConfigs = config.mcpServers;
    this.subAgentsDir = config.subAgentsDir;
    this.skillsDir = config.skillsDir;

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
    this.preferenceManager = config.preferenceManager;
    this.preferences = config.preferences ?? {};

    // If a PreferenceManager is configured, load persisted prefs
    // and merge with inline prefs (inline values take precedence)
    if (this.preferenceManager) {
      const persisted = this.preferenceManager.getAll();
      this.preferences = { ...persisted, ...this.preferences };
    }

    // If preferences are non-empty, inject them into the system prompt
    if (Object.keys(this.preferences).length > 0) {
      this.rebuildSystemPrompt();
    }
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
      this.projectRules.buildPrompt(),
      PreferenceManager.toPrompt(this.preferences),
      this.toolRegistry.getErrorTracker()?.buildRulesPrompt(),
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
    if (this.preferenceManager?.hasFileChanged()) {
      this.preferences = this.preferenceManager.reload();
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
  protected async checkToolApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.onToolApproval) {
      this.logger.warn("Approval", `Tool "${toolName}" requires approval but no onToolApproval configured — denied.`);
      return false;
    }
    try {
      return await this.onToolApproval(toolName, args);
    } catch {
      this.logger.warn("Approval", `Approval callback threw for "${toolName}" — denied.`);
      return false;
    }
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
   * Sets the cancellation flag; the loop will save a "cancelled" checkpoint
   * at its next iteration and exit. Call this when the user presses SIGINT.
   * The session is preserved on disk and can be resumed later.
   */
  cancel(): void {
    this._cancelled = true;
    this.subAgentManager?.cancelAll();
  }

  /**
   * Whether the run has been cancelled by the user.
   */
  get isCancelled(): boolean {
    return this._cancelled;
  }

  // ─── User Preferences ──────────────────────────────────────────────────

  /**
   * Set a single user preference and rebuild the system prompt.
   * If a PreferenceManager is configured, the change is persisted to disk.
   */
  setPreference(key: string, value: string): void {
    this.preferences[key] = value;
    this.preferenceManager?.set(key, value);
    this.rebuildSystemPrompt();
  }

  /**
   * Replace all user preferences and rebuild the system prompt.
   * If a PreferenceManager is configured, the change is persisted to disk.
   */
  setPreferences(prefs: Preferences): void {
    this.preferences = { ...prefs };
    this.preferenceManager?.setAll(prefs);
    this.rebuildSystemPrompt();
  }

  /**
   * Get a single preference by key.
   */
  getPreference(key: string): string | undefined {
    return this.preferences[key];
  }

  /**
   * Get all current preferences.
   */
  getPreferences(): Preferences {
    return { ...this.preferences };
  }

  /**
   * Remove a single preference by key and rebuild the system prompt.
   * If a PreferenceManager is configured, the change is persisted to disk.
   */
  removePreference(key: string): void {
    delete this.preferences[key];
    this.preferenceManager?.delete(key);
    this.rebuildSystemPrompt();
  }

  /**
   * Clear all user preferences and rebuild the system prompt.
   * If a PreferenceManager is configured, the change is persisted to disk.
   */
  clearPreferences(): void {
    this.preferences = {};
    this.preferenceManager?.clear();
    this.rebuildSystemPrompt();
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
    this.contextManager.clear();
    this.coreSystemPrompt = "";
    this.preferences = {};
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

    // ── Error rules (load before MCP / sub-agents) ──────────────────
    this.toolRegistry.getErrorTracker()?.loadRules();
    try { this.toolRegistry.register(createListErrorsTool(this.toolRegistry)); } catch { /* skip */ }

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
      this.subAgentManager.bind(this.llm, this.toolRegistry, this.skillManager, this.skillsDir, undefined, undefined, this.subAgentLLM);
      this.subAgentManager.registerFromDirectory(this.subAgentsDir);

      // Register sub-agent tools into the tool registry
      try { this.toolRegistry.register(createListSubagentsTool(this.subAgentManager)); } catch { /* skip */ }
      try { this.toolRegistry.register(createSpawnSubagentTool(this.subAgentManager)); } catch { /* skip */ }
    }

    // ── Skill tool (LLM-driven activation) ────────────────────────────
    try { this.toolRegistry.register(createSkillTool(this.skillManager, () => this.rebuildSystemPrompt())); } catch { /* skip */ }

    // ── Remember / Recall tools (long-term memory) ────────────────────
    try { this.toolRegistry.register(createRememberTool(this.memoryManager)); } catch { /* skip */ }
    try { this.toolRegistry.register(createRecallTool(this.memoryManager)); } catch { /* skip */ }
  }

  /**
   * Gracefully shut down MCP connections.
   *
   * Disconnects all servers and unregisters their tools. Safe to call
   * even if init() was never called or no servers were configured.
   */
  async shutdown(): Promise<void> {
    await this.mcpClientManager?.disconnectAll();
    if (this.subAgentManager) {
      await this.subAgentManager.awaitAll();
    }
  }

  // ─── Sub-Agent ────────────────────────────────────────────────────────

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
   * This feeds the error→analysis→rule→prevention pipeline:
   *  1. Tool fails     → recordFailure() creates an active trace
   *  2. LLM sees error → its next thought IS the analysis
   *  3. Tool recovers  → recordRecovery() auto-extracts a rule from the analysis
   *  4. Rules injected → buildRulesPrompt() includes them in the system prompt
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
