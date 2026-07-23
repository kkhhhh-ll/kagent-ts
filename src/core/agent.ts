import { LLMProvider, ToolCall } from "../llm/interface";
import { LLMNetworkError } from "../llm/errors";
import { ModelRouter } from "../llm/model-router";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import { SECURITY_GUIDANCE, SUB_AGENT_DELEGATION, FORK_AGENT_GUIDANCE, RAG_KNOWLEDGE_BASE_HINT } from "./system-prompts";
import { wrapAndScan, wrapUntrusted, detectInjectionSignatures, buildInjectionWarning } from "../security/boundaries";
import { ContextManager } from "../context/context-manager";
import { Tool } from "./types";
import { ToolRegistry } from "../tools/tool-registry";
import { ToolOutputTruncator } from "../tools/tool-output-truncator";
import { ToolResult, ToolErrorCode, toolError } from "../tools/types";
import { validateToolArgs } from "../tools/tool-validator";
import { SkillManager } from "../skills/skill-manager";
import { MemoryManager } from "../memory/memory-manager";
import { Retriever } from "../rag/retriever";
import { ProjectRules } from "../rules/project-rules";
import { SessionManager } from "../session/session-manager";
import {
  SessionState,
  SessionStatus,
  AgentType,
} from "../session/session-types";
import { countTokens } from "../utils/token-counter";
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
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent";
import { createSkillTool } from "../tools/builtin/skill";
import { createRememberTool } from "../tools/builtin/remember";
import { createRecallTool } from "../tools/builtin/recall";
import { createForkAgentTool } from "../tools/builtin/fork-agent";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin";
import { Logger, ConsoleLogger } from "../logging/logger";
import { TokenBudget, TokenBudgetConfig } from "../llm/token-budget";
import { detectSignals } from "../intent";
import type { UserSignals } from "../intent";
import type { RetrievedSkill, RetrievedMemory } from "../rag/retriever";
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
   * A pre-configured SkillManager. If provided, `skillsDir` is ignored.
   */
  skillManager?: SkillManager;

  /**
   * Path to a directory of file-based skills (each with a `SKILL.md`).
   * Skills are lazily loaded: metadata at startup, full content on activation.
   */
  skillsDir?: string;

  /**
   * Path to long-term memory storage (default: `".k-memory"`). Persists facts,
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

  /** When true, skip auto-registration of `remember`, `recall`, `skill`. */
  skipAutoTools?: boolean;

  /**
   * LLM provider for sub-agents. When omitted, inherits the main `llm`
   * (or `ModelRouter.forSubAgent()` if using a router). Use a cheaper model
   * for sub-agent tasks to save cost.
   */
  subAgentLLM?: LLMProvider;

  /**
   * LLM provider for task-complexity routing / lightweight classification.
   *
   * Used by FusionAgent to decide whether a task is "simple" or "complex".
   * When omitted, resolves via `ModelRouter.forLightweight()` or falls back
   * to `llm`. Use a cheaper model — routing is a single lightweight call.
   */
  routeLLM?: LLMProvider;

  /**
   * Hooks for sub-agents. Accepts a single {@link AgentHooks}, an array, or a
   * factory `(name, runId) => AgentHooks | AgentHooks[]`. **WARNING**: Do NOT
   * pass hooks that spawn sub-agents — unbounded recursion.
   */
  subAgentHooks?:
    | AgentHooks
    | AgentHooks[]
    | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /**
   * Maximum concurrent sub-agent runs. Default: 3. When this limit is
   * reached, new spawns enter a FIFO wait queue instead of failing.
   */
  maxPending?: number;

  /**
   * Maximum sub-agent wait queue length. Default: 20. When the queue is
   * full, the spawn tool returns an error, signaling the LLM to wait
   * before spawning more. Prevents runaway memory growth from
   * uncontrolled spawns.
   */
  maxQueueSize?: number;

  /**
   * When the LLM spawns sub-agents in a tool-call batch, the agent
   * opportunistically waits up to this many milliseconds for quick
   * sub-agent results before continuing the ReAct loop.
   *
   * Fast results are injected into context in the same iteration,
   * saving a full LLM round-trip. Results that don't finish in time
   * are picked up by the next iteration's {@code pollCompleted()}.
   *
   * Default: 30_000 (30 seconds).  Set to 0 to disable (always
   * background).
   */
  subAgentFastTimeoutMs?: number;

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

  /** Max concurrent sub-agent runs (default: 3). */
  protected maxPending?: number;

  /** Max sub-agent wait queue length (default: 20). */
  protected maxQueueSize?: number;

  /** Max ms to wait for fast sub-agent results after spawn (default: 30_000). */
  protected subAgentFastTimeoutMs?: number;

  /** LLM provider for task-complexity routing (defaults to main llm if not set). */
  protected routeLLM?: LLMProvider;

  /** LLM provider for memory reflection (defaults to main llm if not set). */
  protected memoryReflectorLLM?: LLMProvider;

  /** Signals detected from the current run's user input. */
  protected inputSignals: UserSignals = { wantsRemember: false, riskLevel: "none" };

  /** Skills auto-activated by BM25 retrieval (before LLM involvement). */
  protected autoActivatedSkills: RetrievedSkill[] = [];

  /** Memories retrieved by BM25 for the current query (full content injected). */
  protected retrievedMemories: RetrievedMemory[] = [];

  /** BM25 retriever for memories and skills (separate indexes). */
  protected retriever: Retriever = new Retriever();

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
        undefined,
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

    // Load MCP server config only when the user explicitly configured it.
    // Skip for sub-agents (they inherit MCP tools from the parent's ToolRegistry).
    if (cfg.mcpConfigPath || cfg.mcpServers) {
      const effectiveMcpPath = cfg.toolRegistry
        ? undefined
        : cfg.mcpConfigPath;
      this.mcpServerConfigs = Agent.loadMcpConfig(
        effectiveMcpPath,
        cfg.mcpServers,
        this.logger,
      );
    }
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
    this.maxPending = cfg.maxPending;
    this.maxQueueSize = cfg.maxQueueSize;
    this.subAgentFastTimeoutMs = cfg.subAgentFastTimeoutMs;

    // Resolve routing LLM (task-complexity classification):
    // 1. Explicit `routeLLM` → use it directly
    // 2. `llm` is a ModelRouter → use router.forLightweight()
    // 3. Fallback → routing shares the main `llm`
    if (cfg.routeLLM) {
      this.routeLLM = cfg.routeLLM;
    } else if (cfg.llm instanceof ModelRouter) {
      this.routeLLM = cfg.llm.forLightweight();
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
   *
   * Inherits the full conversation context from this agent so the fork
   * benefits from prompt caching and structured message history.
   */
  public async fork(
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
      hooks: this.hooks,
      ...options,
      signal: this._abortController?.signal,
      contextMessages: this.contextManager.getContextMessages(),
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
   * Build the memory section of the system prompt.
   *
   * Two-tier disclosure:
   * 1. BM25-retrieved memories (top-5) — full content injected directly so
   *    the LLM doesn't need to call `recall`.
   * 2. Remaining memories — name-only index so the LLM can `recall` any
   *    that the BM25 top-5 missed.
   *
   * Falls back to the full name-only index when no query-specific
   * retrieval has been done yet (e.g., initial system prompt build).
   */
  private buildMemoryPrompt(): string {
    const retrieved = this.retrievedMemories;
    const all = this.memoryManager.getAll();

    if (all.length === 0) return "";

    // Build a set of retrieved memory names for exclusion from the index
    const retrievedNames = new Set(retrieved.map((r) => r.memory.name));

    const parts: string[] = [];

    // Tier 1: Full content of BM25-retrieved memories
    if (retrieved.length > 0) {
      const content = retrieved
        .map((r) => {
          const m = r.memory;
          const badge = m.type === "rule" ? "📜 Rule"
            : m.type === "preference" ? "💬 Preference"
            : "📋 Project";
          return `### ${badge}: ${m.name}\n*${m.description}*\n\n${m.content}`;
        })
        .join("\n\n");
      parts.push(`## Relevant Memories (auto-loaded for this task — ${retrieved.length} retrieved via BM25)\n\n${content}`);
    }

    // Tier 2: Name-only index of remaining memories
    const remaining = all.filter((m) => !retrievedNames.has(m.name));
    if (remaining.length > 0) {
      const rules = remaining.filter((m) => m.type === "rule");
      const projects = remaining.filter((m) => m.type === "project");
      const prefs = remaining.filter((m) => m.type === "preference");

      const sections: string[] = [];
      if (rules.length > 0) {
        sections.push("📜 Rules", ...rules.map((e) => `- ${e.name}`));
      }
      if (projects.length > 0) {
        sections.push("📋 Project", ...projects.map((e) => `- ${e.name}`));
      }
      if (prefs.length > 0) {
        sections.push("💬 Preferences (observed habits — soft guidance)", ...prefs.map((e) => `- ${e.name}`));
      }

      parts.push(
        `## All Memories (${remaining.length} more — use \`recall\` to load full content)\n` +
        sections.join("\n"),
      );
    }

    // Memory content is LLM-authored (via `remember` tool or MemoryReflector).
    // Wrap as untrusted data and scan for injection signatures before injecting
    // back into the system prompt — prevents accidental prompt poisoning.
    const body = parts.join("\n\n");
    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "memory index");
    const wrapped = wrapUntrusted("memory-index", body);

    return "\n\n" + warning + wrapped;
  }

  /**
   * Build the full system prompt by concatenating all sections in priority
   * order: core prompt → rules → memories → skills. Empty
   * sections are silently skipped. Subclasses append extra content by
   * calling this and concatenating, rather than duplicating the assembly.
   */
  protected buildSystemPrompt(): string {
    const sections = [
      this.coreSystemPrompt,
      SECURITY_GUIDANCE,
      FORK_AGENT_GUIDANCE,
      this.hasSubAgents() ? SUB_AGENT_DELEGATION : "",
      this.hasSubAgents() ? this.buildSubAgentHint() : "",
      this.projectRules.buildPrompt(),
      this.buildMemoryPrompt(),
      this.skillManager.buildAvailableSkillsHint(),
      this.skillManager.buildSkillsPrompt(),
      this.ragConfig ? RAG_KNOWLEDGE_BASE_HINT : "",
    ].filter(Boolean);

    return sections.join("");
  }

  protected rebuildSystemPrompt(): void {
    this.contextManager.setSystemMessage(this.buildSystemPrompt());
  }

  /**
   * Intercept hallucinated "answer" tool calls.
   *
   * Some models (e.g. DeepSeek) occasionally confuse the "answer" key in the
   * JSON response format with a function name and emit it via tool_calls
   * instead of the content field. This extracts the answer text so we don't
   * waste a round-trip on a FATAL:UNKNOWN_TOOL error.
   *
   * @returns The answer string if found, or null.
   */
  protected extractAnswerFromToolCalls(
    toolCalls: { function?: { name?: string; arguments?: string } }[],
  ): string | null {
    const answerCall = toolCalls.find(
      (tc) => tc.function?.name === "answer",
    );
    if (!answerCall?.function?.arguments) return null;
    try {
      const args = JSON.parse(answerCall.function.arguments);
      if (typeof args.answer === "string" && args.answer.trim()) {
        return args.answer;
      }
    } catch {
      // Malformed JSON — not a real answer call
    }
    return null;
  }

  /**
   * Pre-iteration maintenance: compress context window if needed.
   *
   * Fires {@link AgentHooks.onCompressionStart} and
   * {@link AgentHooks.onCompressionEnd} around the compression step so
   * tracers / loggers can record the event.
   */
  protected async checkAndCompress(): Promise<void> {
    const model = this.llm?.model;
    if (!this.contextManager.shouldCompress(model)) return;

    const beforeTokens = this.contextManager.getCurrentTokens(model);
    const state = this.contextManager.getState();

    for (const h of this.hooks) {
      h.onCompressionStart?.(beforeTokens, state.maxTokens, state.messageCount);
    }

    const { tokensSaved, details } = await this.contextManager.compress(this.llm);

    const afterTokens = this.contextManager.getCurrentTokens(model);

    for (const h of this.hooks) {
      h.onCompressionEnd?.(beforeTokens, afterTokens, tokensSaved, details);
    }
  }

  /** Re-scan skills directory for new SKILL.md files added between runs. */
  protected reloadSkillsFromDirectory(): boolean {
    if (!this.skillsDir) return false;
    const added = this.skillManager.reloadFromDirectory(this.skillsDir);
    if (added.length > 0) {
      this.retriever.invalidateSkillIndex();
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
  ): Promise<{ hadFailure: boolean; hadSpawnCalls: boolean }> {
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
    let hadSpawnCalls = false;
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
      // asynchronously and will be injected via pollSubAgentResults() or
      // the fast-results wait (collectFastResults) in the ReAct loop.
      const isSpawnCall = slot.toolCall.function.name === "spawn_subagent"
        || slot.toolCall.function.name === "fork_agent";
      if (result.success && isSpawnCall) {
        hadSpawnCalls = true;
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

    return { hadFailure, hadSpawnCalls };
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

  /** Save a cancelled checkpoint and return the session id. */
  protected cancelCheckpoint(): string {
    this.saveCheckpoint("cancelled");
    return this.sessionManager?.getSessionId() ?? "unknown";
  }

  /** Build the full cancellation message for run() methods. */
  protected cancelMessage(sid: string): string {
    return `Execution cancelled by user. Session "${sid}" preserved — ` +
      `resume with agent.resume("${sid}", "<your prompt>").`;
  }

  // ─── Session ID ──────────────────────────────────────────────────────

  /**
   * Lazily-generated fallback session ID for runs that don't configure
   * session persistence. Generated once per instance so all log messages
   * and entries within a single agent lifetime share the same ID.
   */
  private _fallbackSessionId?: string;

  /** Return a session ID suitable for logging and traceability. */
  protected getSessionId(): string {
    if (this.sessionManager) return this.sessionManager.getSessionId();
    if (!this._fallbackSessionId) {
      this._fallbackSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return this._fallbackSessionId;
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

  /** Expose context messages for fork tools that need context inheritance. */
  getContextMessages(): import("../messages/types").MessageData[] {
    return this.contextManager.getContextMessages();
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
    this.subAgentManager?.clear();
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

    this.logger.info("Init", "Starting agent initialization...");

    // ── Kick off parallel subsystem initialization ───────────────────
    // MCP connections, sub-agent registry, and RAG indexing are all
    // I/O-bound and independent — running them in parallel cuts cold-start
    // latency by up to 50% (they no longer wait for each other).
    const tasks: Promise<void>[] = [];

    if (this.mcpServerConfigs && Object.keys(this.mcpServerConfigs).length > 0) {
      tasks.push(this.initMcp());
    }
    if (!this.disableSubAgents && this.subAgentsDir) {
      tasks.push(this.initSubAgents());
    }
    if (this.ragConfig) {
      tasks.push(this.initRag());
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    // ── Fast tool registration (independent of I/O-heavy subsystems) ──
    if (!this.skipAutoTools) {
      this.safeRegister(
        createSkillTool(this.skillManager, () => this.rebuildSystemPrompt()),
      );
      this.safeRegister(createRememberTool(this.memoryManager));
      this.safeRegister(createRecallTool(this.memoryManager));
      this.safeRegister(createForkAgentTool(this, this.subAgentManager));
    }

    this.logger.info("Init", "Agent initialization complete.");
  }

  /** Connect to MCP servers and register their tools. */
  private async initMcp(): Promise<void> {
    const serverCount = Object.keys(this.mcpServerConfigs!).length;
    this.logger.info("Init", `Connecting to ${serverCount} MCP server(s)...`);
    this.mcpClientManager = new McpClientManager(
      this.toolRegistry,
      this.logger,
    );
    const errors = await this.mcpClientManager.connectAll(
      this.mcpServerConfigs!,
    );
    if (errors.length > 0) {
      this.logger.warn(
        "MCP",
        `${errors.length} of ${serverCount} server(s) failed to connect.`,
      );
    }
  }

  /** Register sub-agents from the configured directory. */
  private async initSubAgents(): Promise<void> {
    this.logger.info("Init", "Loading sub-agents...");
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
      this.maxPending,
      this.maxQueueSize,
      this.onToolApproval,
    );
    this.subAgentManager.registerFromDirectory(this.subAgentsDir!);
    this.safeRegister(createSpawnSubagentTool(this.subAgentManager));
    // Include SUB_AGENT_DELEGATION in the system prompt for the first run.
    this.rebuildSystemPrompt();
  }

  /** Index documents from the knowledge base and register search tools. */
  private async initRag(): Promise<void> {
    this.logger.info("Init", "Indexing knowledge base...");
    this.ragManager = new RAGManager(this.ragConfig!, this.logger);
    await this.ragManager.index();
    this.safeRegister(createSearchKnowledgeTool(this.ragManager));
    this.safeRegister(createListKnowledgeDocumentsTool(this.ragManager));
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

  /** Build a compact hint listing available sub-agents for the system prompt. */
  protected buildSubAgentHint(): string {
    if (!this.subAgentManager) return "";
    const body = this.subAgentManager.buildSubAgentHint();
    if (!body) return "";

    // Sub-agent names/descriptions are authored by the project maintainer —
    // same trust level as skill descriptions.
    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "sub-agent descriptions");
    const wrapped = wrapUntrusted("subagent-index", body);

    return "\n\n" + warning + wrapped;
  }

  /**
   * Cancel a single sub-agent run by its run ID.
   *
   * - **Queued** (not yet started): removed from the wait queue immediately.
   * - **Running**: the agent's in-flight LLM request is aborted and its
   *   ReAct loop terminates. Cancelled results appear in the next
   *   `pollCompleted()` call.
   * - **Already completed / errored**: no-op, returns
   *   `{cancelled: false}`.
   *
   * @param runId The run ID returned by {@link spawnSubAgent}.
   * @returns A result indicating whether cancellation succeeded.
   */
  cancelSubAgent(runId: string): { cancelled: boolean; wasRunning?: boolean; reason?: string } {
    if (!this.subAgentManager) {
      return { cancelled: false, reason: "no sub-agent manager configured" };
    }
    return this.subAgentManager.cancel(runId);
  }

  /**
   * Opportunistically wait for fast sub-agent results after a spawn.
   *
   * Called after tool execution when {@code hadSpawnCalls} is true.  Waits
   * up to {@link subAgentFastTimeoutMs} (default 30 s) for any spawned
   * sub-agent to complete.  Fast results are injected directly into context
   * so the LLM sees them on the very next ReAct iteration — no wasted
   * round-trip for sub-agents that finish quickly.  Slower results stay in
   * the background and are picked up by {@link pollSubAgentResults}.
   */
  protected async collectFastSubAgentResults(hadSpawnCalls: boolean): Promise<void> {
    if (!hadSpawnCalls || !this.subAgentManager) return;
    const timeout = this.subAgentFastTimeoutMs ?? 30_000;
    if (timeout <= 0) return;

    const fastResults = await this.subAgentManager.collectFastResults(timeout);
    for (const r of fastResults) {
      const source = `subagent:${r.name}`;
      const msg = new Message(
        Role.User,
        wrapAndScan(source, r.output),
        { name: source },
      );
      this.contextManager.addMessage(msg.toDict());
    }
    if (fastResults.length > 0) {
      this.logger.info(
        "SubAgent",
        `${fastResults.length} fast result(s) injected in same iteration.`,
      );
    }
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

  /**
   * Guard for final-answer branches: when the LLM proposes a final answer
   * while spawned sub-agents are still running, inject a wait notice into
   * the context and return true. The loop should `continue` so the next
   * `pollSubAgentResults()` delivers the pending results instead of
   * orphaning them (orphaned results only resurface via session resume).
   *
   * Callers must still bound this with the iteration budget — on the last
   * iteration, finish anyway rather than loop forever.
   */
  protected holdAnswerForPendingSubAgents(): boolean {
    if (!this.subAgentManager || !this.subAgentManager.hasRunning()) return false;
    const running = this.subAgentManager.getActiveCount();
    const queued = this.subAgentManager.getQueueLength();
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    this.logger.info(
      "SubAgent",
      `Final answer proposed while ${parts.join(" + ")} sub-agent(s) still pending — waiting for their results before finalizing.`,
    );
    const msg = Message.user(
      `[System] ${parts.join(" and ")} sub-agent(s) you spawned are still pending — do NOT finalize yet. ` +
        `Their results will arrive in a future message; incorporate them before giving your final answer.`,
    );
    this.contextManager.addMessage(msg.toDict());
    return true;
  }

  // ─── Background Tasks ─────────────────────────────────────────────────

  /** In-flight fire-and-forget tasks (memory reflection). */
  private backgroundTasks: Set<Promise<unknown>> = new Set();

  /**
   * Track a fire-and-forget background task so callers can await settlement
   * via {@link awaitBackgroundTasks}. Returns the original promise so call
   * sites can keep their own `.catch()` chains.
   */
  protected trackBackground<T>(p: Promise<T>): Promise<T> {
    const settled: Promise<unknown> = p.catch(() => {});
    this.backgroundTasks.add(settled);
    void settled.finally(() => this.backgroundTasks.delete(settled));
    return p;
  }

  /**
   * Wait for all in-flight background tasks (memory reflection) to settle.
   *
   * Call this before exiting the process — the post-hoc tasks are
   * fire-and-forget, so `run()` resolves before they finish and an
   * immediate `process.exit()` would truncate them mid-flight.
   */
  async awaitBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  // ─── Intent Detection ─────────────────────────────────────────────────

  /**
   * Detect user signals from the input string (zero LLM cost).
   *
   * Stores results on `this.inputSignals` so downstream logic
   * (memory reflection, plan confirmation)
   * reads flags instead of running ad-hoc regex.
   *
   * Called once at the start of every `run()`.
   */
  protected detectInputSignals(input: string): void {
    this.inputSignals = detectSignals(input);

    if (this.inputSignals.wantsRemember) {
      this.logger.info("Intent", "User intent to remember detected.");
    }
    this.logger.info(
      "Intent",
      `Signals detected — risk: ${this.inputSignals.riskLevel}, wantsRemember: ${this.inputSignals.wantsRemember}`,
    );
  }

  /**
   * BM25-retrieve relevant skills and memories for the current user input.
   *
   * Skills and memories are indexed separately — skills once (cached),
   * memories every run (they can change via the `remember` tool).
   *
   * Top matches have their full content injected into the system prompt,
   * so the LLM never needs to call `skill` or `recall` for obvious hits.
   *
   * Called once at the start of every `run()`.
   */
  protected matchInputContext(input: string): void {
    // ── Skills: BM25 retrieval ──────────────────────────────────────────
    if (this.skillManager) {
      const skills = this.skillManager.getAll();
      if (skills.length > 0) {
        // Pre-load system prompts so BM25 indexes the full skill content
        // (file-based skills lazily load systemPrompt on activation)
        this.skillManager.preloadAllSystemPrompts();
        this.retriever.indexSkills(skills);
        this.autoActivatedSkills = this.retriever.retrieveSkills(input, 5);

        for (const m of this.autoActivatedSkills) {
          this.skillManager.activate(m.skill.name);
          const reloaded = this.skillManager.get(m.skill.name);
          if (reloaded) m.skill = reloaded;
        }

        if (this.autoActivatedSkills.length > 0) {
          this.logger.info(
            "Retriever",
            `BM25-matched ${this.autoActivatedSkills.length} skill(s): ${this.autoActivatedSkills.map((m) => m.skill.name).join(", ")}`,
          );
        }
      }
    }

    // ── Memories: BM25 retrieval ────────────────────────────────────────
    const allMemories = this.memoryManager.getAll();
    if (allMemories.length > 0) {
      this.retriever.indexMemories(allMemories);
      this.retrievedMemories = this.retriever.retrieveMemories(input, 5);
      // Touch retrieved memories so LRU eviction preserves actively-used entries
      for (const r of this.retrievedMemories) {
        this.memoryManager.touch(r.memory.name);
      }
    } else {
      this.retrievedMemories = [];
    }

    // Always rebuild — even when nothing matched, the system prompt
    // needs to be cleared of any retrieved memories from the previous run.
    this.rebuildSystemPrompt();
  }

}
