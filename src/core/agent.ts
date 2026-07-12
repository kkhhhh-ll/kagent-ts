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
import {
  SessionState,
  SessionStatus,
  AgentType,
} from "../session/session-types";
import { countTokens } from "../utils/token-counter";
import { PreferenceManager } from "../preferences/preference-manager";
import { AgentHooks } from "./hooks";
import { McpClientManager } from "../mcp/mcp-client-manager";
import type { McpServerConfig } from "../mcp/mcp-types";
import { SubAgentManager } from "../subagent/subagent-manager";
import type { SubAgentResult } from "../subagent/subagent-types";
import { RAGManager } from "../rag/rag-manager";
import type { RAGConfig } from "../rag/rag-types";
import {
  createSearchKnowledgeTool,
  createListKnowledgeDocumentsTool,
} from "../rag/search-knowledge";
import { createListSubagentsTool } from "../tools/builtin/list-subagents";
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent";
import { createListErrorsTool } from "../tools/builtin/list-errors";
import { createSkillTool } from "../tools/builtin/skill";
import { createPrecipitateSkillTool } from "../tools/builtin/precipitate-skill";
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
 *
 * The `signal` parameter is an `AbortSignal` that will be triggered when:
 * - The approval timeout fires
 * - The agent is cancelled
 * Implementations should use this signal to clean up pending async
 * operations (e.g. readline prompts) so they don't leak into the next
 * approval request.
 */
export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * Base configuration for any Agent.
 */
export interface AgentConfig {
  llm: LLMProvider;
  contextManager?: ContextManager;

  /** Human-readable agent name for log output. Default: `"main"`. */
  name?: string;

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
   * Omit or set to `undefined` to disable truncation. Must be a positive
   * integer when set (validated at runtime).
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
   * Path to a directory of file-based skills (each with a `SKILL.md`).
   * Skills are lazily loaded: metadata at startup, full content on activation.
   */
  skillsDir?: string;

  /**
   * Path to long-term memory storage (default: `".memory"`). Persists facts,
   * rules, and decisions via `MEMORY.md` index + individual markdown files.
   */
  memoryDir?: string;

  /**
   * Path to a project rules file (e.g. `"RULES.md"`) or directory
   * (e.g. `".rules/"`). User-authored, always injected, auto-reloaded.
   */
  rulesPath?: string;

  /** Optional system prompt appended to the default system prompt. */
  systemPrompt?: string;

  /**
   * Lifecycle hooks for observing agent execution.
   * Accepts a single AgentHooks or an array of them.
   */
  hooks?: AgentHooks | AgentHooks[];

  /**
   * Human-in-the-loop approval callback. Called before executing tools
   * marked `requireApproval: true`. Return `true` to approve. If not
   * provided, such tools are ALWAYS DENIED (safe default).
   */
  onToolApproval?: ApprovalCallback;

  /** Max ms to wait for onToolApproval before applying timeout strategy. Default: 120_000. */
  approvalTimeoutMs?: number;

  /**
   * Timeout strategy: `"deny"` (default, safe) or `"allow"` (use only for
   * non-destructive tools in trusted environments).
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

  /** Auto-save checkpoints after each LLM+tools cycle for session resume. Default: false. */
  enableCheckpointing?: boolean;

  // ─── MCP Server Configuration ─────────────────────────────────────────

  /** MCP server configs for dynamic tool discovery. Inline takes precedence over file-based. */
  mcpServers?: Record<string, McpServerConfig>;

  /** Path to a JSON file of MCP server configs (same shape as {@link mcpServers}). */
  mcpConfigPath?: string;

  // ─── Sub-Agent Configuration ───────────────────────────────────────────

  /**
   * Path to a directory of sub-agent definitions (AGENT.md files with
   * YAML frontmatter). Each subdirectory = one agent. Default: `"./subagents/"`.
   */
  subAgentsDir?: string;

  /** When true, skip SubAgentManager even if `subAgentsDir` is configured. */
  disableSubAgents?: boolean;

  /** When true, skip auto-registration of `remember`, `recall`, `skill`, `list_errors`. */
  skipAutoTools?: boolean;

  /**
   * LLM provider for sub-agents. When omitted, inherits the main `llm`
   * (or `ModelRouter.forSubAgent()` if using a router). Use a cheaper model
   * for sub-agent tasks to save cost.
   */
  subAgentLLM?: LLMProvider;

