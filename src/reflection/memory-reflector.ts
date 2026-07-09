import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { STRUCTURED_OUTPUT_INSTRUCTIONS } from "../core/response-schema";
import { MemoryManager, Memory, MemoryType } from "../memory/memory-manager";
import { Logger, ConsoleLogger } from "../logging/logger";

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
 * Used as the parsing target in {@link parseMemories} so TypeScript
 * validates the shape at compile time.
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

// ─── Pure Helpers ────────────────────────────────────────────────────────────

/** Characters to keep from the start of a truncated tool result. */
const TRUNCATION_RETAIN = 500;
/** Tool result longer than this will be truncated. */
const TRUNCATION_THRESHOLD = TRUNCATION_RETAIN * 2;

const VALID_MEMORY_TYPES = new Set<string>(["rule", "project", "preference"]);

/**
 * Format the conversation for the memory extraction prompt.
 * Truncates very long tool results for readability.
 */
function formatConversation(messages: MessageData[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    let content = msg.content;

    if (msg.role === Role.Tool && content.length > TRUNCATION_THRESHOLD) {
      content = content.slice(0, TRUNCATION_RETAIN) + "\n... (truncated, " + content.length + " chars total)";
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

/**
 * Build the task prompt for the fork sub-agent from the memory reflection input.
 */
function buildTaskPrompt(
  input: MemoryReflectionInput,
  existing: Array<{ name: string; description: string }>,
): string {
  const context: string[] = [
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
    ...formatConversation(input.conversation),
    "",
    "Analyze the session and output extracted memories as JSON in your final answer.",
  );

  return context.join("\n");
}

/**
 * Parse the sub-agent's final answer into a list of ExtractedMemories.
 *
 * @returns Parsed memories (may be empty if nothing worth remembering).
 * @throws {Error} If the LLM output cannot be parsed as valid JSON —
 *         this is a fatal error distinct from "no memories extracted."
 */
function parseMemories(answer: string, logger: Logger): ExtractedMemory[] {
  // Extract JSON from the answer (may be wrapped in ```json fences)
  let raw = answer.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) raw = fenceMatch[1];

  let parsed: MemoryExtractionResponse;

  try {
    parsed = JSON.parse(raw) as MemoryExtractionResponse;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse extracted memories from LLM output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(parsed.memories)) return [];

  const memories: ExtractedMemory[] = [];

  for (const m of parsed.memories) {
    if (
      typeof m.name !== "string" || !m.name ||
      typeof m.description !== "string" || !m.description ||
      typeof m.type !== "string" || !VALID_MEMORY_TYPES.has(m.type) ||
      typeof m.content !== "string" || !m.content
    ) {
      logger.warn(
        "MemoryReflector",
        `Skipping malformed memory: Got: ${JSON.stringify({ name: m.name, description: m.description, type: m.type, hasContent: typeof m.content === "string" && !!m.content })}`,
      );
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
}

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
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
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
  private logger: Logger;

  /** Hard timeout for the entire memory extraction fork (5 minutes). */
  private static readonly MEMORY_REFLECTION_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(config: MemoryReflectorConfig) {
    this.llm = config.llm;
    this.memoryManager = config.memoryManager;
    this.maxIterations = config.maxIterations ?? 5;
    this.logger = config.logger ?? new ConsoleLogger();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to extract memories from the session.
   *
   * @returns The list of new memories written to the MemoryManager.
   * @throws If the memory extraction fork times out.
   * @throws If the LLM output cannot be parsed.
   */
  async reflect(input: MemoryReflectionInput): Promise<Memory[]> {
    const existingNames = this.memoryManager.getAll().map((m) => ({
      name: m.name,
      description: m.description,
    }));

    const taskPrompt = buildTaskPrompt(input, existingNames);

    // Enforce a hard timeout. The timer is explicitly cleared in the
    // finally block to prevent a timer leak.
    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      const answer = await Promise.race([
        this.forkAndRun(taskPrompt),
        new Promise<string>((_, reject) => {
          timerId = setTimeout(
            () => reject(new Error(`Memory extraction fork timed out after ${MemoryReflector.MEMORY_REFLECTION_TIMEOUT_MS / 1000}s`)),
            MemoryReflector.MEMORY_REFLECTION_TIMEOUT_MS,
          );
        }),
      ]);

      const extracted = parseMemories(answer, this.logger);

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
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  }

  // ─── Private: Fork ─────────────────────────────────────────────────────

  /**
   * Fork a minimal ReActAgent and run it to completion.
   * Returns the agent's final answer string.
   */
  private async forkAndRun(userPrompt: string): Promise<string> {
    const { forkAgent } = await import("../core/fork.js");
    return forkAgent(userPrompt, {
      llm: this.llm,
      systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
      maxIterations: this.maxIterations,
      logger: this.logger,
    });
  }
}
