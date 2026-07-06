import { Agent, AgentConfig } from "../core/agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse } from "../llm/interface";
import { wrapAndScan } from "../security/boundaries";
import { SessionState, SessionStatus } from "../session/session-types";
import type { SubAgentManager } from "../subagent/subagent-manager";
import { GitWorktreeManager } from "../git/git-worktree-manager";

import type {
  TaskNode,
  TaskGraph,
  OrchestrationPlan,
  SynthesisResult,
  AdaptResult,
  OrchestratorSessionState,
  FailureStrategy,
} from "./orchestrator-types";

import {
  parseDecomposeResponse,
  parseSynthesizeResponse,
  parseAdaptResponse,
  buildDecomposePrompt,
  buildSynthesizePrompt,
  buildAdaptPrompt,
} from "./orchestrator-response";
import { extractJSON } from "./json-extractor";

// ─── System Prompt ────────────────────────────────────────────────────────

const DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT = `You are a helpful AI assistant powered by the Orchestrator paradigm.
You do NOT execute tasks yourself. Instead, you decompose complex requests into
sub-tasks, delegate them to specialised sub-agents, synthesise their results,
and adapt your plan when gaps are found.

You have access to tools for discovering and spawning sub-agents.`;

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * Configuration for the OrchestratorAgent.
 */
export interface OrchestratorAgentConfig extends AgentConfig {
  /**
   * Maximum orchestration rounds (Decompose + N × Dispatch-Synthesize-Adapt).
   * Each round dispatches a batch of ready nodes, synthesises results, and
   * optionally generates new nodes for the next round.
   *
   * Default: 3.
   */
  maxRounds?: number;

  /**
   * Maximum number of task nodes that can run in parallel during dispatch.
   * Default: 5.
   */
  maxParallelNodes?: number;

  /**
   * Maximum total task nodes across all rounds before the orchestrator
   * forces synthesis. Prevents unbounded task graph growth.
   * Default: 20.
   */
  maxTotalNodes?: number;

  /**
   * Maximum number of retry attempts per failed node before giving up.
   * Each retry re-executes the sub-agent from scratch.
   * Default: 2.
   */
  maxRetriesPerNode?: number;

  /**
   * Failure handling strategy when a task node fails during dispatch.
   *
   * - `"retry-subtree"`: Retry the failed node and invalidate all
   *   downstream dependents so they re-execute with fresh input.
   *   This is the default — maximises correctness without redundant work.
   * - `"retry-all"`: Reset every node in the DAG and restart from scratch.
   * - `"continue"`: Mark the node as failed but let downstream nodes
   *   proceed with error information injected (current behaviour).
   *
   * Default: "retry-subtree".
   */
  failureStrategy?: FailureStrategy;

  // ── Git Worktree Isolation ────────────────────────────────────────────

  /**
   * Whether to create isolated git worktrees for each sub-agent task node.
   *
   * When true, each dispatched node gets its own git worktree so sub-agents
   * can make file changes in isolation.  Results are merged back when the
   * node completes (if `autoMergeWorktrees` is set).
   *
   * Requires `worktreeRepoPath` to be set.
   * Default: false.
   */
  enableWorktrees?: boolean;

  /**
   * Path to the git repository root for worktree creation.
   * Required when `enableWorktrees` is true.
   */
  worktreeRepoPath?: string;

  /**
   * Parent directory for worktrees.
   * Default: `<worktreeRepoPath>/.kagent-worktrees/`
   */
  worktreesDir?: string;

  /**
   * Worktree branch prefix.
   * Default: "kagent"
   */
  worktreeBranchPrefix?: string;

  /**
   * Merge worktree branches back on node completion and clean up
   * the worktree.  When false, worktrees and their branches persist
   * for manual review.
   * Default: false.
   */
  autoMergeWorktrees?: boolean;

  /**
   * Clean up (force-remove) all remaining worktrees when the
   * orchestration session completes or is cancelled.
   * Default: true.
   */
  autoCleanupWorktrees?: boolean;
}

// ─── OrchestratorAgent ────────────────────────────────────────────────────

/**
 * Orchestrator Agent that decomposes user requests into a DAG of sub-tasks,
 * dispatches them to sub-agents, synthesises results, and adapts the plan
 * based on what is learned.
 *
 * ## Execution flow:
 * ```
 * User Input
 *   ↓
 * [1. Decompose]  LLM analyses request → TaskGraph (DAG of sub-agent tasks)
 *   ↓
 * ┌─ Loop (up to maxRounds rounds) ─────────────────────────────┐
 * │                                                              │
 * │ [2. Dispatch]  Topological execution of ready nodes           │
 * │     - Nodes with no pending deps are spawned in parallel      │
 * │     - Parent waits for all ready nodes to complete            │
 * │     - Results are injected into context                       │
 * │                                                              │
 * │ [3. Synthesize]  LLM reviews all results → isComplete?       │
 * │     ├─ YES → return finalAnswer                              │
 * │     └─ NO  → produce gaps list                               │
 * │                                                              │
 * │ [4. Adapt]  LLM turns gaps into new TaskNodes                │
 * │     - New nodes appended to task graph                        │
 * │     - Loop back to Dispatch                                   │
 * │                                                              │
 * └──────────────────────────────────────────────────────────────┘
 *   ↓
 * Final Answer
 * ```
 *
 * ## Session persistence
 * When `enableCheckpointing` is set, the agent saves the full task graph
 * state so orchestration can resume after interruption.
 */
