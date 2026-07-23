import {
  SubAgentDefinition,
  SubAgentResult,
  PendingRun,
  QueuedRun,
  CancelResult,
} from "./subagent-types";
import { SubAgentLoader } from "./subagent-loader";
import type { ReActAgent } from "../core/react-agent";
import { LLMProvider } from "../llm/interface";
import { ToolRegistry } from "../tools/tool-registry";
import { Tool } from "../tools/types";
import { ToolFilter } from "../tools/tool-filter";
import { SkillManager } from "../skills/skill-manager";
import { Logger, ConsoleLogger } from "../logging/logger";
import { AgentHooks } from "../core/hooks";
import type { ApprovalCallback } from "../core/agent";

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
 * 2. Spawns sub-agents on demand (fire-and-forget, with an internal queue
 *    when all concurrent slots are full)
 * 3. Collects completed results for the main agent to pick up
 *
 * Sub-agents are standard ReActAgent instances with:
 * - A shared LLM provider (from the main agent)
 * - A filtered tool set (only tools declared in the definition)
 * - Pre-activated skills (as declared)
 * - NO spawn tool (prevents nested agent creation)
 *
 * ## Queue behaviour
 *
 * When {@link maxPending} slots are all occupied, new spawns enter a FIFO
 * wait queue (up to {@link maxQueueSize} entries). As running sub-agents
 * complete, queued entries are automatically promoted. A queued or running
 * run can be individually cancelled via {@link cancel}.
 */
export class SubAgentManager {
  private logger: Logger = new ConsoleLogger();

  /** Set the logger instance (called by the owning agent). */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Registered definitions keyed by name. */
  private definitions: Map<string, SubAgentDefinition> = new Map();

  /** Currently running sub-agents. */
  private pending: PendingRun[] = [];

  /**
   * Wait queue — spawns that couldn't get a slot immediately.
   * FIFO order; oldest entry is promoted first when a slot frees up.
   */
  private waitQueue: QueuedRun[] = [];

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

  /** Maximum concurrent sub-agent runs. Default: 3. */
  private maxPending: number = 3;

  /** Maximum wait queue length. Default: 20. Prevents runaway spawns. */
  private maxQueueSize: number = 20;

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

