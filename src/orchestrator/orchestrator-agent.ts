import { Agent, AgentConfig } from "../core/agent";
import { Message } from "../messages/message";
import { Role } from "../messages/types";
import { LLMNetworkError } from "../llm/errors";
import { LLMResponse } from "../llm/interface";
import { wrapUntrusted } from "../security/boundaries";
import { SUB_AGENT_DELEGATION } from "../core/system-prompts";
import { SessionState, SessionStatus } from "../session/session-types";

import type {
  TaskNode,
  TaskGraph,
  OrchestrationPlan,
  SynthesisResult,
  AdaptResult,
  OrchestratorSessionState,
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

You have access to tools for discovering and spawning sub-agents.
${SUB_AGENT_DELEGATION}`;

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

  // ── Runtime state ───────────────────────────────────────────────────

  /** The current task graph. */
  private taskGraph: TaskGraph = { nodes: [] };

  /** How many dispatch rounds have been completed. */
  private completedRounds = 0;

  /** Internal flag: when true, run() skips state reset (used by resume()). */
  private _skipStateReset = false;

  constructor(config: OrchestratorAgentConfig) {
    const mergedConfig: OrchestratorAgentConfig = {
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
    };
    super(mergedConfig);

    this.maxRounds = config.maxRounds ?? 3;
    this.maxParallelNodes = config.maxParallelNodes ?? 5;
    this.maxTotalNodes = config.maxTotalNodes ?? 20;

    this.rebuildSystemPrompt();
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

    const userMessage = Message.user(input);
    this.contextManager.addMessage(userMessage.toDict());

    if (!skipStateReset) {
      this.taskGraph = { nodes: [] };
      this.completedRounds = 0;
    }

    if (this.checkpointingEnabled) {
      this.saveCheckpoint("active");
    }

    // ── Phase 1: Decompose ─────────────────────────────────────────────
    // On resume (skipStateReset + graph already loaded), skip decomposition.
    if (!skipStateReset || this.taskGraph.nodes.length === 0) {
      const plan = await this.decompose(input);
      this.taskGraph = plan.taskGraph;

      if (this.taskGraph.nodes.length === 0) {
        const fallback =
          "I was unable to decompose this task into sub-agent actions. " +
          "Please try rephrasing your request with more specific goals.";
        for (const h of this.hooks) h.onFinish?.(fallback);
        return fallback;
      }

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
      this.logger.info("Orchestrator", `Round ${this.completedRounds + 1}: ${adaptResult.newNodes.length} new node(s) added.`);

      if (this.checkpointingEnabled) {
        this.saveCheckpoint("active");
      }
    }

    // Should not reach here — caught by last-round check above
    const forced = await this.forceSynthesize(input);
    for (const h of this.hooks) h.onFinish?.(forced);
    return forced;
  }

  // ─── Phase 1: Decompose ──────────────────────────────────────────────

  /**
   * Ask the LLM to decompose the user's request into a TaskGraph.
   *
   * Sends a dedicated prompt with the list of available sub-agents so the
   * LLM knows what it can delegate to.
   */
  private async decompose(input: string): Promise<OrchestrationPlan> {
    const availableSubAgents = this.subAgentManager!.buildSubAgentList();

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

        // Resolve template variables in the input
        const resolvedInput = this.resolveInputTemplate(node);

        try {
          const runId = this.subAgentManager!.spawn(node.subAgentName, resolvedInput);
          this.logger.info("Orchestrator", `  Spawned [${node.id}] → ${node.subAgentName} (${runId})`);
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
        }
      }

      // Poll until all dispatched nodes in this wave complete
      await this.pollUntilNodesComplete(readyNodes);

      // Inject completed results into context
      for (const node of readyNodes) {
        if (node.result) {
          const source = `subagent:${node.subAgentName}:${node.id}`;
          const msg = new Message(
            Role.User,
            wrapUntrusted(source, node.result.output),
            { name: source },
          );
          this.contextManager.addMessage(msg.toDict());
        }
      }
    }
  }

  /**
   * Return nodes whose dependencies are all completed and that haven't
   * been dispatched yet, limited by maxParallelNodes.
   */
  private getReadyNodes(): TaskNode[] {
    const completedIds = new Set(
      this.taskGraph.nodes
        .filter((n) => n.status === "completed")
        .map((n) => n.id),
    );

    const ready: TaskNode[] = [];
    for (const node of this.taskGraph.nodes) {
      if (node.status !== "pending") continue;
      const allDepsSatisfied = node.dependsOn.every((depId) => {
        // A "failed" node still satisfies the dependency (we don't want to
        // deadlock), but the downstream node will see the error in its input.
        const dep = this.taskGraph.nodes.find((n) => n.id === depId);
        return dep && (dep.status === "completed" || dep.status === "failed");
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
      const results = await this.subAgentManager!.pollCompleted();

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

    const prompt = buildSynthesizePrompt(userInput, completedResults);

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
      const header = node.status === "completed"
        ? `=== [${node.id}] ${node.description} (SUCCESS) ===`
        : `=== [${node.id}] ${node.description} (FAILED) ===`;
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
    const availableSubAgents = this.subAgentManager!.buildSubAgentList();

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

    const prompt = `You are a synthesiser producing a FINAL answer. The orchestrator has
stopped (either max rounds reached or no more useful work can be devised).
Using the sub-agent results below, provide the BEST answer you can to the
user's original request. Be honest about any limitations or incomplete information.

=== User's Original Request ===
${userInput}

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