export class OrchestratorAgent extends Agent {
  // ── Configuration ───────────────────────────────────────────────────

  private maxRounds: number;
  private maxParallelNodes: number;
  private maxTotalNodes: number;

  // ── Retry config ─────────────────────────────────────────────────────

  private maxRetriesPerNode: number;
  private failureStrategy: FailureStrategy;

  // ── Worktree config ─────────────────────────────────────────────────

  private enableWorktrees: boolean;
  private worktreeRepoPath?: string;
  private worktreesDir?: string;
  private worktreeBranchPrefix: string;
  private autoMergeWorktrees: boolean;
  private autoCleanupWorktrees: boolean;

  // ── Runtime state ───────────────────────────────────────────────────

  /** The current task graph. */
  private taskGraph: TaskGraph = { nodes: [] };

  /** How many dispatch rounds have been completed. */
  private completedRounds = 0;

  /** Internal flag: when true, run() skips state reset (used by resume()). */
  private _skipStateReset = false;

  /**
   * Accumulated degradation events from fallback LLM calls during this run.
   * Injected into synthesis prompts so the LLM can factor model quality
   * into its completeness decisions.
   */
  private fallbackEvents: string[] = [];

  /** Git worktree manager (created in init() when enableWorktrees is true). */
  private worktreeManager?: GitWorktreeManager;

  constructor(config: OrchestratorAgentConfig) {
    const mergedConfig: OrchestratorAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxRounds = config.maxRounds ?? 3;
    this.maxParallelNodes = config.maxParallelNodes ?? 5;
    this.maxTotalNodes = config.maxTotalNodes ?? 20;

    this.maxRetriesPerNode = config.maxRetriesPerNode ?? 2;
    this.failureStrategy = config.failureStrategy ?? "retry-subtree";

    this.enableWorktrees = config.enableWorktrees ?? false;
    this.worktreeRepoPath = config.worktreeRepoPath;
    this.worktreesDir = config.worktreesDir;
    this.worktreeBranchPrefix = config.worktreeBranchPrefix ?? "kagent";
    this.autoMergeWorktrees = config.autoMergeWorktrees ?? false;
    this.autoCleanupWorktrees = config.autoCleanupWorktrees ?? true;

    this.rebuildSystemPrompt();
  }

  /**
   * Return the SubAgentManager, throwing a clear error if sub-agents were
   * not configured. The Orchestrator cannot function without sub-agents.
   */
  private getSubAgentManager(): SubAgentManager {
    if (!this.subAgentManager) {
      throw new Error(
        "OrchestratorAgent requires sub-agents to be configured. " +
        "Set `subAgentsDir` in OrchestratorAgentConfig with at least one AGENT.md definition.",
      );
    }
    if (!this.subAgentManager.hasDefinitions()) {
      throw new Error(
        "OrchestratorAgent requires at least one sub-agent definition. " +
        `No definitions found in "${this.subAgentsDir}". Add AGENT.md files to register sub-agents.`,
      );
    }
    return this.subAgentManager;
  }

  // ─── Main Entry Point ───────────────────────────────────────────────

