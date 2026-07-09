import { SubAgentDefinition, SubAgentResult, PendingRun } from "./subagent-types";
import { SubAgentLoader } from "./subagent-loader";
import type { ReActAgent } from "../core/react-agent";
import { LLMProvider } from "../llm/interface";
import { ToolRegistry } from "../tools/tool-registry";
import { Tool } from "../tools/types";
import { ToolFilter } from "../tools/tool-filter";
import { SkillManager } from "../skills/skill-manager";
import { Logger, ConsoleLogger } from "../logging/logger";
import { AgentHooks } from "../core/hooks";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern (only `*` wildcards) to a RegExp.
 *
 * `*` matches any sequence of characters (like shell glob, not regex `.*`).
 * All other regex-special characters are escaped so they match literally.
 *
 * @example
 *   globToRegex("filesystem_*")  → /^filesystem_.*$/
 *   globToRegex("*_read")        → /^.*_read$/
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Manages sub-agent definitions, spawning, and result collection.
 *
 * The SubAgentManager is owned by the main agent. It:
 * 1. Loads sub-agent definitions from a directory (AGENT.md files)
 * 2. Spawns sub-agents on demand (fire-and-forget)
 * 3. Collects completed results for the main agent to pick up
 *
 * Sub-agents are standard ReActAgent instances with:
 * - A shared LLM provider (from the main agent)
 * - A filtered tool set (only tools declared in the definition)
 * - Pre-activated skills (as declared)
 * - NO spawn tool (prevents nested agent creation)
 */
export class SubAgentManager {
  private logger: Logger = new ConsoleLogger();

  /** Set the logger instance (called by the owning agent). */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Registered definitions keyed by name. */
  private definitions: Map<string, SubAgentDefinition> = new Map();

  /** Currently pending (running) sub-agents. */
  private pending: PendingRun[] = [];

  /** Shared LLM provider injected by the main agent. */
  private llmProvider?: LLMProvider;

  /**
   * Optional LLM provider for sub-agents.
   * When set, sub-agents use this instead of `llmProvider`.
   * Enables model routing — use a different (e.g. cheaper) model for
   * sub-agent tasks while keeping the main model for complex reasoning.
   */
  private subAgentLLM?: LLMProvider;

  /** Reference to the main agent's ToolRegistry for tool lookup. */
  private toolRegistry?: ToolRegistry;

  /** Reference to the main agent's SkillManager (fallback). */
  private skillManager?: SkillManager;

  /** Skills directory path for sub-agent skill loading. */
  private skillsDir?: string;

  /** Max wall-clock duration for a single sub-agent run (ms). Default: 5 min. */
  private timeoutMs: number = 5 * 60 * 1000;

  /**
   * Default ToolFilter applied to every sub-agent's tool set.
   * Useful for globally disallowing certain tools (e.g., sub-agent spawning).
   * Per-definition `toolFilter` is applied on top of this one.
   */
  private defaultFilter?: ToolFilter;