  /**
   * Human-in-the-loop approval callback, inherited from the main agent.
   * Passed to every sub-agent so tools like `bash` / `write_file` that
   * require approval don't get auto-denied.
   */
  private onToolApproval?: ApprovalCallback;

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
    maxPending?: number,
    maxQueueSize?: number,
    onToolApproval?: ApprovalCallback,
  ): void {
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    this.skillsDir = skillsDir;
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
    this.defaultFilter = defaultFilter;
    this.subAgentLLM = subAgentLLM;
    this.subAgentHooks = subAgentHooks;
    if (maxPending !== undefined) this.maxPending = maxPending;
    if (maxQueueSize !== undefined) this.maxQueueSize = maxQueueSize;
    this.onToolApproval = onToolApproval;
  }

  // ─── Spawn ────────────────────────────────────────────────────────────────

  /**
   * Spawn a sub-agent by definition name. Returns immediately with a run ID.
   *
   * If a running slot is available (`pending.length < maxPending`) the
   * sub-agent starts immediately. Otherwise it enters a FIFO wait queue;
   * it will be started automatically when a slot frees up.
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
   * @throws If the definition is unknown, the manager is not yet bound, or
   *         the wait queue is full.
   */
  spawn(name: string, input: string, options?: { workdir?: string }): string {
    const definition = this.definitions.get(name);
    if (!definition) {
      const available = Array.from(this.definitions.keys()).join(", ") || "none";
      throw new Error(
        `Unknown sub-agent: "${name}". Available: ${available}`,
      );
    }

    if (!this.llmProvider || !this.toolRegistry || !this.skillManager) {
      throw new Error(
        "SubAgentManager is not bound to an LLM provider / ToolRegistry / SkillManager. " +
        "Call bind() before spawn().",
      );
    }

    // Guard against runaway spawns — if the wait queue is full the LLM
    // must wait for running sub-agents to complete before spawning more.
    if (this.waitQueue.length >= this.maxQueueSize) {
      throw new Error(
        `Sub-agent queue full (${this.maxQueueSize}). ` +
        `Wait for running sub-agents to complete before spawning another.`,
      );
    }

    const runId = `${name}_${++this.runIdCounter}_${Date.now()}`;

    const queued: QueuedRun = {
      subAgentId: runId,
      name,
      definition,
      input,
      createdAt: Date.now(),
      options,
      abortController: new AbortController(),
    };

    // Start immediately if a slot is available; otherwise enqueue.
    if (this.pending.length < this.maxPending) {
      this.dequeue(queued);
    } else {
      this.waitQueue.push(queued);
      this.logger.info(
        "SubAgent",
        `"${name}" queued (run: ${runId}), ${this.waitQueue.length} ahead.`,
      );
    }

    return runId;
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────

  /**
   * Cancel a single sub-agent run by its run ID.
   *
   * - **Queued** (not yet started): removed from the wait queue immediately.
   * - **Running**: the agent's in-flight LLM request is aborted and its
   *   ReAct loop terminates. The cancelled result will appear in the next
   *   `pollCompleted()` call.
   * - **Already completed / errored**: returns `{cancelled: false}` —
   *   results were already delivered.
   *
   * @param runId The run ID returned by {@link spawn}.
   * @returns A {@link CancelResult} indicating success / failure reason.
   */
  cancel(runId: string): CancelResult {
    // ── 1. Check wait queue ───────────────────────────────────────────
    const qIdx = this.waitQueue.findIndex((q) => q.subAgentId === runId);
    if (qIdx !== -1) {
      const [removed] = this.waitQueue.splice(qIdx, 1);
      removed.abortController.abort(); // clean up any listener
      this.logger.info("SubAgent", `Cancelled queued run "${runId}".`);
      return { cancelled: true, wasRunning: false };
    }

    // ── 2. Check running ──────────────────────────────────────────────
    const pending = this.pending.find((r) => r.subAgentId === runId);
    if (!pending) {
      return { cancelled: false, reason: "not_found" };
    }

    if (pending.resolved !== null) {
      return { cancelled: false, reason: "already_completed" };
    }

    // Actually stop the agent
    pending.status = "cancelled";
    pending.cancelled = true;
    pending.agent?.cancel();

    this.logger.info("SubAgent", `Cancelled running "${runId}".`);
    return { cancelled: true, wasRunning: true };
  }

  /**
   * Synchronously discard ALL sub-agent state.
   *
   * Unlike {@link cancelAll} (which preserves results for later recovery),
   * this method is a hard reset: queued items are removed, running agents
   * are aborted, and all pending entries are discarded without waiting
   * for promises to settle.
   *
   * Call this in {@code reset()} when the owning agent wants a clean slate
   * and orphaned results from a previous session must not leak into the
   * next run.
   */
  clear(): void {
    for (const q of this.waitQueue) {
      q.abortController.abort();
    }
    this.waitQueue = [];

    for (const run of this.pending) {
      run.agent?.cancel();
    }
    this.pending = [];

    this.logger.info("SubAgent", "All sub-agent state cleared.");
  }

  /**
   * Cancel all pending and queued sub-agents.
   *
   * - Wait queue entries are discarded (they never started).
   * - Running sub-agents are marked as cancelled and their LLM calls are
   *   aborted. Their promises stay alive — completed results can be
   *   recovered later via {@link collectOrphanedResults}.
   */
  cancelAll(): void {
    // Discard queued items — they never started, no recovery needed
    if (this.waitQueue.length > 0) {
      this.logger.info(
        "SubAgent",
        `Discarding ${this.waitQueue.length} queued run(s).`,
      );
      for (const q of this.waitQueue) {
        q.abortController.abort();
      }
      this.waitQueue = [];
    }

    // Cancel running ones (results preserved for recovery)
    let marked = 0;
    for (const run of this.pending) {
      if (!run.cancelled && run.resolved === null) {
        run.status = "cancelled";
        run.cancelled = true;
        run.agent?.cancel();
        marked++;
      }
    }
    if (marked > 0) {
      this.logger.info(
        "SubAgent",
        `Cancelled ${marked} running sub-agent(s) (results preserved).`,
      );
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

  // ─── Poll ─────────────────────────────────────────────────────────────────

  /**
   * Wait up to `timeoutMs` for at least one pending sub-agent to complete.
   *
   * Unlike {@link pollCompleted} (which blocks indefinitely), this method
   * races all unresolved promises against a timeout. If a sub-agent finishes
   * within the window its result is collected and returned so the LLM sees
   * it in the same ReAct iteration — saving a full round-trip.
   *
   * Results that don't finish in time stay in `this.pending` and will be
   * picked up by the next {@link pollCompleted} call.
   *
   * Freed slots are filled from the wait queue (FIFO).
   *
   * @param timeoutMs Max milliseconds to wait (default: 30_000).
   * @returns Completed sub-agent results (empty if none finished in time).
   */
  async collectFastResults(timeoutMs: number = 30_000): Promise<SubAgentResult[]> {
    const alive = this.pending.filter((r) => r.resolved === null);
    if (alive.length === 0) return [];

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race: first completed result vs. timeout
      const winner = await Promise.race([
        ...alive.map((r) => r.promise),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);

      if (typeof winner === "object" && winner !== null && "subAgentId" in winner) {
        // At least one resolved — quick yield so other recently-completed
        // runs (within the same microtick window) also surface.
        await new Promise((r) => setImmediate(r));
      } else {
        // Timeout or unexpected winner — no results.
        return [];
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    // Collect resolved, fill freed slots from queue
    const results: SubAgentResult[] = [];
    const stillPending: PendingRun[] = [];

    for (const run of this.pending) {
      if (run.resolved !== null) {
        results.push(run.resolved);
        this.logger.info(
          "SubAgent",
          `Fast result: "${run.name}" (run: ${run.subAgentId}) completed in ${run.resolved.durationMs}ms.`,
        );
      } else {
        stillPending.push(run);
      }
    }

    this.pending = stillPending;

    while (this.pending.length < this.maxPending && this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      this.dequeue(next);
    }

    return results;
  }

  /**
   * Check all pending sub-agent runs for completion.
   *
   * Call this at the start of each ReAct iteration. Completed results
   * are removed from the pending queue and returned; still-running
   * entries remain queued.
   *
   * After collecting results, any freed slots are filled from the wait
   * queue (FIFO order).
   *
   * @returns Array of completed sub-agent results (empty if none finished).
   */
  async pollCompleted(): Promise<SubAgentResult[]> {
    if (this.pending.length === 0 && this.waitQueue.length === 0) return [];

    // Block until at least one pending sub-agent completes.
    // This prevents the main agent from spinning the LLM loop while
    // waiting for async sub-agent results — no wasted iterations.
    if (this.pending.length > 0) {
      await Promise.race(
        this.pending.map((r) => r.promise),
      );
      // Quick yield so any other recently-completed runs also surface
      await new Promise((r) => setImmediate(r));
    }

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

    // ── Fill freed slots from wait queue ───────────────────────────────
    while (this.pending.length < this.maxPending && this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      this.dequeue(next);
    }

    return results;
  }

  /**
   * Wait for all pending sub-agents to complete.
   *
   * Queued (not-yet-started) items are discarded — this is called during
   * shutdown, so there is no consumer left to poll for their results.
   * Useful for graceful shutdown.
   */
  async awaitAll(): Promise<SubAgentResult[]> {
    if (this.waitQueue.length > 0) {
      this.logger.warn(
        "SubAgent",
        `Closing — discarding ${this.waitQueue.length} queued run(s).`,
      );
      for (const q of this.waitQueue) {
        q.abortController.abort();
      }
      this.waitQueue = [];
    }

    const results = await Promise.all(this.pending.map((r) => r.promise));
    this.pending = [];
    return results;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Whether any sub-agent is running or queued. */
  hasRunning(): boolean {
    return this.pending.length > 0 || this.waitQueue.length > 0;
  }

  /** Number of currently running sub-agents (excludes queued). */
  getActiveCount(): number {
    return this.pending.length;
  }

  /** Number of runs waiting in the queue. */
  getQueueLength(): number {
    return this.waitQueue.length;
  }

  getDefinitions(): SubAgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Build a formatted list of all registered sub-agents with their
   * capabilities (used by the orchestrator and the system-prompt hint).
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

  /**
   * Build a compact hint listing available sub-agents (name + description only).
   * Injected directly into the system prompt so the LLM discovers available
   * sub-agents without calling a tool — same pattern as skills' hint.
   */
  buildSubAgentHint(): string {
    if (this.definitions.size === 0) return "";
    const lines: string[] = [];
    for (const def of this.definitions.values()) {
      lines.push(`- **${def.name}**: ${def.description}`);
    }
    return (
      `Available sub-agents (use \`spawn_subagent\` with the name to delegate):\n` +
      lines.join("\n")
    );
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Promote a queued run to a running slot — create the PendingRun,
   * kick off execution, and push onto `this.pending`.
   */
  private dequeue(item: QueuedRun): void {
    const pending: PendingRun = {
      subAgentId: item.subAgentId,
      name: item.name,
      startedAt: Date.now(),
      status: "running",
      resolved: null,
      promise: Promise.resolve(undefined as unknown as SubAgentResult),
    };

    pending.promise = this.executeRun(
      item.name,
      item.subAgentId,
      item.definition,
      item.input,
      pending.startedAt,
      item.options,
    )
      .then((r) => {
        pending.status = r.success ? "completed" : "error";
        pending.resolved = r;
        return r;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        pending.status = "error";
        const fallback: SubAgentResult = {
          subAgentId: item.subAgentId,
          name: item.name,
          success: false,
          output: this.wrapXml(
            item.name,
            item.subAgentId,
            false,
            message,
            Date.now() - pending.startedAt,
          ),
          durationMs: Date.now() - pending.startedAt,
        };
        pending.resolved = fallback;
        return fallback;
      });

    this.pending.push(pending);

    const slotInfo =
      this.waitQueue.length > 0
        ? ` (${this.waitQueue.length} still queued)`
        : "";
    this.logger.info(
      "SubAgent",
      `Started "${item.name}" (run: ${item.subAgentId})${slotInfo}.`,
    );
  }

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

    // Store the agent reference on the PendingRun so cancel(runId) can
    // call agent.cancel() to abort the in-flight LLM request + ReAct loop.
    // Guard: if cancel() was called during buildSubAgent (the window between
    // dequeue and here), cancel the agent now so it stops immediately instead
    // of running to completion.
    const pending = this.pending.find((r) => r.subAgentId === runId);
    if (pending) {
      pending.agent = agent;
      if (pending.cancelled) {
        agent.cancel();
      }
    }

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
      const allTools2 = this.toolRegistry!.getTools();
      for (const toolName of namesOnly) {
        const tool = allTools2.find((t) => t.name === toolName);
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
      maxIterations: 100,
      // Prevent infinite recursion: sub-agents should NOT auto-register
      // sub-agents from the project directory.
      // "" explicitly disables the default (undefined would be overridden
      // by the ?? "./subagents/" fallback in the Agent constructor).
      subAgentsDir: "",
      // Sub-agents execute a specific delegated task — they do not need
      // intent detection (wantsRemember, riskLevel, scenarios, complexity),
      // skill auto-activation (skills are pre-declared in the definition),
      // or side-effect tools (remember, recall, skill).
      skipAutoTools: true,
      workdir,
      // Inherit the main agent's approval callback so tools like bash /
      // write_file don't get auto-denied in sub-agents.
      onToolApproval: this.onToolApproval,
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