  async run(input: string): Promise<string> {
    const skipStateReset = this._skipStateReset;
    this._skipStateReset = false;

    // ── Pre-flight ────────────────────────────────────────────────────
    const sizeError = this.validateInputSize(input);
    if (sizeError) return sizeError;

    this._abortController = new AbortController();

    await this.init();
    await this.reloadDynamicResources();
    this.recoverOrphanedSubAgentResults();

    // Validate that sub-agents are available — the Orchestrator cannot function without them.
    try {
      this.getSubAgentManager();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Orchestrator", message);
      return message;
    }

    // Initialise worktree manager if enabled (lazy — survives resume).
    if (this.enableWorktrees && this.worktreeRepoPath && !this.worktreeManager) {
      try {
        this.worktreeManager = new GitWorktreeManager({
          repoPath: this.worktreeRepoPath,
          worktreesDir: this.worktreesDir,
          branchPrefix: this.worktreeBranchPrefix,
          logger: this.logger,
          autoCleanup: this.autoCleanupWorktrees,
        });
        this.logger.info("Orchestrator", "Git worktree isolation enabled.");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error("Orchestrator", `Failed to start worktree manager: ${message}`);
        return message;
      }
    }

    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    if (!skipStateReset) {
      this.taskGraph = { nodes: [] };
      this.completedRounds = 0;
      this.fallbackEvents = [];
    }

    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // ── Phase 1: Decompose ─────────────────────────────────────────────
    // On resume (skipStateReset + graph already loaded), skip decomposition.
    if (!skipStateReset || this.taskGraph.nodes.length === 0) {
      const plan = await this.decompose(input);
      this.taskGraph = plan.taskGraph;
      this.setNodeRetryConfig(this.taskGraph.nodes);
      this.detectAndBreakCycles();

      if (this.taskGraph.nodes.length === 0) {
        const fallback =
          "I was unable to decompose this task into sub-agent actions. " +
          "Please try rephrasing your request with more specific goals.";
        for (const h of this.hooks) h.onFinish?.(fallback);
        return fallback;
      }

      // Fire onPlanCreated so traces capture the decomposition DAG
      const planSteps = this.taskGraph.nodes.map(
        (n) => `[${n.id}] ${n.subAgentName}: ${n.description}`,
      );
      for (const h of this.hooks) h.onPlanCreated?.(planSteps);

      this.logger.info("Orchestrator", `Decomposed into ${this.taskGraph.nodes.length} node(s).`);
      for (const n of this.taskGraph.nodes) {
        const depStr = n.dependsOn.length > 0
          ? ` (deps: ${n.dependsOn.join(", ")})`
          : "";
        this.logger.info("Orchestrator", `  [${n.id}] → ${n.subAgentName}${depStr}`);
      }
    } else {
      this.logger.info("Orchestrator", `Resuming with ${this.taskGraph.nodes.length} node(s) from session.`);
    }

    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // ── Phase 2-4: Orchestration Loop ──────────────────────────────────
    for (let round = 0; round < this.maxRounds; round++) {
      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        if (this.autoCleanupWorktrees) {
          await this.worktreeManager?.cleanup();
        }
        const sid = this.sessionManager?.getSessionId() ?? "unknown";
        const cancelMsg =
          `Execution cancelled by user. Session "${sid}" preserved — ` +
          `resume with agent.resume("${sid}", "<your prompt>").`;
        for (const h of this.hooks) h.onFinish?.(cancelMsg);
        return cancelMsg;
      }

      // Dispatch: execute all ready nodes (topological wave)
      await this.dispatchReadyNodes();

      // Synthesize: review all completed results
      const synthesis = await this.synthesize(input);
      this.completedRounds++;

      if (this.checkpointingEnabled) {
        this.saveCheckpoint("active");
      }

      // Check if complete
      if (synthesis.isComplete && synthesis.finalAnswer) {
        this.logger.info("Orchestrator", "Task complete — returning final answer.");
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(synthesis.finalAnswer);
        return synthesis.finalAnswer;
      }

      // Check if this was the last round
      if (round === this.maxRounds - 1) {
        this.logger.info("Orchestrator", `Max rounds (${this.maxRounds}) reached — forcing synthesis.`);
        const forced = await this.forceSynthesize(input);
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(forced);
        return forced;
      }

      // Check total node limit
      if (this.taskGraph.nodes.length >= this.maxTotalNodes) {
        this.logger.info("Orchestrator", `Max total nodes (${this.maxTotalNodes}) reached — forcing synthesis.`);
        const forced = await this.forceSynthesize(input);
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(forced);
        return forced;
      }

      // Adapt: generate new nodes for gaps
      const gaps = synthesis.gaps ?? [];
      if (gaps.length === 0) {
        // No gaps but not complete — force synthesis
        this.logger.info("Orchestrator", "Synthesis incomplete but no gaps listed — forcing synthesis.");
        const forced = await this.forceSynthesize(input);
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(forced);
        return forced;
      }

      const adaptResult = await this.adapt(gaps);

      if (adaptResult.stuck || adaptResult.newNodes.length === 0) {
        this.logger.info("Orchestrator", "Adapt phase stuck — forcing synthesis.");
        const forced = await this.forceSynthesize(input);
        if (this.checkpointingEnabled) {
          this.saveCheckpoint("completed");
        }
        for (const h of this.hooks) h.onFinish?.(forced);
        return forced;
      }

      // Append new nodes to the graph
      this.taskGraph.nodes.push(...adaptResult.newNodes);
      this.setNodeRetryConfig(adaptResult.newNodes);
      this.detectAndBreakCycles();
      this.logger.info("Orchestrator", `Round ${this.completedRounds + 1}: ${adaptResult.newNodes.length} new node(s) added.`);

      // Fire onPlanRevised so traces capture the updated DAG
      const revisedSteps = this.taskGraph.nodes.map(
        (n) => `[${n.id}] ${n.subAgentName}: ${n.description} (${n.status})`,
      );
      for (const h of this.hooks) h.onPlanRevised?.(revisedSteps);

      if (this.checkpointingEnabled) {
        this.saveCheckpoint("active");
      }
    }