  /**
   * Hooks for sub-agents: a static set, or a factory `(name, runId) => hooks`
   * called per spawn. Passed to every sub-agent so their execution is
   * observable (tracing, metrics, etc.).
   */
  private subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[]);

  /** Counter for generating unique sub-agent run IDs. */
  private runIdCounter = 0;

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Register sub-agent definitions from a directory of AGENT.md files.
   */
  registerFromDirectory(dir: string): number {
    const loader = new SubAgentLoader(dir, undefined, this.logger);
    const definitions = loader.scan();
    let count = 0;

    for (const def of definitions) {
      if (this.definitions.has(def.name)) {
        this.logger.warn("SubAgent", `Skipping "${def.name}": already registered.`);
        continue;
      }
      this.definitions.set(def.name, def);
      count++;
    }

    if (count > 0) {
      this.logger.info("SubAgent", `Registered ${count} sub-agent(s) from ${dir}.`);
    }

    return count;
  }

  /**
   * Register a single sub-agent definition programmatically.
   */
  register(definition: SubAgentDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`SubAgent "${definition.name}" is already registered.`);
    }
    this.definitions.set(definition.name, definition);
  }

  /**
   * Check whether any sub-agent definitions are registered.
   *
   * Used by the main agent to decide whether to include sub-agent delegation
   * instructions in the system prompt.
   */
  hasDefinitions(): boolean {
    return this.definitions.size > 0;
  }

  /**
   * Set shared resources from the main agent.
   * Called once during agent init.
   *
   * @param defaultFilter Optional ToolFilter applied to all sub-agents.
   *                      Use this to globally deny dangerous tools
   *                      (e.g. `denylist("spawn_subagent")`).
   * @param subAgentLLM   Optional LLM provider for sub-agents.
   *                      When set, sub-agents use this instead of the main
   *                      `llmProvider`. Enables model routing.
   */
  bind(
    llmProvider: LLMProvider,
    toolRegistry: ToolRegistry,
    skillManager: SkillManager,
    skillsDir?: string,
    timeoutMs?: number,
    defaultFilter?: ToolFilter,
    subAgentLLM?: LLMProvider,
    subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[]),
  ): void {
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    this.skillsDir = skillsDir;
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
    this.defaultFilter = defaultFilter;
    this.subAgentLLM = subAgentLLM;
    this.subAgentHooks = subAgentHooks;
  }

  // ─── Spawn ────────────────────────────────────────────────────────────────

  /**
   * Spawn a sub-agent by definition name. Returns immediately with a run ID;
   * the sub-agent executes asynchronously.
   *
   * Multiple instances of the same definition can run concurrently — each
   * gets a unique run ID. This enables orchestrator patterns where the same
   * sub-agent type handles different inputs in parallel.
   *
   * @param name    The registered sub-agent definition name.
   * @param input   The task description passed to the sub-agent.
   * @param options Optional overrides — workdir scopes the sub-agent to
   *                a specific directory (e.g. a git worktree).
   * @returns The unique run ID (used to correlate results later).
   * @throws If the definition is unknown or the manager is not yet bound.
   */
  /** Maximum concurrent sub-agent runs before the spawn tool returns a "wait" message. */
  private static MAX_PENDING = 3;

  spawn(name: string, input: string, options?: { workdir?: string }): string {
    const definition = this.definitions.get(name);
    if (!definition) {
      const available = Array.from(this.definitions.keys()).join(", ") || "none";
      throw new Error(
        `Unknown sub-agent: "${name}". Available: ${available}`,
      );
    }

    // Prevent runaway spawns — if there are already several sub-agents
    // running, tell the LLM to wait instead of spawning more.
    if (this.pending.length >= SubAgentManager.MAX_PENDING) {
      throw new Error(
        `Too many sub-agents already running (${this.pending.length}). ` +
        `Wait for at least one to complete before spawning another.`,
      );
    }

    if (!this.llmProvider || !this.toolRegistry || !this.skillManager) {
      throw new Error(
        "SubAgentManager is not bound to an LLM provider / ToolRegistry / SkillManager. " +
        "Call bind() before spawn().",
      );
    }

    const runId = `${name}_${++this.runIdCounter}_${Date.now()}`;

    const pending: PendingRun = {
      subAgentId: runId,
      name,
      startedAt: Date.now(),
      resolved: null,
      promise: Promise.resolve(undefined as unknown as SubAgentResult), // placeholder
    };

    // Fire-and-forget: start the sub-agent run, store the result
    pending.promise = this.executeRun(name, runId, definition, input, pending.startedAt, options)
      .then((r) => { pending.resolved = r; return r; })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        const fallback: SubAgentResult = {
          subAgentId: runId,
          name,
          success: false,
          output: this.wrapXml(name, runId, false, message, Date.now() - pending.startedAt),
          durationMs: Date.now() - pending.startedAt,
        };
        pending.resolved = fallback;
        return fallback;
      });

    this.pending.push(pending);

    this.logger.info("SubAgent", `Spawned "${name}" (run: ${runId}).`);
    return runId;
  }

  // ─── Poll ─────────────────────────────────────────────────────────────────

  /**
   * Check all pending sub-agent runs for completion.
   *
   * Call this at the start of each ReAct iteration. Completed results
   * are removed from the pending queue and returned; still-running
   * entries remain queued.
   *
   * @returns Array of completed sub-agent results (empty if none finished).
   */
  async pollCompleted(): Promise<SubAgentResult[]> {
    if (this.pending.length === 0) return [];

    // Block until at least one pending sub-agent completes.
    // This prevents the main agent from spinning the LLM loop while
    // waiting for async sub-agent results — no wasted iterations.
    const firstDone = await Promise.race(
      this.pending.map((r) => r.promise.then(() => r)),
    );
    // Quick yield so any other recently-completed runs also surface
    await new Promise((r) => setImmediate(r));

    const results: SubAgentResult[] = [];
    const stillPending: PendingRun[] = [];

    for (const run of this.pending) {
      if (run.resolved !== null) {
        results.push(run.resolved);
        this.logger.info(
          "SubAgent",
          `"${run.name}" (run: ${run.subAgentId}) completed in ${run.resolved.durationMs}ms.`,
        );
      } else {
        stillPending.push(run);
      }
    }

    this.pending = stillPending;
    return results;
  }

  /**
   * Wait for all pending sub-agents to complete.
   * Useful for graceful shutdown.
   */
  async awaitAll(): Promise<SubAgentResult[]> {
    const results = await Promise.all(this.pending.map((r) => r.promise));
    this.pending = [];
    return results;
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────

  /**
   * Cancel all pending sub-agents without waiting for them to finish.
   *
   * Running sub-agents are marked as cancelled but their promises are
   * kept alive. When the agent resumes, `collectOrphanedResults()` can
   * recover completed results so the LLM sees sub-agent output instead
   * of losing it forever.
   */
  cancelAll(): void {
    if (this.pending.length === 0) return;
    let marked = 0;
    for (const run of this.pending) {
      if (!run.cancelled && run.resolved === null) {
        run.cancelled = true;
        marked++;
      }
    }
    if (marked > 0) {
      this.logger.info("SubAgent", `Marked ${marked} pending sub-agent(s) as cancelled (results preserved).`);
    }
  }

  /**
   * Collect results from sub-agents that were cancelled mid-run.
   *
   * Call this after resuming a session to pick up any sub-agent results
   * that completed while the agent was inactive. Results are removed from
   * the pending queue and tagged so the LLM knows they were interrupted.
   *
   * @returns Completed results from cancelled sub-agents.
   */
  collectOrphanedResults(): SubAgentResult[] {
    const results: SubAgentResult[] = [];
    const stillPending: PendingRun[] = [];

    for (const run of this.pending) {
      if (run.cancelled && run.resolved !== null) {
        const tagged = {
          ...run.resolved,
          output: `[Interrupted by user — result recovered on resume]\n\n${run.resolved.output}`,
        };
        results.push(tagged);
      } else {
        stillPending.push(run);
      }
    }

    this.pending = stillPending;
    return results;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  hasRunning(): boolean {
    return this.pending.length > 0;
  }

  getActiveCount(): number {
    return this.pending.length;
  }

  getDefinitions(): SubAgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Build a formatted list of all registered sub-agents with their
   * capabilities (returned by the `list_subagents` tool).
   */
  buildSubAgentList(): string {
    if (this.definitions.size === 0) return "No sub-agents registered.";
    const lines: string[] = [];
    for (const def of this.definitions.values()) {
      lines.push(`- **${def.name}**: ${def.description}`);
      if (def.tools.length > 0) {
        lines.push(`  Tools: ${def.tools.join(", ")}`);
      }
      if (def.skills.length > 0) {
        lines.push(`  Skills: ${def.skills.join(", ")}`);
      }
    }
    return lines.join("\n");
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Execute a sub-agent run and wrap the result in XML.
   */
  private async executeRun(
    name: string,
    runId: string,
    definition: SubAgentDefinition,
    input: string,
    startedAt: number,
    options?: { workdir?: string },
  ): Promise<SubAgentResult> {
    const runPromise = this.doExecute(name, runId, definition, input, startedAt, options);

    // Wrap with timeout
    const timeoutPromise = new Promise<SubAgentResult>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Sub-agent "${name}" timed out after ${this.timeoutMs / 1000}s.`)),
        this.timeoutMs,
      );
    });

    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      return {
        subAgentId: runId,
        name,
        success: false,
        output: this.wrapXml(name, runId, false, message, durationMs),
        durationMs,
      };
    }
  }

  private async doExecute(
    name: string,
    runId: string,
    definition: SubAgentDefinition,
    input: string,
    startedAt: number,
    options?: { workdir?: string },
  ): Promise<SubAgentResult> {
    const agent = await this.buildSubAgent(definition, options?.workdir);

    // Resolve and apply sub-agent hooks (static or factory).
    // Unsafe hooks (safeForSubAgent === false) are skipped — they could
    // spawn their own sub-agents and cause unbounded recursion.
    if (this.subAgentHooks) {
      const hooks = typeof this.subAgentHooks === "function"
        ? this.subAgentHooks(name, runId)
        : this.subAgentHooks;
      const hooksArr = Array.isArray(hooks) ? hooks : [hooks];
      for (const h of hooksArr) {
        if (h.safeForSubAgent === false) {
          this.logger.warn(
            "SubAgent",
            `Skipping hook for "${name}": hook is marked safeForSubAgent=false (may cause recursion).`,
          );
          continue;
        }
        agent.addHook(h);
      }
    }

    const output = await agent.run(input);
    const durationMs = Date.now() - startedAt;
    return {
      subAgentId: runId,
      name,
      success: true,
      output: this.wrapXml(name, runId, true, output, durationMs),
      durationMs,
    };
  }

  /**
   * Build a ReActAgent instance from a sub-agent definition, with:
   * - Filtered tool set (name allowlist + wildcard patterns → defaultFilter → definition.toolFilter)
   * - Pre-activated skills (copied from main agent's SkillManager)
   * - No spawn tool
   * - Auto-detect disabled (skills are pre-activated)
   *
   * Tool name patterns support `*` as a wildcard. For example,
   * `filesystem_*` matches all tools whose names start with `filesystem_`
   * (e.g. MCP tools from the "filesystem" server).
   */
  private async buildSubAgent(definition: SubAgentDefinition, workdir?: string): Promise<ReActAgent> {
    // Look up declared tools from the main agent's registry.
    // Supports wildcard patterns (e.g. "filesystem_*" matches all tools
    // from the "filesystem" MCP server). Uses a Map for deduplication.
    const toolMap = new Map<string, Tool>();
    const allToolNames = this.toolRegistry!.toolNames;
    const allTools = this.toolRegistry!.getTools();

    for (const toolPattern of definition.tools) {
      if (toolPattern.includes("*")) {
        // Wildcard pattern — match against all tool names in the registry
        const regex = globToRegex(toolPattern);
        let matched = 0;
        for (const toolName of allToolNames) {
          if (regex.test(toolName)) {
            const tool = allTools.find((t) => t.name === toolName);
            if (tool && !toolMap.has(toolName)) {
              toolMap.set(toolName, tool);
              matched++;
            }
          }
        }
        if (matched === 0) {
          this.logger.warn(
            "SubAgent",
            `Pattern "${toolPattern}" requested by "${definition.name}" matched no tools.`,
          );
        }
      } else {
        // Exact match (existing behavior)
        const tool = this.toolRegistry!.getTool(toolPattern);
        if (tool) {
          toolMap.set(toolPattern, tool);
        } else {
          this.logger.warn(
            "SubAgent",
            `Tool "${toolPattern}" requested by "${definition.name}" not found in registry.`,
          );
        }
      }
    }

    const tools = Array.from(toolMap.values());

    // Build a dedicated ToolRegistry for this sub-agent
    const toolRegistry = new ToolRegistry();
    if (tools.length > 0) {
      toolRegistry.registerMany(tools);
    }

    // Compose filters: name allowlist applied first, then defaultFilter,
    // then definition-level toolFilter. Each layer narrows the set.
    if (this.defaultFilter || definition.toolFilter) {
      const filteredRegistry = new ToolRegistry();
      const namesOnly = toolRegistry.toolNames;
      const allTools = this.toolRegistry!.getTools();
      for (const toolName of namesOnly) {
        const tool = allTools.find((t) => t.name === toolName);
        if (!tool) continue;

        let pass = true;
        if (this.defaultFilter && !this.defaultFilter.filter(tool)) {
          pass = false;
        }
        if (pass && definition.toolFilter && !definition.toolFilter.filter(tool)) {
          pass = false;
        }
        if (pass) {
          filteredRegistry.register(tool);
        }
      }
      // Replace with the doubly-filtered registry
      // (reuse the variable for the rest of the method)
      return await this.finishBuildSubAgent(
        definition,
        filteredRegistry,
        workdir,
      );
    }

    return await this.finishBuildSubAgent(definition, toolRegistry, workdir);
  }

  /** Shared tail of buildSubAgent: wire up skills and return the agent. */
  private async finishBuildSubAgent(
    definition: SubAgentDefinition,
    toolRegistry: ToolRegistry,
    workdir?: string,
  ): Promise<ReActAgent> {

    // Build a dedicated SkillManager with declared skills pre-activated.
    // Use registerFromDirectory when skillsDir is available so lazy-loading
    // works correctly (populates systemPrompt from disk).
    const skillManager = new SkillManager();
    if (this.skillsDir) {
      skillManager.registerFromDirectory(this.skillsDir);
    }
    for (const skillName of definition.skills) {
      if (skillManager.has(skillName)) {
        skillManager.activate(skillName);
      } else {
        this.logger.warn(
          "SubAgent",
          `Skill "${skillName}" requested by "${definition.name}" not found.`,
        );
      }
    }

    // Build system prompt: sub-agent definition prompt + active skill content
    const systemPrompt = definition.systemPrompt;

    // Select the LLM provider for this sub-agent:
    // subAgentLLM (from AgentConfig) takes priority over the main model.
    const effectiveLLM = this.subAgentLLM ?? this.llmProvider!;

    // Dynamic import to break CJS circular dependency:
    // agent.ts → subagent-manager.ts → react-agent.ts → agent.ts
    const { ReActAgent: ReActAgentCtor } = await import("../core/react-agent.js");
    return new ReActAgentCtor({
      llm: effectiveLLM,
      systemPrompt,
      toolRegistry,
      skillManager,
      name: definition.name,
      maxIterations: 10,
      // Prevent infinite recursion: sub-agents should NOT auto-register
      // sub-agents from the project directory.
      // "" explicitly disables the default (undefined would be overridden
      // by the ?? "./subagents/" fallback in the Agent constructor).
      subAgentsDir: "",
      workdir,
    });
  }

  /**
   * Wrap the sub-agent output in an XML envelope for the main agent.
   */
  private wrapXml(
    name: string,
    runId: string,
    success: boolean,
    output: string,
    durationMs: number,
  ): string {
    return [
      `<subagent-result name="${escapeXml(name)}" id="${runId}" success="${success}" duration_ms="${durationMs}">`,
      output,
      "</subagent-result>",
    ].join("\n");
  }
}

/** Escape special XML characters. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
