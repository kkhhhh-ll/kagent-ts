import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { ReActAgent } from "../core/react-agent";
import { ToolRegistry } from "../tools/tool-registry";
import { ReadFileTool } from "../tools/builtin/read-file";
import { GrepSearchTool } from "../tools/builtin/grep-search";
import { STRUCTURED_OUTPUT_INSTRUCTIONS } from "../core/response-schema";
import { SkillManager } from "../skills/skill-manager";
import { Logger, ConsoleLogger } from "../logging/logger";
import * as fs from "fs";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Input provided to the PrecipitateAgent for skill extraction.
 */
export interface PrecipitationInput {
  /** The original user query. */
  userQuery: string;
  /** The final answer produced by the agent. */
  finalAnswer: string;
  /** The full conversation messages (for context). */
  conversation: MessageData[];
  /** Session identifier for traceability. */
  sessionId: string;
  /** Names of already-registered skills (for dedup awareness). */
  existingSkillNames: string[];
  /** Name → description map of already-registered skills. */
  existingSkillDescriptions: Record<string, string>;
}

/**
 * A single skill candidate discovered by the PrecipitateAgent.
 */
export interface SkillCandidate {
  /** Unique kebab-case identifier. */
  name: string;
  /** One-line summary shown in the available skills list. */
  description: string;
  /** Full system prompt body (markdown, goes after the frontmatter). */
  content: string;
}

/**
 * Structured JSON output expected from the fork sub-agent's final answer.
 */
interface PrecipitationResponse {
  analysis: string;
  skills: SkillCandidate[];
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const PRECIPITATION_SYSTEM_PROMPT = `You are a skill-extraction agent. Your job is to review a completed
agent session and extract reusable patterns as structured skill definitions.

You have access to read_file and grep_search tools to verify your findings against the actual codebase.

Skills are reusable workflow templates that capture "how to do X in this project."
They are loaded as system prompt instructions in future sessions — think of them
as growing institutional knowledge.

Analyze the session across these dimensions:
- **Reusable patterns**: Workflows, strategies, or tool-combinations that worked well
  and would apply to similar future tasks. Example: "deploying to production",
  "setting up a new database migration", "debugging CI failures".
- **Domain knowledge**: Project-specific facts, conventions, or constraints
  discovered during the session. Example: "API rate limits", "required config files",
  "naming conventions for this codebase".
- **Tool usage insight**: Effective ways of using specific tools for specific goals.
  Example: "use grep_search before read_file to locate the right file first".
- **Error recovery patterns**: When a failure occurred and the agent discovered
  a reliable fix. These are the most valuable — they prevent others from
  repeating the same mistake.

IMPORTANT — before proposing a skill, check the list of existing skills provided
in the prompt. Do NOT propose skills that duplicate or substantially overlap
existing ones. If an existing skill covers the same domain, only propose a new
one if it adds genuinely new information.

In your final answer, output a JSON object with this structure:
{
  "analysis": "overall assessment — what was learned, what's reusable (2-4 sentences)",
  "skills": [
    {
      "name": "kebab-case-unique-name",
      "description": "One-line summary of what this skill covers.",
      "content": "Full system prompt body in markdown. Include concrete steps, examples, warnings, and references to relevant files or conventions."
    }
  ]
}

Rules:
- Only propose skills when there is genuinely reusable knowledge.
- If nothing is worth saving long-term, return an empty skills array.
- Each skill's name must be kebab-case, unique, and descriptive.
- Each skill's content must be concrete and actionable — vague generalities are NOT skills.
- The content should be written as instructions to a future LLM agent.
- Use your tools to verify claims against the actual codebase.
- Maximum 3 skills per session — quality over quantity.
${STRUCTURED_OUTPUT_INSTRUCTIONS}`;

// ─── Name Validation ─────────────────────────────────────────────────────────

/** Regex matching the FileSkillLoader validation: no slashes, backslashes, "..", or null bytes. */
const VALID_SKILL_NAME_RE = /[/\\]|\.\.|\0/;

function validateSkillName(name: string): void {
  if (!name) {
    throw new Error("Skill name must not be empty.");
  }
  if (VALID_SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": contains path traversal characters.`,
    );
  }
}

// ─── PrecipitateAgent ────────────────────────────────────────────────────────

/**
 * Configuration for the PrecipitateAgent.
 */