  /**
   * LLM provider for skill precipitation. When omitted, resolves via
   * `ModelRouter.forPrecipitation()` or falls back to `llm`. Use a cheaper
   * model — precipitation is background work.
   */
  precipitationLLM?: LLMProvider;

  /**
   * Hooks for sub-agents. Accepts a single {@link AgentHooks}, an array, or a
   * factory `(name, runId) => AgentHooks | AgentHooks[]`. **WARNING**: Do NOT
   * pass hooks that spawn sub-agents (e.g. ReflectionHook) — unbounded recursion.
   */
  subAgentHooks?:
    | AgentHooks
    | AgentHooks[]
    | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /**
   * RAG configuration. When set, documents are indexed at startup and the
   * `search_knowledge` tool is registered for context retrieval.
   */
  rag?: RAGConfig;

  /**
   * Token budget for session-level cost control. Stops LLM calls when
   * cumulative consumption exceeds `maxTotalTokens`. Resets on clear/reset.
   */
  tokenBudgetConfig?: TokenBudgetConfig;

  /**
   * Enable parallel tool execution. When `true` (default), parallel-safe
   * tools in the same LLM response execute concurrently via `Promise.allSettled`,
   * reducing per-turn latency from `sum(latency)` to `max(latency)`.
   */
  enableParallelToolExecution?: boolean;

  /** Working directory scoped to sub-agents for file/bash operations. */
  workdir?: string;

  // ─── Skill Precipitation ─────────────────────────────────────────────

  /**
   * Skill precipitation mode. After the agent completes a task, extracts
   * reusable skills as SKILL.md files. Requires `skillsDir`. Default: `"off"`.
   */
  precipitation?: "off" | "post-hoc";

  /** Max iterations for the precipitation sub-agent. Default: 15. */
  precipitationMaxIterations?: number;

  // ─── Memory Reflection ──────────────────────────────────────────────

  /**
   * Memory reflection mode. After the agent completes a task, extracts
   * lasting memories (rules, decisions, preferences) to `memoryDir`.
   * Default: `"off"`.
   */
  memoryReflection?: "off" | "post-hoc";

  /** Max iterations for the memory reflection sub-agent. Default: 5. */
  memoryReflectionMaxIterations?: number;

  /**
   * LLM provider for memory reflection. When omitted, resolves via
   * `ModelRouter.forMemory()` or falls back to `llm`. Use a cheaper
   * model — memory extraction is background work.
   */
  memoryReflectorLLM?: LLMProvider;

  /**
   * LLM provider for post-hoc error reflection.
   *
   * When set, this provider is used for the ReflectionAgent fork.
   * When not set, the resolution order is:
   * 1. `ModelRouter.forReflection()` if the main `llm` is a ModelRouter
   * 2. Otherwise falls back to the main `llm`
   */
  reflectionLLM?: LLMProvider;

  // ─── Answer Verification ──────────────────────────────────────────────

  /**
   * Answer verification mode. After the agent produces a final answer,
   * forks an independent VerifyAgent to check correctness and completeness.
   * Default: `"off"`.
   */
  verification?: "off" | "post-hoc";

  /** Max iterations for the verification sub-agent. Default: 3. */
  verificationMaxIterations?: number;

  /**
   * Minimum score (0-100) to pass verification. Default: 70.
   * When the score is below this threshold, the verification issues are
   * injected back into the main agent for one correction attempt.
   */
  verificationThreshold?: number;

  /**
   * LLM provider for answer verification.
   *
   * When set, this provider is used for the VerifyAgent fork.
   * When not set, the resolution order is:
   * 1. `ModelRouter.forVerification()` if the main `llm` is a ModelRouter
   * 2. Otherwise falls back to the main `llm`
   *
   * Using an independent model here provides an unbiased review.
   */
  verificationLLM?: LLMProvider;
}

/**
 * Default values for optional {@link AgentConfig} fields.
 *
 * Applied at the top of the constructor so the rest of the body can access
 * every field without non-null assertions. Kept outside the constructor so
 * default values are visible in one place and easy to audit.
 */