    // Should not reach here — caught by last-round check above
    const forced = await this.forceSynthesize(input);
    for (const h of this.hooks) h.onFinish?.(forced);
    return forced;
  }

  // ─── Degradation Tracking ───────────────────────────────────────────

  /**
   * Record a fallback event if the LLM response came from a non-primary model.
   * Called after every LLM phase (decompose, synthesize, adapt, force-synthesize).
   */
  private trackFallback(phase: string, response: LLMResponse): void {
    if (response.providerMeta?.isFallback) {
      const event = `[${phase}] ran on fallback model "${response.providerMeta.model}"`;
      this.fallbackEvents.push(event);
      this.logger.warn("Orchestrator", event);
    }
  }

  /**
   * Build a degradation notice for injection into synthesis / force-synthesize
   * prompts. Returns an empty string if no fallback events occurred.
   */
  private buildFallbackNotice(): string {
    if (this.fallbackEvents.length === 0) return "";
    return [
      "",
      "=== Model Degradation Notice ===",
      "Some phases of this orchestration ran on a fallback (weaker) model:",
      ...this.fallbackEvents.map((e) => `  - ${e}`),
      "Results from these phases may be less reliable. Please be more",
      "skeptical when evaluating completeness and quality. If results seem",
      "insufficient, prefer requesting additional work rather than accepting",
      "low-quality output.",
      "",
    ].join("\n");
  }

  // ─── DAG Validation ──────────────────────────────────────────────────

  /**
   * Detect cycles in the current task graph using Kahn's algorithm
   * (topological sort via BFS).
   *
   * If a cycle is found, it is broken by removing the dependency edges
   * between nodes that remain in the cycle after processing all acyclic
   * nodes.  This allows the DAG to execute even when the LLM accidentally
   * produces a circular dependency.
   *
   * @returns The IDs of nodes that were part of a cycle, or `null` if
   *          the graph is acyclic.
   */
  private detectAndBreakCycles(): string[] | null {
    const nodeIds = new Set(this.taskGraph.nodes.map((n) => n.id));

    // Build in-degree map and adjacency list
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const n of this.taskGraph.nodes) {
      // Only count dependencies that reference real node IDs
      const realDeps = n.dependsOn.filter((d) => nodeIds.has(d));
      inDegree.set(n.id, realDeps.length);
      adjacency.set(n.id, []);
    }
    for (const n of this.taskGraph.nodes) {
      for (const dep of n.dependsOn) {
        if (nodeIds.has(dep)) {
          adjacency.get(dep)?.push(n.id);
        }
      }
    }

    // Kahn's algorithm: start with all in-degree-0 nodes
    const queue = [...inDegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => id);

    const sorted: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(id);
      for (const child of adjacency.get(id) ?? []) {
        const d = inDegree.get(child)! - 1;
        inDegree.set(child, d);
        if (d === 0) queue.push(child);
      }
    }

    // Nodes still with in-degree > 0 are in a cycle
    const cycleIds = [...inDegree.entries()]
      .filter(([, d]) => d > 0)
      .map(([id]) => id);

    if (cycleIds.length === 0) return null;

    // Break cycles: for each node in a cycle, remove dependsOn edges
    // that point to another node also in the cycle.
    const cycleSet = new Set(cycleIds);
    let brokenEdges = 0;
    for (const n of this.taskGraph.nodes) {
      if (!cycleSet.has(n.id)) continue;
      const before = n.dependsOn.length;
      (n as { dependsOn: string[] }).dependsOn = n.dependsOn.filter(
        (dep) => !cycleSet.has(dep),
      );
      brokenEdges += before - n.dependsOn.length;
    }

    this.logger.warn(
      "Orchestrator",
      `Cycle detected involving nodes: ${cycleIds.join(", ")}. ` +
      `Broke ${brokenEdges} circular edge(s) to restore acyclic DAG.`,
    );

    return cycleIds;
  }

  // ─── Retry Helpers ────────────────────────────────────────────────────

  /**
   * Set maxRetries on newly created nodes from the orchestrator config.
   * Called after decompose and adapt produce fresh nodes.
   */
  private setNodeRetryConfig(nodes: TaskNode[]): void {
    for (const node of nodes) {
      node.maxRetries = this.maxRetriesPerNode;
    }
  }

  /**
   * Find all nodes that directly or transitively depend on `nodeId`.
   * Uses BFS traversal; returns nodes in topological order (closest first).
   */
  private getDependents(nodeId: string): TaskNode[] {
    const result: TaskNode[] = [];
    const visited = new Set<string>();
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = this.taskGraph.nodes.filter(
        (n) => n.dependsOn.includes(current) && !visited.has(n.id),
      );
      for (const child of children) {
        visited.add(child.id);
        result.push(child);
        queue.push(child.id);
      }
    }

    return result;
  }

  /**
   * Reset a node's runtime state to "pending" for re-execution.
   * Clears result, timing, and worktree info so the node dispatches
   * as if it were newly created.
   */
  private resetNodeForRetry(node: TaskNode): void {
    node.status = "pending";
    node.result = undefined;
    node.runId = undefined;
    node.startedAt = undefined;
    node.durationMs = undefined;
    node.worktreeId = undefined;
  }

  /**
   * Invalidate all nodes that depend on `nodeId` (directly or transitively).
   * Only resets nodes that have already been dispatched (completed, failed,
   * or running) — pending nodes were never executed and don't need reset.
   */
  private invalidateDependents(nodeId: string): void {
    const dependents = this.getDependents(nodeId);
    const invalidatedIds: string[] = [];

    for (const dep of dependents) {
      if (
        dep.status === "completed" ||
        dep.status === "failed" ||
        dep.status === "running"
      ) {
        this.resetNodeForRetry(dep);
        invalidatedIds.push(dep.id);
      }
    }

    if (invalidatedIds.length > 0) {
      this.logger.info(
        "Orchestrator",
        `Invalidated ${invalidatedIds.length} dependent node(s) of [${nodeId}]: ${invalidatedIds.join(", ")}`,
      );
    }
  }

  /**
   * After a dispatch wave completes, check all nodes that just finished.
   * Apply the configured failure strategy to any failed nodes.
   *
   * @returns true if any retries were triggered (meaning another dispatch
   *          wave is needed).
   */
  private handleFailedNodes(justCompleted: TaskNode[]): boolean {
    let retried = false;

    for (const node of justCompleted) {
      if (node.status !== "failed") continue;

      // Check if retries remain
      const max = node.maxRetries ?? this.maxRetriesPerNode;
      if (node.retryCount >= max) {
        this.logger.info(
          "Orchestrator",
          `[${node.id}] Retries exhausted (${node.retryCount}/${max}) — giving up.`,
        );
        continue;
      }

      node.retryCount++;
      this.logger.info(
        "Orchestrator",
        `[${node.id}] Retry ${node.retryCount}/${max} — strategy: ${this.failureStrategy}`,
      );

      switch (this.failureStrategy) {
        case "retry-subtree": {
          this.resetNodeForRetry(node);
          this.invalidateDependents(node.id);
          retried = true;
          break;
        }
        case "retry-all": {
          for (const n of this.taskGraph.nodes) {
            this.resetNodeForRetry(n);
          }
          this.logger.info(
            "Orchestrator",
            "All nodes reset for full DAG retry.",
          );
          return true;
        }
        case "continue":
        default: {
          // No retry — leave as failed. Downstream proceeds with error info.
          break;
        }
      }
    }

    return retried;
  }

  // ─── Phase 1: Decompose ──────────────────────────────────────────────

  /**
   * Ask the LLM to decompose the user's request into a TaskGraph.
   *
   * Sends a dedicated prompt with the list of available sub-agents so the
   * LLM knows what it can delegate to.
   */
  private async decompose(input: string): Promise<OrchestrationPlan> {
    const availableSubAgents = this.getSubAgentManager().buildSubAgentList();

    const messages = [
      { role: Role.System, content: buildDecomposePrompt(availableSubAgents) },
      { role: Role.User, content: input },
    ];

    for (const h of this.hooks) h.onLLMStart?.(messages, []);

    let response: LLMResponse;
    try {
      response = await this.llm.chat(
        messages,
        [],
        this._abortController?.signal,
      );
    } catch (err: unknown) {
      if (this.isCancelled) {
        this.saveCheckpoint("cancelled");
        const cancelMsg =
          `Execution cancelled by user. Session "${this.sessionManager?.getSessionId() ?? "unknown"}" preserved.`;
        for (const h of this.hooks) h.onFinish?.(cancelMsg);
        return { thought: "Cancelled.", taskGraph: { nodes: [] } };
      }
      if (err instanceof LLMNetworkError) {
        for (const h of this.hooks) h.onLLMError?.(err);
        const recovered = await this.handleNetworkError(err, 0, "continue creating a decomposition plan");
        // If recovery returned a string, wrap it
        if (typeof recovered === "string") {
          return { thought: recovered, taskGraph: { nodes: [] } };
        }
      }
      throw err;
    }

    for (const h of this.hooks) h.onLLMEnd?.(response);

    this.trackFallback("Decompose", response);

    if (response.usage) {
      this.tokenBudget?.recordUsage(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      );
    }

    const parsed = parseDecomposeResponse(response.content);

    // Validate nodes: ensure every dependsOn references a real node ID
    const nodeIds = new Set(parsed.taskGraph.nodes.map((n) => n.id));
    for (const node of parsed.taskGraph.nodes) {
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) {
          this.logger.warn("Orchestrator", `Node "${node.id}" depends on unknown node "${dep}" — removing dependency.`);
        }
      }
      // Filter out unknown dependencies
      (node as { dependsOn: string[] }).dependsOn = node.dependsOn.filter((d) => nodeIds.has(d));
    }

    if (parsed.thought) {
      this.logger.info("Orchestrator", `Decompose: ${parsed.thought}`);
      for (const h of this.hooks) h.onThought?.(parsed.thought);
    }

    return parsed;
  }

  // ─── Phase 2: Dispatch ────────────────────────────────────────────────

  /**
   * Execute all ready nodes in the task graph using topological wave-front
   * dispatch. Nodes with no pending dependencies run in parallel (up to
   * `maxParallelNodes`), then their dependants become ready.
   *
   * This method blocks until all currently ready (and transitively ready)
   * nodes have completed.
   */
  private async dispatchReadyNodes(): Promise<void> {
    // Keep dispatching waves until no more nodes can make progress
    let progress = true;
    while (progress) {
      progress = false;

      // Find nodes that are ready to run
      const readyNodes = this.getReadyNodes();
      if (readyNodes.length === 0) break;

      progress = true;

      // Spawn in parallel, respecting maxParallelNodes
      this.logger.info("Orchestrator", `Dispatching ${readyNodes.length} ready node(s).`);
      for (const node of readyNodes) {
        node.status = "running";
        node.startedAt = Date.now();

        // ── Create isolated worktree (if enabled) ─────────────────────
        let workdir: string | undefined;
        if (this.worktreeManager) {
          try {
            const wt = await this.worktreeManager.createWorktree({
              nodeId: node.id,
              baseRef: node.worktreeBaseRef,
            });
            node.worktreeId = wt.id;
            workdir = wt.path;
            this.logger.info(
              "Orchestrator",
              `  Worktree "${wt.id}" created for [${node.id}] at ${wt.path}`,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Orchestrator", `  Failed to create worktree for [${node.id}]: ${message}`);
            node.status = "failed";
            node.result = {
              subAgentId: `error_${node.id}`,
              name: node.subAgentName,
              success: false,
              output: `Failed to create isolated worktree: ${message}`,
              durationMs: 0,
            };
            node.durationMs = 0;
            continue;
          }
        }

        // Resolve template variables in the input
        const resolvedInput = this.resolveInputTemplate(node);

        try {
          const runId = this.getSubAgentManager().spawn(
            node.subAgentName,
            resolvedInput,
            workdir ? { workdir } : undefined,
          );
          node.runId = runId;
          this.logger.info("Orchestrator", `  Spawned [${node.id}] → ${node.subAgentName} (${runId})`);

          // Fire onToolStart so traces capture the sub-agent dispatch
          for (const h of this.hooks) h.onToolStart?.("spawn_subagent", { name: node.subAgentName, input: resolvedInput }, runId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn("Orchestrator", `  Failed to spawn [${node.id}]: ${message}`);
          node.status = "failed";
          node.result = {
            subAgentId: `error_${node.id}`,
            name: node.subAgentName,
            success: false,
            output: `Failed to spawn: ${message}`,
            durationMs: 0,
          };
          node.durationMs = 0;

          // Fire onToolError for the failed spawn
          for (const h of this.hooks) h.onToolError?.("spawn_subagent", node.result.output, undefined);
        }
      }

      // Poll until all dispatched nodes in this wave complete
      await this.pollUntilNodesComplete(readyNodes);

      // ── Handle retries ────────────────────────────────────────────
      const retryTriggered = this.handleFailedNodes(readyNodes);

      // ── Handle worktree lifecycle after node completion ────────────
      if (this.worktreeManager) {
        for (const node of readyNodes) {
          if (!node.worktreeId) continue;
          try {
            if (node.status === "completed" && this.autoMergeWorktrees) {
              await this.worktreeManager.removeWorktree(node.worktreeId, {
                force: false,
                mergeBack: true,
                deleteBranch: true,
              });
            } else if (this.autoCleanupWorktrees) {
              await this.worktreeManager.removeWorktree(node.worktreeId, {
                force: true,
                deleteBranch: true,
              });
            }
            // else: leave worktree on disk for manual inspection
          } catch (err: unknown) {
            this.logger.warn(
              "Orchestrator",
              `  Failed to clean up worktree for [${node.id}]: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // Inject completed results into context (skip retried nodes)
      for (const node of readyNodes) {
        // Nodes reset for retry have no result — skip them
        if (!node.result) continue;
        const source = `subagent:${node.subAgentName}:${node.id}`;
        const msg = new Message(
          Role.User,
          wrapAndScan(source, node.result.output),
          { name: source },
        );
        this.contextManager.addMessage(msg.toDict());
      }

      // If retries were triggered, continue the while loop so retried
      // nodes are picked up in the next dispatch wave.
      if (retryTriggered) {
        progress = true;
      }
    }
  }

  /**
   * Return nodes whose dependencies are all completed and that haven't
   * been dispatched yet, limited by maxParallelNodes.
   */
  private getReadyNodes(): TaskNode[] {
    const ready: TaskNode[] = [];
    for (const node of this.taskGraph.nodes) {
      if (node.status !== "pending") continue;
      const allDepsSatisfied = node.dependsOn.every((depId) => {
        const dep = this.taskGraph.nodes.find((n) => n.id === depId);
        if (!dep) return false;
        if (dep.status === "completed") return true;
        // A "failed" dep satisfies the dependency only in "continue" mode
        // (downstream sees error info injected). In retry strategies, the
        // failed dep will be retried, so we block the dependent.
        if (dep.status === "failed" && this.failureStrategy === "continue") return true;
        // "running" and "pending" deps never satisfy.
        return false;
      });
      if (allDepsSatisfied) {
        ready.push(node);
        if (ready.length >= this.maxParallelNodes) break;
      }
    }

    return ready;
  }

  /**
   * Busy-wait until all given nodes have resolved (completed or failed).
   */
  private async pollUntilNodesComplete(nodes: TaskNode[]): Promise<void> {
    const targetIds = new Set(nodes.map((n) => n.id));

    while (true) {
      // Poll the sub-agent manager for any completed results
      const results = await this.getSubAgentManager().pollCompleted();

      // Match results to our task nodes
      for (const result of results) {
        // Find the node by matching the subAgentId pattern
        for (const node of nodes) {
          if (node.status === "running" && !node.result) {
            // Match by sub-agent name + result timing
            if (result.name === node.subAgentName) {
              node.result = result;
              node.status = result.success ? "completed" : "failed";
              node.durationMs = result.durationMs;
              this.logger.info(
                "Orchestrator",
                `  [${node.id}] ${node.status} (${node.durationMs}ms)`,
              );

              // Fire hooks so traces capture the sub-agent result
              if (result.success) {
                for (const h of this.hooks) h.onToolEnd?.("spawn_subagent", result.output, node.runId);
              } else {
                for (const h of this.hooks) h.onToolError?.("spawn_subagent", result.output, node.runId);
              }

              break;
            }
          }
        }
      }

      // Check if all target nodes are done
      const allDone = nodes.every(
        (n) => n.status === "completed" || n.status === "failed",
      );
      if (allDone) break;

      // Small delay before next poll
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Resolve `{{node_id.output}}` template references in a node's input.
   */
  private resolveInputTemplate(node: TaskNode): string {
    return node.input.replace(
      /\{\{(\w+)\.output\}\}/g,
      (_match, refId: string) => {
        const refNode = this.taskGraph.nodes.find((n) => n.id === refId);
        if (refNode?.result) {
          return refNode.result.output;
        }
        if (refNode?.status === "failed") {
          return `[Node "${refId}" failed: ${refNode.result?.output ?? "unknown error"}]`;
        }
        return `[Reference to unavailable node: ${refId}]`;
      },
    );
  }

  // ─── Phase 3: Synthesize ──────────────────────────────────────────────

  /**
   * Ask the LLM to review all completed node results and determine whether
   * the information is sufficient to answer the user.
   */
  private async synthesize(userInput: string): Promise<SynthesisResult> {
    const completedResults = this.formatCompletedResults();

    if (!completedResults) {
      return {
        thought: "No nodes have completed.",
        isComplete: false,
        gaps: ["No sub-agent results available — retry decomposition."],
      };
    }

    const prompt = buildSynthesizePrompt(
      userInput,
      completedResults,
      this.buildFallbackNotice(),
    );

    const messages = [
      { role: Role.System, content: prompt },
    ];

    for (const h of this.hooks) h.onLLMStart?.(messages, []);

    let response: LLMResponse;
    try {
      response = await this.llm.chat(
        messages,
        [],
        this._abortController?.signal,
      );
    } catch (err: unknown) {
      if (this.isCancelled) {
        return { thought: "Cancelled.", isComplete: false, gaps: [] };
      }
      if (err instanceof LLMNetworkError) {
        for (const h of this.hooks) h.onLLMError?.(err);
        return {
          thought: `Network error during synthesis: ${err.message}`,
          isComplete: false,
          gaps: ["Synthesis failed due to network error — retry."],
        };
      }
      throw err;
    }

    for (const h of this.hooks) h.onLLMEnd?.(response);

    this.trackFallback("Synthesize", response);

    if (response.usage) {
      this.tokenBudget?.recordUsage(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      );
    }

    const parsed = parseSynthesizeResponse(response.content);

    if (parsed.thought) {
      this.logger.info("Orchestrator", `Synthesize: ${parsed.thought}`);
    }

    return parsed;
  }

  /**
   * Build a formatted string of all completed node results for the
   * synthesis LLM prompt.
   */
  private formatCompletedResults(): string {
    const completed = this.taskGraph.nodes.filter(
      (n) => n.status === "completed" || n.status === "failed",
    );

    if (completed.length === 0) return "";

    const parts: string[] = [];
    for (const node of completed) {
      const retryInfo = node.retryCount > 0
        ? `, retries: ${node.retryCount}/${node.maxRetries ?? this.maxRetriesPerNode}`
        : "";
      const header = node.status === "completed"
        ? `=== [${node.id}] ${node.description} (SUCCESS${retryInfo}) ===`
        : `=== [${node.id}] ${node.description} (FAILED${retryInfo}) ===`;
      const body = node.result?.output ?? "(no output)";
      parts.push(`${header}\n${body}\n`);
    }

    return parts.join("\n\n");
  }

  // ─── Phase 4: Adapt ──────────────────────────────────────────────────

  /**
   * Ask the LLM to generate new task nodes to fill the gaps identified
   * during synthesis.
   */
  private async adapt(gaps: string[]): Promise<AdaptResult> {
    const availableSubAgents = this.getSubAgentManager().buildSubAgentList();

    const prompt = buildAdaptPrompt(gaps, availableSubAgents);

    const messages = [
      { role: Role.System, content: prompt },
    ];

    for (const h of this.hooks) h.onLLMStart?.(messages, []);

    let response: LLMResponse;
    try {
      response = await this.llm.chat(
        messages,
        [],
        this._abortController?.signal,
      );
    } catch (err: unknown) {
      if (this.isCancelled) {
        return { thought: "Cancelled.", newNodes: [], stuck: true };
      }
      if (err instanceof LLMNetworkError) {
        for (const h of this.hooks) h.onLLMError?.(err);
        return {
          thought: `Network error during adapt: ${err.message}`,
          newNodes: [],
          stuck: true,
        };
      }
      throw err;
    }

    for (const h of this.hooks) h.onLLMEnd?.(response);

    this.trackFallback("Adapt", response);

    if (response.usage) {
      this.tokenBudget?.recordUsage(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      );
    }

    const parsed = parseAdaptResponse(response.content);

    // Validate new nodes
    const existingIds = new Set(this.taskGraph.nodes.map((n) => n.id));
    for (const node of parsed.newNodes) {
      // Ensure unique IDs
      if (existingIds.has(node.id)) {
        node.id = `${node.id}_r${this.completedRounds}`;
      }
      existingIds.add(node.id);
      // Filter unknown dependencies
      (node as { dependsOn: string[] }).dependsOn = node.dependsOn.filter(
        (d) => existingIds.has(d),
      );
    }

    if (parsed.thought) {
      this.logger.info("Orchestrator", `Adapt: ${parsed.thought}`);
      for (const h of this.hooks) h.onThought?.(parsed.thought);
    }

    return parsed;
  }

  // ─── Force Synthesis ─────────────────────────────────────────────────

  /**
   * Force a final synthesis when rounds are exhausted or the orchestrator
   * is stuck. Asks the LLM to produce the best answer it can with whatever
   * results are available.
   */
  private async forceSynthesize(userInput: string): Promise<string> {
    const completedResults = this.formatCompletedResults();

    if (!completedResults) {
      return "I was unable to complete the task — no sub-agent results were produced.";
    }

    const fallbackNotice = this.buildFallbackNotice();

    const prompt = `You are a synthesiser producing a FINAL answer. The orchestrator has
stopped (either max rounds reached or no more useful work can be devised).
Using the sub-agent results below, provide the BEST answer you can to the
user's original request. Be honest about any limitations or incomplete information.

=== User's Original Request ===
${userInput}
${fallbackNotice}
=== Sub-Agent Results ===
${completedResults}

Respond with ONLY a JSON object:
{
  "thought": "<your analysis of what was accomplished and what is missing>",
  "answer": "<the best answer you can provide>"
}

Rules:
- Include "thought" covering both what was learned AND what remains uncertain.
- The "answer" should be thorough but honest about gaps.
- The JSON must be valid — no trailing commas, no comments.`;

    const messages = [
      { role: Role.System, content: prompt },
    ];

    for (const h of this.hooks) h.onLLMStart?.(messages, []);

    let response: LLMResponse;
    try {
      response = await this.llm.chat(
        messages,
        [],
        this._abortController?.signal,
      );
    } catch (err: unknown) {
      if (err instanceof LLMNetworkError) {
        for (const h of this.hooks) h.onLLMError?.(err);
        return `Network error during final synthesis: ${err.message}. ` +
          `Partial results are preserved in the session.`;
      }
      throw err;
    }

    for (const h of this.hooks) h.onLLMEnd?.(response);

    this.trackFallback("ForceSynthesize", response);

    if (response.usage) {
      this.tokenBudget?.recordUsage(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      );
    }

    // Parse with the standard ReAct response format (thought + answer)
    const json = extractJSON(response.content);
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (typeof parsed === "object" && parsed !== null) {
          const thought = String(parsed.thought ?? "");
          const answer = String(parsed.answer ?? response.content);
          this.logger.info("Orchestrator", `Force synthesize: ${thought}`);
          return answer;
        }
      } catch {
        // Fall through
      }
    }

    return response.content;
  }

  // ─── Session Persistence ────────────────────────────────────────────

  /**
   * Agent type identifier for session metadata.
   */
  protected getAgentType(): "orchestrator" {
    return "orchestrator";
  }

  /**
   * Include orchestrator state in session checkpoints.
   */
  protected buildBaseSessionState(status: SessionStatus): SessionState {
    const base = super.buildBaseSessionState(status);
    return {
      ...base,
      planState: undefined,
      fusionState: undefined,
      orchestratorState: {
        taskGraph: this.taskGraph,
        completedRounds: this.completedRounds,
        worktreeState: this.worktreeManager?.buildSessionState(),
      },
    };
  }

  /**
   * Restore orchestrator state from a saved session.
   */
  protected loadAndRestoreSession(sessionId: string): SessionState {
    const state = super.loadAndRestoreSession(sessionId);

    if (state.orchestratorState) {
      const os = state.orchestratorState as OrchestratorSessionState;
      this.taskGraph = os.taskGraph;
      this.completedRounds = os.completedRounds;

      // Backward compat: fill in retry fields on restored nodes
      // (sessions saved before the retry feature was added).
      for (const node of this.taskGraph.nodes) {
        if (node.retryCount === undefined) node.retryCount = 0;
        if (node.maxRetries === undefined) node.maxRetries = this.maxRetriesPerNode;
      }

      // Restore worktree state so we can resume managing active worktrees
      if (os.worktreeState && this.worktreeManager) {
        this.worktreeManager.restoreSessionState(os.worktreeState);
      }
    }

    return state;
  }

  // ─── Resume ─────────────────────────────────────────────────────────

  /**
   * Resume a previously interrupted orchestration session.
   *
   * Restores messages, system prompt, and the full task graph so the
   * orchestrator can continue from where it left off.
   *
   * @param sessionId The session ID to resume.
   * @param input     New user input to continue the conversation.
   */
  async resume(sessionId: string, input: string): Promise<string> {
    this.loadAndRestoreSession(sessionId);
    this._skipStateReset = true;
    return this.run(input);
  }
}