export interface PrecipitateAgentConfig {
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** Path to the skills directory where SKILL.md files are written. */
  skillsDir: string;
  /** SkillManager for reloading after writes. */
  skillManager: SkillManager;
  /**
   * Maximum ReAct iterations for the sub-agent (default: 5).
   */
  maxIterations?: number;
}

/**
 * PrecipitateAgent — post-execution skill extraction via a forked sub-agent.
 *
 * After the main agent finishes, the PrecipitateAgent forks a lightweight
 * ReActAgent to review the full session trace. The fork runs in its own
 * context with read-only tools (read_file, grep_search) so it can verify
 * findings against the codebase and existing skills.
 *
 * Discovered skills are written as SKILL.md files to `skillsDir` and
 * registered with the SkillManager for immediate availability.
 *
 * Usage:
 * ```ts
 * const precipitator = new PrecipitateAgent({
 *   llm,
 *   skillsDir: "./skills",
 *   skillManager: agent.skillManager,
 * });
 *
 * const candidates = await precipitator.precipitate({
 *   userQuery: input,
 *   finalAnswer: answer,
 *   conversation: contextMessages,
 *   sessionId: "sess_123",
 *   existingSkillNames: ["deploy"],
 *   existingSkillDescriptions: { deploy: "Deploy this project" },
 * });
 * ```
 */
export class PrecipitateAgent {
  private llm: LLMProvider;
  private skillsDir: string;
  private skillManager: SkillManager;
  private maxIterations: number;
  private logger: Logger;