const AGENT_CONFIG_DEFAULTS = {
  name: "main",
  approvalTimeoutMs: 120_000,
  approvalTimeoutStrategy: "deny" as "deny" | "allow",
  enableParallelToolExecution: true,
  disableSubAgents: false,
  skipAutoTools: false,
  enableCheckpointing: false,
  subAgentsDir: "./subagents/",
} as const;

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

  /** Human-readable agent name for distinguishing agents in log output. */
  protected agentName: string;

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

  /** When true, sub-agent manager init is skipped. */
  protected disableSubAgents: boolean;

  /** When true, auto-registration of side-effect tools is skipped. */
  protected skipAutoTools: boolean;

  /** LLM provider for sub-agents (defaults to main llm if not set). */
  protected subAgentLLM?: LLMProvider;

  /** LLM provider for skill precipitation (defaults to main llm if not set). */
  protected precipitationLLM?: LLMProvider;

  /** LLM provider for memory reflection (defaults to main llm if not set). */
  protected memoryReflectorLLM?: LLMProvider;

  /** LLM provider for error reflection (defaults to main llm if not set). */
  protected reflectionLLM?: LLMProvider;

  /** LLM provider for answer verification (defaults to main llm if not set). */
  protected verificationLLM?: LLMProvider;

  /** Answer verification mode. Default: `"off"`. */
  protected verificationMode: "off" | "post-hoc" = "off";

  /** Max iterations for the verification sub-agent. Default: 3. */
  protected verificationMaxIterations: number = 3;

  /** Minimum score (0-100) to pass verification. Default: 70. */
  protected verificationThreshold: number = 70;

  /** Hooks for sub-agents (from AgentConfig). */
  protected subAgentHooks?:
    | AgentHooks
    | AgentHooks[]
    | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /** Skills directory path (from AgentConfig). */
  protected skillsDir?: string;

  /** Working directory for this agent (from AgentConfig). */
  protected workdir?: string;

  constructor(config: AgentConfig) {
    // ── Validate required fields ──────────────────────────────────────────
    if (!config.llm) {
      throw new Error("AgentConfig: llm is required");
    }

    // ── Apply defaults (user values take precedence) ──────────────────────
    const cfg = { ...AGENT_CONFIG_DEFAULTS, ...config };
    this._cancelled = false;
    this.llm = cfg.llm;
    this.agentName = cfg.name;
    this.logger = cfg.logger ?? new ConsoleLogger();
    this.onToolApproval = cfg.onToolApproval;
    this.approvalTimeoutMs = cfg.approvalTimeoutMs;
    this.approvalTimeoutStrategy = cfg.approvalTimeoutStrategy;
    this.enableParallelToolExecution = cfg.enableParallelToolExecution;
    this.contextManager =
      cfg.contextManager ?? new ContextManager(undefined, this.logger);

    // Prefer toolRegistry; fall back to plain tools array
    if (cfg.toolRegistry) {
      this.toolRegistry = cfg.toolRegistry;
    } else {
      const truncator = cfg.toolOutputMaxBytes
        ? new ToolOutputTruncator(cfg.toolOutputMaxBytes)
        : undefined;
      this.toolRegistry = new ToolRegistry(
        cfg.toolRetryCount,
        cfg.toolErrorTracker,
        truncator,
      );
      if (cfg.tools) {
        this.toolRegistry.registerMany(cfg.tools);
      }
    }

    // Skill manager — file-based progressive disclosure
    if (cfg.skillManager) {
      this.skillManager = cfg.skillManager;
    } else {
      this.skillManager = new SkillManager(this.logger);
    }

    // Register file-based skills if a directory is configured
    if (cfg.skillsDir) {
      this.skillManager.registerFromDirectory(cfg.skillsDir);
    }

    // Memory — long-term facts, rules, and project context
    this.memoryManager = new MemoryManager(cfg.memoryDir);

    // Project rules — user-authored, always injected
    this.projectRules = new ProjectRules(cfg.rulesPath, this.logger);

    // Store core system prompt and set it
    this.coreSystemPrompt = cfg.systemPrompt ?? "";
    if (this.coreSystemPrompt) {
      this.contextManager.setSystemMessage(this.coreSystemPrompt);
    }

    // Session manager — only created when session ID or session dir is provided
    if (cfg.sessionId || cfg.sessionDir) {
      this.sessionManager = new SessionManager({
        sessionId: cfg.sessionId,
        sessionDir: cfg.sessionDir,
      });
    }
    this.checkpointingEnabled = cfg.enableCheckpointing;
    this.subAgentsDir = cfg.subAgentsDir;
    this.disableSubAgents = cfg.disableSubAgents;
    this.skipAutoTools = cfg.skipAutoTools;

    // Auto-load mcp.json from project root; skip for sub-agents
    // (they inherit MCP tools from the parent's ToolRegistry).
    const effectiveMcpPath = cfg.toolRegistry
      ? undefined
      : (cfg.mcpConfigPath ?? "mcp.json");
    this.mcpServerConfigs = Agent.loadMcpConfig(
      effectiveMcpPath,
      cfg.mcpServers,
      this.logger,
    );
    this.subAgentHooks = cfg.subAgentHooks;
    this.skillsDir = cfg.skillsDir;
    this.workdir = cfg.workdir;
    this.ragConfig = cfg.rag;

    // Resolve sub-agent LLM:
    // 1. Explicit `subAgentLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forSubAgent()
    // 3. Fallback → sub-agents share the main `llm`
    if (cfg.subAgentLLM) {
      this.subAgentLLM = cfg.subAgentLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.subAgentLLM = cfg.llm.forSubAgent();
    }

    // Resolve precipitation LLM:
    // 1. Explicit `precipitationLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forPrecipitation()
    // 3. Fallback → precipitation shares the main `llm`
    if (cfg.precipitationLLM) {
      this.precipitationLLM = cfg.precipitationLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.precipitationLLM = cfg.llm.forPrecipitation();
    }

    // Resolve memory reflector LLM:
    // 1. Explicit `memoryReflectorLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forMemory()
    // 3. Fallback → memory reflection shares the main `llm`
    if (cfg.memoryReflectorLLM) {
      this.memoryReflectorLLM = cfg.memoryReflectorLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.memoryReflectorLLM = cfg.llm.forMemory();
    }

    // Resolve reflection LLM:
    // 1. Explicit `reflectionLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forReflection()
    // 3. Fallback → reflection shares the main `llm`
    if (cfg.reflectionLLM) {
      this.reflectionLLM = cfg.reflectionLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.reflectionLLM = cfg.llm.forReflection();
    }

    // Resolve verification LLM:
    // 1. Explicit `verificationLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forVerification()
    // 3. Fallback → verification shares the main `llm`
    if (cfg.verificationLLM) {
      this.verificationLLM = cfg.verificationLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.verificationLLM = cfg.llm.forVerification();
    }

    // Verification settings
    this.verificationMode = cfg.verification ?? "off";
    this.verificationMaxIterations = cfg.verificationMaxIterations ?? 3;
    this.verificationThreshold = cfg.verificationThreshold ?? 70;

    // Token budget — session-level cost control
    if (cfg.tokenBudgetConfig) {
      this.tokenBudget = new TokenBudget(cfg.tokenBudgetConfig);
    }

    // ── Hooks ──────────────────────────────────────────────────────────────
    const rawHooks = cfg.hooks ?? [];
    this.hooks = Array.isArray(rawHooks) ? rawHooks : [rawHooks];

    // Auto-derive subAgentHooks from a TraceLogger in this.hooks when the
    // user didn't configure subAgentHooks explicitly. This makes sub-agent
    // tracing work out-of-the-box — same behavior as fork-agent tracing via
    // TraceLogger.wrapHooksForFork(). Duck-typed via createChildTrace to
    // avoid an import dependency on the trace package from core.
    if (!this.subAgentHooks) {
      const traceLogger = this.hooks.find(
        (h) =>
          typeof (h as Record<string, unknown>).createChildTrace === "function",
      );
      if (traceLogger) {
        const createChild = (
          traceLogger as Record<string, Function>
        ).createChildTrace.bind(traceLogger);
        this.subAgentHooks = (name: string, runId: string) =>
          createChild(name, runId) as AgentHooks | AgentHooks[];
      }
    }

    // ── User Preferences ─────────────────────────────────────────────────
    this.preferenceManager = new PreferenceManager(
      { filePath: cfg.preferencesPath ?? ".kagent/preferences.md" },
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
  /** Fire the `onFinish` hook for every registered observer (fire-and-forget). */
  protected fireOnFinish(answer: string): void {
    for (const h of this.hooks) {
      Promise.resolve(h.onFinish?.(answer)).catch((err: unknown) =>
        this.logger.warn(
          "Hook",
          `onFinish failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  /**
   * Fork a lightweight ReActAgent for a self-contained task. Runs inline
   * (not via SubAgentManager), uses this agent's LLM by default.
   */
  protected async fork(
    input: string,
    options: {
      systemPrompt: string;
      llm?: LLMProvider;
      tools?: Tool[];
      maxIterations?: number;
      preventSubAgents?: boolean;
    },
  ): Promise<string> {
    const { forkAgent } = await import("./fork.js");
    return forkAgent(input, {
      llm: this.llm,
      ...options,
      signal: this._abortController?.signal,
    });
  }

  /**
   * Stream the agent's response. Tool calls are handled transparently —
   * when the LLM requests tools they're executed and results are fed back
   * before the next LLM call.
   */
  async *stream(input: string): AsyncIterable<string> {
    yield* this.executeStream(input);
  }

  /**
   * Subclass hook for the streaming loop.
   * Each agent type overrides this with its own loop logic.
   */
  protected async *executeStream(_input: string): AsyncIterable<string> {
    yield "Streaming is not supported by this agent type.";
  }

  // ─── Skill Management ────────────────────────────────────────────────

  /**
   * Get the SkillManager (for advanced management).
   */
  getSkillManager(): SkillManager {
    return this.skillManager;
  }

  /**
   * Activate a skill by name and rebuild the system prompt.
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

  /** Register an additional lifecycle hook. */
  addHook(hook: AgentHooks): void {
    this.hooks.push(hook);
  }

  /**
   * Build the full system prompt by concatenating all sections in priority
   * order: core prompt → rules → preferences → memories → skills. Empty
   * sections are silently skipped. Subclasses append extra content by
   * calling this and concatenating, rather than duplicating the assembly.
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

  /** Reload preferences from disk if manually edited between runs. */
  protected reloadPreferencesIfChanged(): boolean {
    if (this.preferenceManager?.reloadIfChanged()) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /** Re-scan skills directory for new SKILL.md files added between runs. */
  protected reloadSkillsFromDirectory(): boolean {
    if (!this.skillsDir) return false;
    const added = this.skillManager.reloadFromDirectory(this.skillsDir);
    if (added.length > 0) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /** Re-read MEMORY.md index if manually edited between runs. */
  protected reloadMemoryIfChanged(): boolean {
    if (this.memoryManager.reloadIfChanged()) {
      this.rebuildSystemPrompt();
      return true;
    }
    return false;
  }

  /**
   * Load MCP server config from a JSON file, merge with inline overrides.
   * Inline entries with the same server name take precedence.
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
          logger.warn(
            "MCP",
            `"${resolved}" is not a valid JSON object — ignoring.`,
          );
          fileConfig = {};
        }
      } catch (err) {
        logger.warn(
          "MCP",
          `Failed to load MCP config from "${resolved}": ${err instanceof Error ? err.message : err}`,
        );
        fileConfig = {};
      }
    }

    // Merge: inline takes precedence over file for same server name
    const merged = { ...fileConfig, ...inline };

    if (Object.keys(merged).length === 0) return undefined;
    return merged;
  }

  /** Connect to MCP servers added since last run. */
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
    this.reloadPreferencesIfChanged(); // rebuilds internally if changed
    const rulesChanged = this.projectRules.reloadIfChanged();
    this.reloadSkillsFromDirectory(); // rebuilds internally if changed
    this.reloadMemoryIfChanged(); // rebuilds internally if changed

    if (rulesChanged) {
      this.rebuildSystemPrompt();
    }

    await this.reconnectMCPIfNeeded();
  }

  /** After resume, inject orphaned sub-agent results into context. */
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

  /** Returns an error string if input exceeds 80% of context window, else `null`. */
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
   * Check whether a tool requiring human approval should be executed.
   *
   * Waits for the {@link onToolApproval} callback with a timeout; respects
   * the agent-wide {@link AbortSignal} so cancellation interrupts any
   * pending approval.
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

    const agentSignal = this._abortController?.signal;
    const approvalAbort = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAgentAbort: (() => void) | undefined;

    // Propagate agent cancellation to the approval signal
    if (agentSignal) {
      if (agentSignal.aborted) {
        this.logger.info(
          "Approval",
          `Approval for "${toolName}" cancelled (agent aborted) — denied.`,
        );
        return false;
      }
      onAgentAbort = () => approvalAbort.abort();
      agentSignal.addEventListener("abort", onAgentAbort, { once: true });
    }

    try {
      const result = await Promise.race([
        this.onToolApproval(toolName, args, approvalAbort.signal),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => {
            approvalAbort.abort(); // signal the callback to clean up
            resolve("timeout");
          }, this.approvalTimeoutMs);
        }),
        // Also race against cancellation: if the agent is aborted, stop waiting
        new Promise<"cancelled">((resolve) => {
          if (agentSignal?.aborted) {
            resolve("cancelled");
            return;
          }
          const onAbort = () => resolve("cancelled");
          agentSignal?.addEventListener("abort", onAbort, { once: true });
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
      if (onAgentAbort && agentSignal)
        agentSignal.removeEventListener("abort", onAgentAbort);
    }
  }

  /**
   * Execute a batch of tool calls. Handles JSON parse, HITL approval,
   * hook notifications, parallel/serial execution, context injection,
   * and MCP failure warnings.
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
        for (const h of this.hooks)
          h.onToolError?.(tc.function.name, result.content, tc.id);
        slots.push({ toolCall: tc, args: {}, result });
        continue;
      }

      // 1b. JSON Schema validation against the tool's parameter definition
      const tool = this.toolRegistry.getTool(tc.function.name);
      if (tool) {
        const validationError = validateToolArgs(
          tc.function.name,
          tool.parameters,
          args,
        );
        if (validationError) {
          for (const h of this.hooks)
            h.onToolError?.(tc.function.name, validationError.content, tc.id);
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
          for (const h of this.hooks)
            h.onToolError?.(
              slot.toolCall.function.name,
              slot.result.content,
              slot.toolCall.id,
            );
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
        for (const h of this.hooks)
          h.onToolStart?.(
            slot.toolCall.function.name,
            slot.args,
            slot.toolCall.id,
          );
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
            for (const h of this.hooks)
              h.onToolEnd?.(
                slot.toolCall.function.name,
                result.content,
                slot.toolCall.id,
              );
          } else {
            for (const h of this.hooks)
              h.onToolError?.(
                slot.toolCall.function.name,
                result.content,
                slot.toolCall.id,
              );
          }
        }),
      );
    } else {
      // Serial path (legacy behaviour or forced by sequential tools)
      for (const slot of executable) {
        this.logger.info("Action", slot.toolCall.function.name);
        for (const h of this.hooks)
          h.onToolStart?.(
            slot.toolCall.function.name,
            slot.args,
            slot.toolCall.id,
          );

        slot.result = await this.toolRegistry.execute(
          slot.toolCall.function.name,
          slot.args,
        );

        if (slot.result.success) {
          for (const h of this.hooks)
            h.onToolEnd?.(
              slot.toolCall.function.name,
              slot.result.content,
              slot.toolCall.id,
            );
        } else {
          for (const h of this.hooks)
            h.onToolError?.(
              slot.toolCall.function.name,
              slot.result.content,
              slot.toolCall.id,
            );
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
   * Returns an error string if the token budget is exhausted, else `null`.
   * Warns at 80% consumption.
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
        `Warning: ${Math.round((status.totalTokensUsed / status.maxTotalTokens) * 100)}% of budget used ` +
          `(${status.totalTokensUsed.toLocaleString()}/${status.maxTotalTokens.toLocaleString()} tokens).`,
      );
    }

    return null;
  }

  // ─── Cancellation ────────────────────────────────────────────────────

  /** Cancel the current run: abort in-flight requests, cancel sub-agents. */
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

  /** Build a base SessionState. Subclasses add agent-specific fields. */
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
   * Handle an LLMNetworkError: save checkpoint (if enabled) and return a
   * user-facing message with resume instructions.
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

    this.logger.error("Network Error", `${err.cause}: ${err.message}`);

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
   * Restore agent state from a saved session. Validates agent type
   * compatibility.
   * @throws if the session is not found, corrupt, or type-mismatch.
   */
  protected loadAndRestoreSession(sessionId: string): SessionState {
    if (!this.sessionManager) {
      throw new Error(
        "Cannot resume: no SessionManager configured. " +
          "Pass `sessionId` or `sessionDir` to the agent constructor.",
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
          `but this agent is type "${expectedType}". Cannot resume.`,
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

  /** Clear conversation history (preserves system prompt & config). */
  clearConversation(): void {
    this.contextManager.clear();
    this.tokenBudget?.reset();
  }

  /** Continue the current conversation with a follow-up input. */
  async chat(input: string): Promise<string> {
    return this.run(input);
  }

  /** Start a new topic: clears history, resets budget, runs input. */
  async newTopic(input: string): Promise<string> {
    this.clearConversation();
    return this.run(input);
  }

  /** Number of messages in the current conversation (excludes system message). */
  get conversationLength(): number {
    return this.contextManager.getMessages().length;
  }

  /** Cumulative token consumption for the current session, or null. */
  getSessionCost() {
    return this.tokenBudget?.getSessionCost() ?? null;
  }

  /** Reset agent to initial state — clears history, session, and runtime state. */
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

  /** Agent type identifier for session metadata ("react" or "plan-solve"). */
  protected getAgentType(): AgentType {
    return "react";
  }

  // ─── MCP / Async Initialization ─────────────────────────────────────────

  /**
   * Initialize async resources: MCP connections, sub-agent registry, RAG,
   * and auto-registered tools. Idempotent — safe to call multiple times.
   */
  protected async init(): Promise<void> {
    if (this._mcpInitialized) return;
    this._mcpInitialized = true;

    // ── Error tracking tool ──────────────────────────────────────────
    if (!this.skipAutoTools) {
      this.safeRegister(createListErrorsTool(this.toolRegistry));
    }

    // ── MCP connections ──────────────────────────────────────────────
    if (this.mcpServerConfigs && Object.keys(this.mcpServerConfigs).length > 0) {
      this.mcpClientManager = new McpClientManager(
        this.toolRegistry,
        this.logger,
      );
      const errors = await this.mcpClientManager.connectAll(
        this.mcpServerConfigs,
      );
      if (errors.length > 0) {
        this.logger.warn(
          "MCP",
          `${errors.length} of ${Object.keys(this.mcpServerConfigs).length} server(s) failed to connect.`,
        );
      }
    }

    // ── Sub-agent registry ───────────────────────────────────────────
    if (!this.disableSubAgents && this.subAgentsDir) {
      this.subAgentManager = new SubAgentManager();
      this.subAgentManager.setLogger(this.logger);
      this.subAgentManager.bind(
        this.llm,
        this.toolRegistry,
        this.skillManager,
        this.skillsDir,
        undefined,
        undefined,
        this.subAgentLLM,
        this.subAgentHooks,
      );
      this.subAgentManager.registerFromDirectory(this.subAgentsDir);

      this.safeRegister(createListSubagentsTool(this.subAgentManager));
      this.safeRegister(createSpawnSubagentTool(this.subAgentManager));

      // Include SUB_AGENT_DELEGATION in the system prompt for the first run.
      this.rebuildSystemPrompt();
    }

    // ── RAG knowledge base ─────────────────────────────────────────────
    if (this.ragConfig) {
      this.ragManager = new RAGManager(this.ragConfig, this.logger);
      await this.ragManager.index();
      this.safeRegister(createSearchKnowledgeTool(this.ragManager));
      this.safeRegister(createListKnowledgeDocumentsTool(this.ragManager));
    }

    // ── Skill tool (LLM-driven activation) ────────────────────────────
    if (!this.skipAutoTools) {
      this.safeRegister(
        createSkillTool(this.skillManager, () => this.rebuildSystemPrompt()),
      );
    }

    // ── Precipitate skill tool (LLM-driven skill saving) ──────────────
    if (!this.skipAutoTools && this.skillsDir) {
      this.safeRegister(
        createPrecipitateSkillTool(this.skillManager, this.skillsDir),
      );
    }

    // ── Remember / Recall tools (long-term memory) ────────────────────
    if (!this.skipAutoTools) {
      this.safeRegister(createRememberTool(this.memoryManager));
      this.safeRegister(createRecallTool(this.memoryManager));
    }
  }

  /** Register a tool, silently keeping the existing one on name collision. */
  private safeRegister(tool: Tool): void {
    try {
      this.toolRegistry.register(tool);
    } catch {
      this.logger.debug("Init", `"${tool.name}" already registered — keeping existing.`);
    }
  }

  /** Abort in-flight requests, cancel and await sub-agents, disconnect MCP. */
  async shutdown(): Promise<void> {
    this._abortController?.abort();

    // Cancel-before-await ensures sub-agents stuck on LLM calls
    // resolve quickly instead of waiting for the full timeout.
    this.subAgentManager?.cancelAll();
    await this.subAgentManager?.awaitAll();

    await this.mcpClientManager?.disconnectAll();
  }

  // ─── Sub-Agent ────────────────────────────────────────────────────────

  /** Whether sub-agents are configured and have registered definitions. */
  protected hasSubAgents(): boolean {
    return this.subAgentManager?.hasDefinitions() === true;
  }

  /**
   * Spawn a sub-agent by definition name. Runs asynchronously — call
   * `pollSubAgentResults()` each iteration to collect completed results.
   */
  protected spawnSubAgent(name: string, input: string): string {
    if (!this.subAgentManager) {
      throw new Error(
        "No SubAgentManager configured. Set `subAgentsDir` in AgentConfig.",
      );
    }
    return this.subAgentManager.spawn(name, input);
  }

  /** Poll for completed sub-agent results (call at start of each iteration). */
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
   * Capture the LLM's reasoning as error analysis for any active tool error
   * traces. Feeds the error→analysis pipeline: tool fails → LLM sees error
   * → its next thought is recorded as root-cause analysis.
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
    if (!tracker)
      return "# Tool Error Trace Report\n\n*Error tracker not configured.*\n";
    return tracker.generateMarkdownReport();
  }

  // ─── Answer Verification ────────────────────────────────────────────────

  /**
   * Run answer verification and, if needed, one correction cycle.
   *
   * Flow:
   * 1. Fork a VerifyAgent to check the answer.
   * 2. If it passes (score >= threshold) → return the original answer.
   * 3. If it fails → inject issues as feedback, make one LLM call to
   *    correct, then return the corrected answer.
   *
   * Failures (timeout, parse error) are non-fatal — the original answer
   * is returned so the user is never blocked.
   */
  protected async runVerification(
    input: string,
    answer: string,
  ): Promise<string> {
    const { VerifyAgent } = await import("../verification/verify-agent.js");

    const verifier = new VerifyAgent({
      llm: this.verificationLLM ?? this.llm,
      maxIterations: this.verificationMaxIterations,
      threshold: this.verificationThreshold,
      logger: this.logger,
      hooks: this.hooks,
    });

    const result = await verifier.verify({
      userQuery: input,
      answer,
    });

    if (result.valid) {
      this.logger.info(
        "Verification",
        `Answer passed verification (score: ${result.score}).`,
      );
      return answer;
    }

    this.logger.info(
      "Verification",
      `Answer failed verification (score: ${result.score}, threshold: ${this.verificationThreshold}). ` +
        `Issues: ${result.issues.length}. Attempting one correction cycle...`,
    );

    // Inject verification feedback and make one LLM call to correct
    const issuesText = result.issues
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join("\n");

    const feedbackMsg = Message.user(
      `⚠️ [VERIFICATION FAILED] The previous answer did not pass quality review ` +
        `(score: ${result.score}/100). Please fix the following issues:\n\n` +
        `${issuesText}\n\n` +
        `Assessment: ${result.assessment}\n\n` +
        `Please provide a corrected answer addressing each issue. Do NOT repeat the original answer — only output the corrected version.`,
    );
    this.contextManager.addMessage(feedbackMsg.toDict());

    // Make one LLM call (no tools) to get a corrected answer
    try {
      this._abortController = new AbortController();
      const messages = this.contextManager.getContextMessages();
      const llmResponse = await this.llm.chat(
        messages,
        undefined,
        this._abortController.signal,
      );

      if (llmResponse.content && llmResponse.content.trim().length > 5) {
        const assistantMsg = Message.assistant(llmResponse.content);
        this.contextManager.addMessage(assistantMsg.toDict());
        this.logger.info("Verification", "Correction applied.");
        return llmResponse.content;
      }
    } catch (err: unknown) {
      this.logger.warn(
        "Verification",
        `Correction LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fallback: return original answer with verification note
    return (
      answer +
      `\n\n[Note: This answer scored ${result.score}/100 on quality verification. Issues found:\n` +
      issuesText +
      `\nAssessment: ${result.assessment}]`
    );
  }
}
