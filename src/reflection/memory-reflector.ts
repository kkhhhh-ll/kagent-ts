import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { ReActAgent } from "../core/react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { STRUCTURED_OUTPUT_INSTRUCTIONS } from "../core/response-schema";
import { MemoryManager, Memory, MemoryType } from "../memory/memory-manager";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Input provided to the MemoryReflector for analysis.
 */
export interface MemoryReflectionInput {
  /** The original user query. */
  userQuery: string;
  /** The final answer produced by the agent. */
  finalAnswer: string;
  /** The full conversation messages (for context). */
  conversation: MessageData[];
  /** Session identifier. */
  sessionId: string;
}

/**
 * A single memory extracted from the session.
 */
export interface ExtractedMemory {
  /** Slug (kebab-case, used as filename). */
  name: string;
  /** One-line summary shown in the index. */
  description: string;
  /** Memory type. */
  type: MemoryType;
  /** Markdown body with why + how to apply. */
  content: string;
}

/**
 * Structured JSON output expected from the fork sub-agent's final answer.
 */
interface MemoryExtractionResponse {
  memories: ExtractedMemory[];
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to review a completed agent session
and identify constraints, project decisions, and user preferences worth remembering for future sessions.

You have access to read_file and grep_search tools to verify context against the codebase.

Categories of memory to extract:
- **rule**: A constraint the user explicitly set — why they required it, and when it takes
  effect. Rules are hard requirements the user stated directly (e.g. "must use X", "never do Y").
  Example: "Always use kebab-case for file names."
- **project**: A fact or decision about the project — what happened, why (constraint / deadline
  that drove it), and how the agent should apply it.
  Example: "We switched from MySQL to PostgreSQL because of JSONB support."
- **preference**: A user habit or style preference observed during the conversation —
  patterns the user consistently prefers but did NOT state as a hard requirement.
  Example: "User prefers short, direct answers without boilerplate explanations."
  Example: "User prefers pnpm over npm."

What to look for:
- Explicit user constraints ("must", "must not", "always", "never", "don't use X") → rule
- Project decisions (architecture choices, tool/library selections, migration decisions) → project
- User style/habit patterns (communication style, tool preference, workflow habits) → preference
- Patterns worth repeating or avoiding (successful or failed approaches in this project)

IMPORTANT: User habits and style preferences (communication style, tool preference, etc.) go in
'preference', NOT in 'rule'. 'rule' is ONLY for explicit constraints the user stated as requirements.

An existing memories list is provided below — do NOT duplicate any existing memory name.
Only output genuinely new, useful memories. An empty list is fine if nothing new is found.

In your final answer, output a JSON object with this structure:
{
  "memories": [
    {
      "name": "kebab-case-slug",
      "description": "one-line summary",
      "type": "rule | project | preference",
      "content": "The fact.\\n\\n**Why:** ...\\n\\n**How to apply:** ..."
    }
  ]
}

Rules:
- "name" must be a kebab-case slug (lowercase letters, digits, dashes).
- "description" must be a concise one-line summary (~5-15 words).
- "type" must be "rule", "project", or "preference".
- "content": for rules include **Why:** + **When:**, for projects include **Why:** + **How to apply:**,
  for preferences include **Observed pattern:** + **Evidence:** (what the user said or did).
- Only output memories that provide lasting value across sessions.
- Be specific and actionable — avoid vague statements.
- Do NOT duplicate existing memory names.${STRUCTURED_OUTPUT_INSTRUCTIONS}`;

// ─── MemoryReflector ─────────────────────────────────────────────────────────

/**
 * Configuration for the MemoryReflector.
 */
export interface MemoryReflectorConfig {
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** MemoryManager for checking existing memories and persisting new ones. */
  memoryManager: MemoryManager;
  /**
   * Maximum ReAct iterations for the sub-agent (default: 5).
   * Memory extraction requires more context reading than error reflection.
   */
  maxIterations?: number;
}

/**
 * MemoryReflector — post-execution memory extraction via a forked sub-agent.
 *
 * After the main agent finishes, the MemoryReflector forks a lightweight
 * ReActAgent to review the session and extract lasting memories: user
 * preferences, project decisions, constraints, and workflow patterns.
 *
 * The fork runs in its own context with read-only tools (read_file, grep_search)
 * so it can verify context against the codebase before recording a memory.
 *
 * Usage:
 * ```ts
 * const memManager = new MemoryManager({ storageDir: ".memory" });
 * const reflector = new MemoryReflector({ llm, memoryManager: memManager });
 * const memories = await reflector.reflect({
 *   userQuery: input,
 *   finalAnswer: answer,
 *   conversation: contextMessages,
 *   sessionId: "sess_123",
 * });
 * ```
 */
export class MemoryReflector {
  private llm: LLMProvider;
  private memoryManager: MemoryManager;
  private maxIterations: number;

  constructor(config: MemoryReflectorConfig) {
    this.llm = config.llm;
    this.memoryManager = config.memoryManager;
    this.maxIterations = config.maxIterations ?? 5;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to extract memories from the session.
   *
   * @returns The list of new memories written to the MemoryManager.
   */
  async reflect(input: MemoryReflectionInput): Promise<Memory[]> {
    const existingNames = this.memoryManager.getAll().map((m) => ({
      name: m.name,
      description: m.description,
    }));

    const taskPrompt = this.buildTaskPrompt(input, existingNames);
    const answer = await this.forkAndRun(taskPrompt);
    const extracted = this.parseMemories(answer);

    // Persist to MemoryManager (add() handles upsert by name)
    const saved: Memory[] = [];
    for (const m of extracted) {
      const memory: Memory = {
        name: m.name,
        description: m.description,
        type: m.type,
        content: m.content,
      };

      // Skip if name already exists (defensive — sub-agent should avoid this)
      if (this.memoryManager.has(m.name)) continue;

      this.memoryManager.add(memory);
      saved.push(memory);
    }

    return saved;
  }

  // ─── Private: Fork ─────────────────────────────────────────────────────

  /**
   * Fork a minimal ReActAgent and run it to completion.
   * Returns the agent's final answer string.
   */
  private async forkAndRun(userPrompt: string): Promise<string> {
    const tools = new ToolRegistry();
    tools.register(ReadFileTool);
    tools.register(GrepSearchTool);

    const agent = new ReActAgent({
      llm: this.llm,
      systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
      toolRegistry: tools,
      maxIterations: this.maxIterations,
    });

    return agent.run(userPrompt);
  }

  // ─── Private: Prompt Building ──────────────────────────────────────────

  /**
   * Build the task prompt for the sub-agent from the reflection input.
   */
  private buildTaskPrompt(
    input: MemoryReflectionInput,
    existing: Array<{ name: string; description: string }>,
  ): string {
    let context = [
      "Review this agent session and extract any memories worth keeping for future sessions.",
      "",
      "=== Existing Memories (do NOT duplicate these names) ===",
    ];

    if (existing.length === 0) {
      context.push("(no existing memories)");
    } else {
      for (const m of existing) {
        context.push(`- ${m.name}: ${m.description}`);
      }
    }

    context.push(
      "",
      "=== User Query ===",
      input.userQuery,
      "",
      "=== Final Answer ===",
      input.finalAnswer,
      "",
      "=== Conversation ===",
      ...this.formatConversation(input.conversation),
      "",
      "Analyze the session and output extracted memories as JSON in your final answer.",
    );

    return context.join("\n");
  }

  /**
   * Format the conversation for the memory extraction prompt.
   * Truncates very long tool results for readability.
   */
  private formatConversation(messages: MessageData[]): string[] {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = msg.content;

      // Truncate long tool results
      if (msg.role === Role.Tool && content.length > 1000) {
        content = content.slice(0, 500) + "\n... (truncated, " + content.length + " chars total)";
      }

      lines.push(`[${role}] ${content}`);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          lines.push(`  → tool_call: ${tc.function.name}(${tc.function.arguments})`);
        }
      }
    }
    return lines;
  }

  // ─── Private: Parsing ──────────────────────────────────────────────────

  /**
   * Parse the sub-agent's final answer into a list of ExtractedMemories.
   * Returns an empty array if parsing fails (best-effort).
   */
  private parseMemories(answer: string): ExtractedMemory[] {
    try {
      // Extract JSON from the answer (may be wrapped in ```json fences)
      let raw = answer.trim();
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) raw = fenceMatch[1];

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (!Array.isArray(parsed.memories)) return [];

      const validTypes = new Set<string>(["rule", "project", "preference"]);
      const memories: ExtractedMemory[] = [];

      for (const m of parsed.memories as Array<Record<string, unknown>>) {
        if (
          typeof m.name !== "string" || !m.name ||
          typeof m.description !== "string" || !m.description ||
          typeof m.type !== "string" || !validTypes.has(m.type) ||
          typeof m.content !== "string" || !m.content
        ) {
          continue;
        }

        memories.push({
          name: m.name,
          description: m.description,
          type: m.type as MemoryType,
          content: m.content,
        });
      }

      return memories;
    } catch {
      return [];
    }
  }
}
