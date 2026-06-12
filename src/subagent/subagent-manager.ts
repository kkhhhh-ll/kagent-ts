import { SubAgentDefinition, SubAgentResult, PendingRun } from "./subagent-types";
import { SubAgentLoader } from "./subagent-loader";
import { ReActAgent } from "../core/react-agent";
import { LLMProvider } from "../llm/interface";
import { ToolRegistry } from "../tools/tool-registry";
import { Tool } from "../tools/types";
import { SkillManager } from "../skills/skill-manager";
import { Skill } from "../skills/types";

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
  /** Registered definitions keyed by name. */
  private definitions: Map<string, SubAgentDefinition> = new Map();

  /** Currently pending (running) sub-agents. */
  private pending: PendingRun[] = [];

  /** Shared LLM provider injected by the main agent. */
  private llmProvider?: LLMProvider;

  /** Reference to the main agent's ToolRegistry for tool lookup. */
  private toolRegistry?: ToolRegistry;

  /** Reference to the main agent's SkillManager for skill activation. */
  private skillManager?: SkillManager;

  /** Counter for generating unique sub-agent run IDs. */
  private runIdCounter = 0;

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Register sub-agent definitions from a directory of AGENT.md files.
   */
  registerFromDirectory(dir: string): number {
    const loader = new SubAgentLoader(dir);
    const definitions = loader.scan();
    let count = 0;

    for (const def of definitions) {
      if (this.definitions.has(def.name)) {
        console.warn(`[SubAgent] Skipping "${def.name}": already registered.`);
        continue;
      }
      this.definitions.set(def.name, def);
      count++;
    }

    if (count > 0) {
      console.log(`[SubAgent] Registered ${count} sub-agent(s) from ${dir}.`);
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
   * Set shared resources from the main agent.
   * Called once during agent init.
   */
  bind(llmProvider: LLMProvider, toolRegistry: ToolRegistry, skillManager: SkillManager): void {
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
  }

  // ─── Spawn ────────────────────────────────────────────────────────────────

  /**
   * Spawn a sub-agent by definition name. Returns immediately with a run ID;
   * the sub-agent executes asynchronously.
   *
   * Only one sub-agent can be spawned at a time from the same definition
   * (active runs are tracked per name). Additional spawn attempts with the
   * same name while a run is still pending will be rejected.
   *
   * @param name  The registered sub-agent definition name.
   * @param input The task description passed to the sub-agent.
   * @returns The unique run ID (used to correlate results later).
   * @throws If the definition is unknown, LLM is not bound, or a run is
   *         already active for the given name.
   */
  spawn(name: string, input: string): string {
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

    const runId = `${name}_${++this.runIdCounter}_${Date.now()}`;

    // Fire-and-forget: start the sub-agent run, store the promise
    const startedAt = Date.now();
    const promise = this.executeRun(name, runId, definition, input, startedAt);

    this.pending.push({ subAgentId: runId, name, startedAt, promise });

    console.log(`[SubAgent] Spawned "${name}" (run: ${runId}).`);
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

    // Use Promise.race + a null sentinel to check each pending run
    const results: SubAgentResult[] = [];
    const stillPending: PendingRun[] = [];

    for (const run of this.pending) {
      // Check if resolved by racing against an immediately-resolving null
      const resolved = await Promise.race([
        run.promise.then((r) => r),
        Promise.resolve(null as unknown as SubAgentResult),
      ]);

      if (resolved !== null) {
        results.push(resolved);
        console.log(
          `[SubAgent] "${run.name}" (run: ${run.subAgentId}) completed in ${resolved.durationMs}ms.`,
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
   * Build a description of all registered sub-agents for the spawn tool.
   */
  buildToolDescription(): string {
    if (this.definitions.size === 0) return "No sub-agents registered.";
    const lines: string[] = [];
    for (const def of this.definitions.values()) {
      lines.push(`- ${def.name}: ${def.description}`);
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
  ): Promise<SubAgentResult> {
    try {
      const agent = this.buildSubAgent(definition);
      const output = await agent.run(input);
      const durationMs = Date.now() - startedAt;

      return {
        subAgentId: runId,
        name,
        success: true,
        output: this.wrapXml(name, runId, true, output, durationMs),
        durationMs,
      };
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

  /**
   * Build a ReActAgent instance from a sub-agent definition, with:
   * - Filtered tool set (only declared tools)
   * - Pre-activated skills (copied from main agent's SkillManager)
   * - No spawn tool
   * - Auto-detect disabled (skills are pre-activated)
   */
  private buildSubAgent(definition: SubAgentDefinition): ReActAgent {
    // Look up declared tools from the main agent's registry
    const tools: Tool[] = [];
    for (const toolName of definition.tools) {
      const tool = this.toolRegistry!.getTool(toolName);
      if (tool) {
        tools.push(tool);
      } else {
        console.warn(
          `[SubAgent] Tool "${toolName}" requested by "${definition.name}" not found in registry.`,
        );
      }
    }

    // Build a dedicated ToolRegistry for this sub-agent
    const toolRegistry = new ToolRegistry();
    if (tools.length > 0) {
      toolRegistry.registerMany(tools);
    }

    // Build a dedicated SkillManager with copies of declared skills
    const skillManager = new SkillManager();
    for (const skillName of definition.skills) {
      const mainSkill = this.skillManager!.get(skillName);
      if (mainSkill) {
        // Copy the skill (shallow clone) so sub-agent state is independent
        const skillCopy: Skill = { ...mainSkill };
        skillManager.register(skillCopy);
        skillManager.activate(skillName);
      } else {
        console.warn(
          `[SubAgent] Skill "${skillName}" requested by "${definition.name}" not found.`,
        );
      }
    }

    // Build system prompt: sub-agent definition prompt + active skill content
    const systemPrompt = definition.systemPrompt;

    return new ReActAgent({
      llm: this.llmProvider!,
      systemPrompt,
      toolRegistry,
      skillManager,
      enableSkillAutoDetect: false,
      maxIterations: 10,
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