  constructor(config: PrecipitateAgentConfig) {
    this.llm = config.llm;
    this.skillsDir = config.skillsDir;
    this.skillManager = config.skillManager;
    this.maxIterations = config.maxIterations ?? 5;
    this.logger = new ConsoleLogger();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to review the session and extract reusable skills.
   *
   * @returns Skill candidates that were successfully persisted to disk.
   */
  async precipitate(input: PrecipitationInput): Promise<SkillCandidate[]> {
    const taskPrompt = this.buildTaskPrompt(input);
    const answer = await this.forkAndRun(taskPrompt);
    const candidates = this.parseCandidates(answer);

    // Persist to disk and reload
    const persisted = await this.persistCandidates(candidates);

    return persisted;
  }

  // ─── Static Helper ────────────────────────────────────────────────────

  /**
   * Convenience method that runs the full precipitation pipeline from
   * agent-scoped data. Used by FusionAgent, ReActAgent, PlanSolveAgent
   * to avoid code duplication.
   *
   * @returns Names of newly created skills (empty if none).
   */
  static async runFromAgent(
    input: string,
    answer: string,
    skillsDir: string,
    skillManager: SkillManager,
    llm: LLMProvider,
    sessionId: string,
    maxIterations: number,
    logger: Logger,
    contextMessages: MessageData[],
  ): Promise<string[]> {
    if (!skillsDir) {
      logger.warn("Precipitation", "skillsDir not set — skipping.");
      return [];
    }

    logger.info("Precipitation", "Starting post-hoc skill extraction...");

    try {
      const precipitator = new PrecipitateAgent({
        llm,
        skillsDir,
        skillManager,
        maxIterations,
      });

      const existingSkills = skillManager.getAll();
      const existingSkillNames = existingSkills.map((s) => s.name);
      const existingSkillDescriptions: Record<string, string> = {};
      for (const s of existingSkills) {
        existingSkillDescriptions[s.name] = s.description;
      }

      const candidates = await precipitator.precipitate({
        userQuery: input,
        finalAnswer: answer,
        conversation: contextMessages,
        sessionId,
        existingSkillNames,
        existingSkillDescriptions,
      });

      if (candidates.length > 0) {
        logger.info(
          "Precipitation",
          `Extracted ${candidates.length} new skill(s): ${candidates.map((c) => c.name).join(", ")}`,
        );
      } else {
        logger.info("Precipitation", "No new skills extracted.");
      }

      return candidates.map((c) => c.name);
    } catch (err: unknown) {
      logger.warn(
        "Precipitation",
        `Skill precipitation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
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
      systemPrompt: PRECIPITATION_SYSTEM_PROMPT,
      toolRegistry: tools,
      maxIterations: this.maxIterations,
    });

    return agent.run(userPrompt);
  }

  // ─── Private: Prompt Building ──────────────────────────────────────────

  /**
   * Build the task prompt for the sub-agent from the precipitation input.
   */
  private buildTaskPrompt(input: PrecipitationInput): string {
    const parts = [
      "Please review this agent session and extract reusable skills.",
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
      "=== Existing Skills (do NOT duplicate these) ===",
      ...this.formatExistingSkills(
        input.existingSkillNames,
        input.existingSkillDescriptions,
      ),
      "",
      "Extract any reusable patterns and output them as JSON in your final answer.",
    ];

    return parts.join("\n");
  }

  /**
   * Format the conversation for the precipitation prompt.
   * Truncates very long tool results for readability.
   */
  private formatConversation(messages: MessageData[]): string[] {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = msg.content;

      // Truncate long tool results
      if (msg.role === Role.Tool && content.length > 1000) {
        content =
          content.slice(0, 500) +
          "\n... (truncated, " +
          content.length +
          " chars total)";
      }

      lines.push(`[${role}] ${content}`);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          lines.push(
            `  → tool_call: ${tc.function.name}(${tc.function.arguments})`,
          );
        }
      }
    }
    return lines;
  }

  /**
   * Format the existing skills list for dedup awareness.
   * Truncates to the most recent skills if the list is very large.
   */
  private formatExistingSkills(
    names: string[],
    descriptions: Record<string, string>,
  ): string[] {
    if (names.length === 0) return ["(no existing skills)"];

    const MAX_LISTED = 30;
    const truncated =
      names.length > MAX_LISTED
        ? names.slice(0, MAX_LISTED)
        : names;

    const lines: string[] = [];
    for (const name of truncated) {
      const desc = descriptions[name] || "(no description)";
      lines.push(`- ${name}: ${desc}`);
    }

    if (names.length > MAX_LISTED) {
      lines.push(
        `... and ${names.length - MAX_LISTED} more (use read_file/grep_search to inspect if needed)`,
      );
    }

    return lines;
  }

  // ─── Private: Parsing ──────────────────────────────────────────────────

  /**
   * Parse the sub-agent's final answer into a list of SkillCandidates.
   * Returns an empty array if parsing fails (best-effort).
   */
  private parseCandidates(answer: string): SkillCandidate[] {
    try {
      // Extract JSON from the answer (may be wrapped in ```json fences)
      let raw = answer.trim();
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) raw = fenceMatch[1];

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (!Array.isArray(parsed.skills)) return [];

      const candidates: SkillCandidate[] = [];
      for (const s of parsed.skills as Array<Record<string, unknown>>) {
        if (
          typeof s.name !== "string" ||
          !s.name ||
          typeof s.description !== "string" ||
          !s.description ||
          typeof s.content !== "string" ||
          !s.content
        ) {
          continue;
        }
        candidates.push({
          name: s.name,
          description: s.description,
          content: s.content,
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }

  // ─── Private: Persistence ──────────────────────────────────────────────

  /**
   * Write skill candidates to disk as SKILL.md files.
   * Skips candidates whose name already exists in the SkillManager,
   * or whose name fails validation.
   *
   * @returns Only the candidates that were successfully persisted.
   */
  private async persistCandidates(
    candidates: SkillCandidate[],
  ): Promise<SkillCandidate[]> {
    // Deduplicate by name within this batch
    const seen = new Set<string>();
    const unique: SkillCandidate[] = [];
    for (const c of candidates) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        unique.push(c);
      }
    }

    const persisted: SkillCandidate[] = [];

    for (const c of unique) {
      // Validate name
      try {
        validateSkillName(c.name);
      } catch (err: unknown) {
        this.logger.warn(
          "Precipitation",
          `Rejected skill "${c.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      // Check for duplicates in the SkillManager
      if (this.skillManager.has(c.name)) {
        this.logger.info(
          "Precipitation",
          `Skipping "${c.name}" — already registered.`,
        );
        continue;
      }

      try {
        const skillDir = path.join(this.skillsDir, c.name);
        fs.mkdirSync(skillDir, { recursive: true });

        const frontmatter = [
          "---",
          `name: ${c.name}`,
          `description: ${c.description}`,
          "precipitated: true",
          "---",
          "",
          c.content,
        ].join("\n");

        const filePath = path.join(skillDir, "SKILL.md");
        fs.writeFileSync(filePath, frontmatter, "utf-8");

        this.logger.info(
          "Precipitation",
          `Written: ${filePath}`,
        );
        persisted.push(c);
      } catch (err: unknown) {
        this.logger.warn(
          "Precipitation",
          `Failed to write skill "${c.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Reload newly written skills into the SkillManager
    if (persisted.length > 0) {
      this.skillManager.reloadFromDirectory(this.skillsDir);
    }

    return persisted;
  }
}
