import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { extractJSON } from "../core/response-schema";
import { SkillManager } from "../skills/skill-manager";
import { Logger, ConsoleLogger } from "../logging/logger";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
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
 * Options bag for {@link PrecipitateAgent.runFromAgent}.
 *
 * Replaces the previous 9-positional-parameter signature with a single
 * typed object — call sites are far less error-prone.
 */
export interface RunFromAgentOptions {
  /** The original user query. */
  input: string;
  /** The final answer produced by the agent. */
  answer: string;
  /** Path to the skills directory where SKILL.md files are written. */
  skillsDir: string;
  /** SkillManager for reloading after writes. */
  skillManager: SkillManager;
  /** LLM provider (shared with the main agent). */
  llm: LLMProvider;
  /** Session identifier for traceability. */
  sessionId: string;
  /** Maximum ReAct iterations for the sub-agent. */
  maxIterations: number;
  /** Logger instance. */
  logger: Logger;
  /** Full conversation messages (for context). */
  contextMessages: MessageData[];
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
- You MUST output the JSON object in your final answer — do NOT write natural language instead.`;

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
   * Maximum ReAct iterations for the sub-agent (default: 15).
   */
  maxIterations?: number;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
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
    this.maxIterations = config.maxIterations ?? 15;
    this.logger = config.logger ?? new ConsoleLogger();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Hard timeout for the entire precipitation fork (5 minutes). */
  private static readonly PRECIPITATION_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Fork a sub-agent to review the session and extract reusable skills.
   *
   * @returns Skill candidates that were successfully persisted to disk
   *          AND loaded into the SkillManager.
   * @throws If the skills directory does not exist or is not writable.
   * @throws If the precipitation fork times out or fails.
   * @throws If skill persistence or reload fails.
   */
  async precipitate(input: PrecipitationInput): Promise<SkillCandidate[]> {
    // Validate skillsDir upfront so we don't waste an LLM call on a
    // broken filesystem.
    if (!existsSync(this.skillsDir)) {
      throw new Error(
        `Skills directory does not exist: ${this.skillsDir}`,
      );
    }

    const taskPrompt = this.buildTaskPrompt(input);

    // Enforce a hard timeout so a slow/stuck LLM call can't block
    // the process indefinitely. Precipitation is non-critical post-hoc
    // work — it should fail fast rather than hang forever.
    const answer = await Promise.race([
      this.forkAndRun(taskPrompt),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Precipitation fork timed out after ${PrecipitateAgent.PRECIPITATION_TIMEOUT_MS / 1000}s`)),
          PrecipitateAgent.PRECIPITATION_TIMEOUT_MS,
        ),
      ),
    ]);

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
   * @throws If the skills directory is not configured, or if the
   *         precipitation pipeline encounters a fatal error. Callers
   *         should wrap in try-catch since precipitation is a non-critical
   *         post-execution step.
   */
  static async runFromAgent(opts: RunFromAgentOptions): Promise<string[]> {
    if (!opts.skillsDir) {
      opts.logger.warn("Precipitation", "skillsDir not set — skipping.");
      return [];
    }

    opts.logger.info("Precipitation", "Starting post-hoc skill extraction...");

    const precipitator = new PrecipitateAgent({
      llm: opts.llm,
      skillsDir: opts.skillsDir,
      skillManager: opts.skillManager,
      maxIterations: opts.maxIterations,
      logger: opts.logger,
    });

    const existingSkills = opts.skillManager.getAll();
    const existingSkillNames = existingSkills.map((s) => s.name);
    const existingSkillDescriptions: Record<string, string> = {};
    for (const s of existingSkills) {
      existingSkillDescriptions[s.name] = s.description;
    }

    const candidates = await precipitator.precipitate({
      userQuery: opts.input,
      finalAnswer: opts.answer,
      conversation: opts.contextMessages,
      sessionId: opts.sessionId,
      existingSkillNames,
      existingSkillDescriptions,
    });

    if (candidates.length > 0) {
      opts.logger.info(
        "Precipitation",
        `Extracted ${candidates.length} new skill(s): ${candidates.map((c) => c.name).join(", ")}`,
      );
    } else {
      opts.logger.info("Precipitation", "No new skills extracted.");
    }

    return candidates.map((c) => c.name);
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
      systemPrompt: PRECIPITATION_SYSTEM_PROMPT,
      maxIterations: this.maxIterations,
      logger: this.logger,
    });
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
    /** Characters to keep from the start of a truncated tool result. */
    const TRUNCATION_RETAIN = 500;
    /** Tool result longer than this will be truncated. */
    const TRUNCATION_THRESHOLD = TRUNCATION_RETAIN * 2;

    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = msg.content ?? "";

      // Truncate long tool results
      if (msg.role === Role.Tool && content.length > TRUNCATION_THRESHOLD) {
        content =
          content.slice(0, TRUNCATION_RETAIN) +
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

  /**
   * Escape a value for safe use as a YAML frontmatter single-line string.
   * Newlines are collapsed to spaces because the parser (parseFrontmatter)
   * is line-based and cannot handle multiline YAML strings.
   */
  private yamlValue(value: string): string {
    const single = value.replace(/\n/g, " ").replace(/\r/g, "").trim();
    if (/[:#{}&*!|>'"%@`-]/.test(single) || single.includes(" - ")) {
      return `"${single.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return single;
  }


  /**
   * Parse the sub-agent's final answer into a list of SkillCandidates.
   * Returns an empty array if parsing fails (best-effort — the LLM may
   * produce malformed output).
   */
  private parseCandidates(answer: string): SkillCandidate[] {
    try {
      // Extract JSON from the answer using the framework's robust parser
      // (handles nested fences, markdown noise, malformed newlines).
      const raw = extractJSON(answer) ?? answer;
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (typeof parsed.analysis === "string" && parsed.analysis) {
        this.logger.info("Precipitation", `Analysis: ${parsed.analysis}`);
      }

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
          this.logger.warn(
            "Precipitation",
            `Skipping malformed skill candidate: missing or empty required field (name, description, content). Got: ${JSON.stringify({ name: s.name, description: s.description, hasContent: typeof s.content === "string" && !!s.content })}`,
          );
          continue;
        }
        candidates.push({
          name: s.name,
          description: s.description,
          content: s.content,
        });
      }

      return candidates;
    } catch (err: unknown) {
      this.logger.error(
        "Precipitation",
        `Failed to parse skill candidates from LLM output: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ─── Private: Persistence ──────────────────────────────────────────────

  /**
   * Write skill candidates to disk as SKILL.md files and reload the
   * SkillManager so new skills are immediately available in memory.
   *
   * Skips candidates whose name already exists in the SkillManager,
   * or whose name fails validation.
   *
   * @returns Only the candidates that were successfully persisted
   *          AND loaded into the SkillManager.
   * @throws If skills were written to disk but the SkillManager reload
   *         fails — this leaves the in-memory state inconsistent and
   *         must be surfaced to the caller.
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
        await mkdir(skillDir, { recursive: true });

        const frontmatter = [
          "---",
          `name: ${this.yamlValue(c.name)}`,
          `description: ${this.yamlValue(c.description)}`,
          "precipitated: true",
          "---",
          "",
          c.content,
        ].join("\n");

        const filePath = path.join(skillDir, "SKILL.md");
        await writeFile(filePath, frontmatter, "utf-8");

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

    // Reload newly written skills into the SkillManager.
    // If this fails, the in-memory state is inconsistent with disk —
    // we must surface the error rather than silently returning `persisted`.
    if (persisted.length > 0) {
      try {
        this.skillManager.reloadFromDirectory(this.skillsDir);
      } catch (err: unknown) {
        this.logger.error(
          "Precipitation",
          `Skills written to disk but reload failed — in-memory state is inconsistent: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new Error(
          `Failed to reload SkillManager after writing ${persisted.length} skill(s) to disk: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return persisted;
  }
}
