import type { SubAgentResult } from "../subagent/subagent-types";
import type { WorktreeSessionState } from "../git/git-types";

/**
 * Orchestrator Agent type definitions.
 *
 * The OrchestratorAgent decomposes user tasks into a DAG of sub-tasks,
 * dispatches them to sub-agents (parallel where possible), synthesises
 * results, and adapts the task graph in subsequent rounds when gaps are
 * found or new information emerges.
 */

// ─── Task Graph ────────────────────────────────────────────────────────────

/**
 * Status of a single task node in the orchestration DAG.
 */
export type TaskNodeStatus =
  | "pending"     // Not yet dispatched (dependencies not satisfied)
  | "ready"       // Dependencies satisfied, waiting to be picked up
  | "running"     // Sub-agent spawned, executing
  | "completed"   // Sub-agent finished successfully
  | "failed";     // Sub-agent errored or timed out

/**
 * A single node in the orchestration task DAG.
 *
 * Each node represents one sub-agent invocation.  Dependencies are
 * expressed via `dependsOn` — a node becomes ready only after all
 * nodes it depends on have completed.
 */
export interface TaskNode {
  /** Unique identifier within this orchestration run. */
  id: string;

  /** Human-readable description (used in LLM prompts for synthesis). */
  description: string;

  /** The sub-agent definition name to spawn (must be registered). */
  subAgentName: string;

  /**
   * The prompt / input passed to the sub-agent.
   *
   * May contain template references like `{{node_id.output}}` which are
   * resolved at dispatch time by substituting the referenced node's result.
   */
  input: string;

  /**
   * IDs of nodes that must complete before this node can be dispatched.
   * Empty array = no dependencies (can be dispatched immediately).
   */
  dependsOn: string[];

  // ── Runtime state (populated during execution) ──────────────────────

  /** Current execution status. */
  status: TaskNodeStatus;

  /** The sub-agent result, populated after the node completes. */
  result?: SubAgentResult;

  /** Spawn time (epoch ms), set when the node transitions to running. */
  startedAt?: number;

  /** Wall-clock duration in ms, set on completion. */
  durationMs?: number;

  /**
   * The sub-agent run ID returned by SubAgentManager.spawn().
   * Set at dispatch time so hooks can correlate spawn → result.
   */
  runId?: string;

  /**
   * Git worktree ID if this node was assigned an isolated worktree.
   * Set by the OrchestratorAgent when `enableWorktrees` is true.
   */
  worktreeId?: string;

  /**
   * Optional base ref for this node's worktree.
   * Overrides the default from GitWorktreeConfig.
   * Example: a node that should work on a specific feature branch.
   */
  worktreeBaseRef?: string;
}

/**
 * A directed acyclic graph of tasks to be orchestrated.
 */
export interface TaskGraph {
  /** All task nodes in this graph. */
  nodes: TaskNode[];
}

// ─── Orchestration Plan (LLM output of the Decompose phase) ────────────────

/**
 * The structured decomposition produced by the LLM during the Decompose phase.
 *
 * The LLM analyses the user's request and produces a task graph where each
 * node is a concrete, delegate-able piece of work assigned to a specific
 * sub-agent type.
 */
export interface OrchestrationPlan {
  /** Step-by-step reasoning about the decomposition strategy. */
  thought: string;

  /** The task graph to execute. */
  taskGraph: TaskGraph;
}

// ─── Synthesis Result (LLM output of the Synthesize phase) ─────────────────

/**
 * The LLM's synthesis of all completed node results after a dispatch round.
 *
 * If `isComplete` is true, `finalAnswer` contains the answer for the user.
 * Otherwise, `gaps` describes what additional work is needed.
 */
export interface SynthesisResult {
  /** Reasoning about what was learned from the results. */
  thought: string;

  /** Whether the orchestrator has enough information to answer the user. */
  isComplete: boolean;

  /**
   * The final answer for the user.
   * Only present when `isComplete` is true.
   */
  finalAnswer?: string;

  /**
   * Descriptions of missing or insufficient information.
   * Only present when `isComplete` is false.
   * Each gap is a natural-language description that the Adapt phase
   * turns into new TaskNodes.
   */
  gaps?: string[];
}

// ─── Adapt Result (LLM output of the Adapt phase) ─────────────────────────

/**
 * New task nodes generated in response to gaps identified during synthesis.
 */
export interface AdaptResult {
  /** Reasoning about why these new nodes are needed. */
  thought: string;

  /** New task nodes to append to the task graph. */
  newNodes: TaskNode[];

  /**
   * Whether the orchestrator is stuck — no meaningful new work can be
   * devised. When true, the orchestrator will skip to forced synthesis.
   */
  stuck?: boolean;
}

// ─── Orchestrator State (for session persistence) ──────────────────────────

/**
 * Serializable orchestrator state included in session checkpoints.
 */
export interface OrchestratorSessionState {
  /** The current task graph (all nodes with their statuses). */
  taskGraph: TaskGraph;
  /** How many dispatch rounds have completed. */
  completedRounds: number;
  /** Git worktree state (present when `enableWorktrees` is true). */
  worktreeState?: WorktreeSessionState;
}
