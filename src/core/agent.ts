import { LLMProvider } from "../llm/interface";
import { ContextManager } from "../context/context-manager";
import { Tool } from "./types";
import { ToolRegistry } from "../tools/tool-registry";
import { ToolErrorTracker } from "../tools/error-tracker";
import { ToolOutputTruncator } from "../tools/tool-output-truncator";
import { SkillManager } from "../skills/skill-manager";
import { SessionManager } from "../session/session-manager";
import { SessionState, SessionStatus, AgentType } from "../session/session-types";
import { PreferenceManager } from "../preferences/preference-manager";
import { Preferences } from "../preferences/types";
import { AgentHooks } from "./hooks";
import { McpClientManager } from "../mcp/mcp-client-manager";
import type { McpServerConfig } from "../mcp/mcp-types";
import { SubAgentManager } from "../subagent/subagent-manager";
import type { SubAgentResult } from "../subagent/subagent-types";
import { createListSubagentsTool } from "../tools/builtin/list-subagents";
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent";

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

  systemPrompt?: string;

  /**
   * Lifecycle hooks for observing agent execution.
   * Accepts a single AgentHooks or an array of them.
   */
  hooks?: AgentHooks | AgentHooks[];

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

  /** The original core system prompt (before skill sections are appended). */
  protected coreSystemPrompt: string;

  /** User preferences — plain-text directives injected into the system prompt. */
  protected preferences: Preferences = {};

  /** Preference manager for file-based persistence (optional). */
  protected preferenceManager?: PreferenceManager;

  /** Lifecycle hooks for observing agent execution. */
  protected hooks: AgentHooks[] = [];

  /**
   * Trace ID of the most recent tool error waiting for LLM analysis.
   * Set after a tool fails, cleared when the LLM's analysis is recorded. */
  protected pendingErrorTraceId: string | null = null;

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

  /** Skills directory path (from AgentConfig). */
  protected skillsDir?: string;

  constructor(config: AgentConfig) {
    this._cancelled = false;
    this.llm = config.llm;
    this.contextManager = config.contextManager ?? new ContextManager();

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
      this.skillManager = new SkillManager();
    }

    // Register file-based skills if a directory is configured
    if (config.skillsDir) {
      this.skillManager.registerFromDirectory(config.skillsDir);
    }

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
   * Rebuild the system message from the core prompt + user preferences + active skills.
   * Called automatically when skills are activated/deactivated or preferences change.
   */
  protected rebuildSystemPrompt(): void {
    const prefsPrompt = PreferenceManager.toPrompt(this.preferences);
    const skillsHint = this.skillManager.buildAvailableSkillsHint();
    const skillsContent = this.skillManager.buildSkillsPrompt();
    const fullPrompt = this.coreSystemPrompt + prefsPrompt + skillsHint + skillsContent;
    this.contextManager.setSystemMessage(fullPrompt);
  }

  /**
   * Pre-iteration maintenance:
   * 1. Compress context window if needed (4-step progressive).
   * 2. Auto-reload preferences from disk if the file was manually edited.
   */
  protected async checkAndCompress(): Promise<void> {
    await this.contextManager.checkAndCompress(this.llm);

    // Auto-reload preferences if the file was manually edited
    if (this.preferenceManager?.hasFileChanged()) {
      this.preferences = this.preferenceManager.reload();
      this.rebuildSystemPrompt();
      console.log("[Preferences] Reloaded from disk (file changed).");
    }
  }

  // ─── Cancellation ────────────────────────────────────────────────────

  /**
   * Cancel the current run.
   *
   * Prevents any further checkpoint saves. Call this when the user presses
   * SIGINT to discard the session rather than persisting it.
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
   * Save a session checkpoint to disk (if session manager is configured
   * and the run has NOT been cancelled).
   */
  protected saveCheckpoint(status: SessionStatus = "active"): void {
    if (!this.sessionManager) return;
    if (this.isCancelled) return; // Don't save on abort

    const state = this.buildBaseSessionState(status);
    this.sessionManager.saveCheckpoint(state);
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
    this.pendingErrorTraceId = null;
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

    // ── MCP connections ──────────────────────────────────────────────
    if (this.mcpServerConfigs && Object.keys(this.mcpServerConfigs).length > 0) {
      this.mcpClientManager = new McpClientManager(this.toolRegistry);
      const errors = await this.mcpClientManager.connectAll(this.mcpServerConfigs);

      if (errors.length > 0) {
        console.warn(
          `[MCP] ${errors.length} of ${Object.keys(this.mcpServerConfigs).length} server(s) failed to connect.`,
        );
      }
    }

    // ── Sub-agent registry ───────────────────────────────────────────
    if (this.subAgentsDir) {
      this.subAgentManager = new SubAgentManager();
      this.subAgentManager.bind(this.llm, this.toolRegistry, this.skillManager, this.skillsDir);
      this.subAgentManager.registerFromDirectory(this.subAgentsDir);

      // Register sub-agent tools into the tool registry
      try { this.toolRegistry.register(createListSubagentsTool(this.subAgentManager)); } catch { /* skip */ }
      try { this.toolRegistry.register(createSpawnSubagentTool(this.subAgentManager)); } catch { /* skip */ }
    }
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
   * Call after a tool returns an error string — checks if the error
   * indicates a tool failure (with retry guidance) and saves the trace ID
   * so the next LLM analysis thought can be captured.
   *
   * @param toolName The name of the tool that failed.
   * @param result   The string returned by ToolRegistry.execute().
   */
  protected trackToolErrorForAnalysis(
    toolName: string,
    result: string
  ): void {
    const tracker = this.errorTracker;
    if (!tracker) return;

    // Check if the result contains retry guidance (indicating a failure)
    if (result.includes("[Retry Guidance]") || result.includes("has been automatically disabled")) {
      const activeTraceId = tracker.getActiveTraceId(toolName);
      if (activeTraceId) {
        this.pendingErrorTraceId = activeTraceId;
      }
    }
  }

  /**
   * Records the LLM's analysis thought against the pending tool error trace.
   * Should be called each iteration after parsing the LLM's response.
   *
   * @param thought The LLM's thought/analysis content.
   */
  protected captureAnalysisFromThought(thought: string): void {
    if (this.pendingErrorTraceId && thought) {
      const tracker = this.errorTracker;
      if (tracker) {
        tracker.recordAnalysis(this.pendingErrorTraceId, thought);
      }
      this.pendingErrorTraceId = null;
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
