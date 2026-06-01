import { LLMProvider } from "../llm/interface";
import { ContextManager } from "../context/context-manager";
import { Tool } from "./types";
import { ToolRegistry } from "../tools/tool-registry";
import { ToolErrorTracker } from "../tools/error-tracker";
import { SkillManager } from "../skills/skill-manager";
import { Skill } from "../skills/types";
import { SessionManager } from "../session/session-manager";
import { SessionState, SessionStatus, AgentType } from "../session/session-types";
import { PreferenceManager } from "../preferences/preference-manager";
import { Preferences } from "../preferences/types";
import { AgentHooks } from "./hooks";

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
   * Skills for progressive-disclosure capabilities.
   */
  skills?: Skill[];

  /**
   * A pre-configured SkillManager. If provided, `skills` is ignored.
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
   * All hooks are optional.
   */
  hooks?: AgentHooks;

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
  protected hooks: AgentHooks = {};

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

  constructor(config: AgentConfig) {
    this._cancelled = false;
    this.llm = config.llm;
    this.contextManager = config.contextManager ?? new ContextManager();

    // Prefer toolRegistry; fall back to plain tools array
    if (config.toolRegistry) {
      this.toolRegistry = config.toolRegistry;
    } else {
      this.toolRegistry = new ToolRegistry(
        config.toolRetryCount,
        config.toolErrorTracker,
      );
      if (config.tools && config.tools.length > 0) {
        this.toolRegistry.registerMany(config.tools);
      }
    }

    // Skill manager — auto-bind the tool registry so skill tools register
    if (config.skillManager) {
      this.skillManager = config.skillManager;
    } else {
      this.skillManager = new SkillManager();
    }
    this.skillManager.bindToolRegistry(this.toolRegistry);

    // Register any skills passed directly
    if (config.skills && config.skills.length > 0) {
      this.skillManager.register(...config.skills);
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

    // ── Hooks ──────────────────────────────────────────────────────────────
    this.hooks = config.hooks ?? {};

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
   * Add skills to the agent's SkillManager.
   */
  addSkill(...skills: Skill[]): void {
    this.skillManager.register(...skills);
  }

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
   * 1. Compress context window if needed.
   * 2. Auto-reload preferences from disk if the file was manually edited.
   */
  protected checkAndCompress(): void {
    if (this.contextManager.shouldCompress()) {
      const { removedCount } = this.contextManager.compress();
      console.log(
        `[Context] Compression triggered: removed ${removedCount} messages.`
      );
    }

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
