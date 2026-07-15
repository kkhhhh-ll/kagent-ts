import { LLMProvider } from "../llm/interface";
import { MessageData, Role } from "../messages/types";
import { extractJSON } from "../core/response-schema";
import { SkillManager } from "../skills/skill-manager";
import { Logger, ConsoleLogger } from "../logging/logger";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { forkAgent } from "../core/fork.js";
import type { AgentHooks } from "../core/hooks";
import { TraceLogger } from "../trace/trace-logger.js";
import { validateSkillName, buildSkillMarkdown } from "../skills/skill-utils";

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
  /**
   * Keywords for fast-path intent matching. When the user's input
   * contains any keyword, the skill is auto-activated without an
   * LLM `skill` tool call. 3-8 lowercase words/phrases recommended.
   */
  keywords: string[];
  /** Full system prompt body (markdown, goes after the frontmatter). */
  content: string;
  /**
   * Extractor's self-assessed confidence (0.0-1.0).
   * 0.9+ = verified with tools, 0.5 = plausible but unverified, <0.3 = speculative.
   */
  confidence?: number;
  /** Files/docs that ground this skill (paths relative to project root). */
  references?: string[];
  /** Reusable command sequences (markdown code block). */
  scripts?: string;
  /** Boilerplate code/config (markdown code block). */
  templates?: string;
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
  /** Hooks (e.g. TraceLogger) forwarded to the fork sub-agent. */
  hooks?: AgentHooks | AgentHooks[];
  /** Max iterations per skill-verification fork (default: 8). */
  skillVerificationMaxIterations?: number;
  /** Verify skills before persisting (default: true). */
  verifySkills?: boolean;
  /** LLM for skill verification (default: reuse llm). */
  skillVerificationLLM?: LLMProvider;
}

/**
 * Structured JSON output expected from the fork sub-agent's final answer.
 * Used as the parsing target in {@link parseCandidates} so TypeScript
 * validates the shape at compile time.
 */
interface PrecipitationResponse {
  analysis: string;
  /** Preferred key — matches the system prompt's OUTPUT FORMAT. */
  candidate_skills?: SkillCandidate[];
  /** Legacy key — accepted for backward compatibility with older prompts. */
  skills?: SkillCandidate[];
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const PRECIPITATION_SYSTEM_PROMPT = `You are a skill-extraction agent. Your job is to review a completed agent session and extract **candidate** reusable patterns as structured skill definitions.

You have access to read_file and grep_search tools to verify your findings against the actual codebase.

**Your role is to be exploratory and generative** — cast a wide net. A separate VerifyAgent will later evaluate quality and decide what gets persisted. Don't over-filter; it's better to propose a candidate that gets rejected than to miss something valuable.

Skills are reusable workflow templates that capture "how to do X in this project." They are loaded as system prompt instructions in future sessions.

---

**EXTRACTION DIMENSIONS — Look for these in the session:**

1. **Reusable patterns** — Workflows, strategies, or tool-combinations that worked well
   - Examples: deployment pipeline, database migration setup, CI debugging

2. **Domain knowledge** — Project-specific facts, conventions, or constraints
   - Examples: API rate limits, required config files, naming conventions

3. **Tool usage insight** — Effective ways of using specific tools
   - Examples: "grep_search before read_file to locate the right file"

4. **Error recovery patterns** — Failures with reliable fixes
   - Examples: "When migration fails with lock timeout, run VACUUM first"

---

**SKILL STRUCTURE:**

| Field | Required | Description |
|:---|:---|:---|
| \`name\` | ✅ | kebab-case, unique, descriptive |
| \`description\` | ✅ | "When you need to [scenario], use this skill. It covers [what]." |
| \`keywords\` | ✅ | 3-8 lowercase words/phrases for semantic matching |
| \`content\` | ✅ | Markdown instructions. Structure: ## Prerequisites, ## Step-by-step, ## Verification, ## Common pitfalls |
| \`confidence\` | ✅ | 0.0-1.0 — how confident are you this skill is accurate and useful? Base this on: (a) did you verify with tools? (b) is the pattern repeated or one-off? (c) is it specific or vague? |
| \`references\` | ⚠️ | Files/docs that ground this skill. Include when useful. |
| \`scripts\` | ⚠️ | Reusable command sequences as a string with code block (e.g., "\`\`\`bash\\ncommand\\n\`\`\`"). Include when non-trivial. |
| \`templates\` | ⚠️ | Boilerplate code/config as a string with code block (e.g., "\`\`\`python\\ntemplate\\n\`\`\`"). Include when scaffolding is needed. |

---

**GUIDING PRINCIPLES:**

- **Be generous** — propose a skill if you see *any* reusable pattern. The VerifyAgent will reject false positives.
- **Be honest about uncertainty** — use \`confidence\` to reflect how well you could verify claims. 0.9+ = verified with tools, 0.5 = plausible but unverified, <0.3 = speculative.
- **Avoid obvious duplicates** — check the provided existing skills list. If a skill covers the same domain, don't propose a duplicate unless your skill adds genuinely new information.
- **Maximum 3 candidate skills per session** — still keep quality over quantity, but err on the side of inclusion.

---

**OUTPUT FORMAT:**

{
  "analysis": "brief assessment — what was learned, what patterns emerged (2-3 sentences)",
  "candidate_skills": [
    {
      "name": "kebab-case-unique-name",
      "description": "When you need to [X], use this skill. It covers [Y].",
      "keywords": ["word1", "word2", "word3", "word4", "word5"],
      "content": "## Prerequisites\\n- ...\\n\\n## Step-by-step\\n1. ...\\n\\n## Verification\\n- ...\\n\\n## Common pitfalls\\n- ...",
      "confidence": 0.85,
      "references": ["path/to/file.py"],
      "scripts": "string containing bash commands with code block markers",
      "templates": "string containing python template with code block markers"
    }
  ]
}

---

**RULES:**

- Use your tools (read_file, grep_search) to verify claims. If unverifiable, lower confidence.
- Each skill's description MUST use: "When you need to [X], use this skill. It covers [Y]."
- Output ONLY the JSON object — no natural language, no markdown code fences.
- Only include optional fields (references, scripts, templates) when they add value.
- Maximum 3 skills. If nothing worth saving, return {"analysis": "...", "candidate_skills": []}.`;

// ─── Pure Helpers ────────────────────────────────────────────────────────────

/** Characters to keep from the start of a truncated tool result. */
const TRUNCATION_RETAIN = 500;
/** Tool result longer than this will be truncated. */
const TRUNCATION_THRESHOLD = TRUNCATION_RETAIN * 2;
/** Max number of existing skills to list in the prompt. */
const MAX_EXISTING_SKILLS_LISTED = 30;

/**
 * Format the conversation for the precipitation prompt.
 * Truncates very long tool results for readability.
 */
function formatConversation(messages: MessageData[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    let content = msg.content ?? "";

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
function formatExistingSkills(
  names: string[],
  descriptions: Record<string, string>,
): string[] {
  if (names.length === 0) return ["(no existing skills)"];

  const truncated =
    names.length > MAX_EXISTING_SKILLS_LISTED
      ? names.slice(0, MAX_EXISTING_SKILLS_LISTED)
      : names;

  const lines: string[] = [];
  for (const name of truncated) {
    const desc = descriptions[name] || "(no description)";
    lines.push(`- ${name}: ${desc}`);
  }

  if (names.length > MAX_EXISTING_SKILLS_LISTED) {
    lines.push(
      `... and ${names.length - MAX_EXISTING_SKILLS_LISTED} more (use read_file/grep_search to inspect if needed)`,
    );
  }

  return lines;
}

/**
 * Build the task prompt for the fork sub-agent from the precipitation input.
 */
function buildTaskPrompt(input: PrecipitationInput): string {
  return [
    "Please review this agent session and extract reusable skills.",
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
    "=== Existing Skills (do NOT duplicate these) ===",
    ...formatExistingSkills(
      input.existingSkillNames,
      input.existingSkillDescriptions,
    ),
    "",
    "Extract any reusable patterns and output them as JSON in your final answer.",
  ].join("\n");
}

/**
 * Parse the sub-agent's final answer into a list of SkillCandidates.
 *
 * @returns Parsed candidates (may be empty if no skills were found).
 * @throws {Error} If the LLM output cannot be parsed as valid JSON —
 *         this is a fatal error that the caller must handle, distinct
 *         from the "no skills extracted" case.
 */
function parseCandidates(answer: string, logger: Logger): SkillCandidate[] {
  // Extract JSON from the answer using the framework's robust parser
  // (handles nested fences, markdown noise, malformed newlines).
  const json = extractJSON(answer);

  // No JSON at all — the LLM chose not to output structured data.
  // This is not an error; it means the LLM decided nothing was worth
  // extracting. Return empty rather than throwing.
  if (!json) {
    logger.info(
      "Precipitation",
      "LLM output contained no JSON — no skills extracted.",
    );
    return [];
  }

  let parsed: PrecipitationResponse;

  try {
    parsed = JSON.parse(json) as PrecipitationResponse;
  } catch (err: unknown) {
    // JSON was found but is malformed — this IS a bug (LLM violated
    // the output contract). Throw so the caller can distinguish.
    throw new Error(
      `Failed to parse skill candidates from LLM output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed.analysis === "string" && parsed.analysis) {
    logger.info("Precipitation", `Analysis: ${parsed.analysis}`);
  }

  // The system prompt asks for `candidate_skills`; accept the legacy
  // `skills` key too so older prompt variants keep working.
  const rawSkills = parsed.candidate_skills ?? parsed.skills;
  if (!Array.isArray(rawSkills)) return [];

  const candidates: SkillCandidate[] = [];
  for (const s of rawSkills) {
    if (
      typeof s.name !== "string" ||
      !s.name ||
      typeof s.description !== "string" ||
      !s.description ||
      typeof s.content !== "string" ||
      !s.content
    ) {
      logger.warn(
        "Precipitation",
        `Skipping malformed skill candidate: missing or empty required field. Got: ${JSON.stringify({ name: s.name, description: s.description, hasContent: typeof s.content === "string" && !!s.content })}`,
      );
      continue;
    }
    // Parse keywords: accept string[] or comma-separated string
    const kwRaw: unknown = s.keywords;
    let keywords: string[] = [];
    if (Array.isArray(kwRaw)) {
      keywords = kwRaw
        .map((k: unknown) => String(k).trim().toLowerCase())
        .filter(Boolean);
    } else if (typeof kwRaw === "string") {
      keywords = kwRaw
        .split(",")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
    }

    // Optional enrichment fields — validate loosely and drop when malformed
    // (a bad optional field should not reject the whole candidate).
    const confidence =
      typeof s.confidence === "number" && s.confidence >= 0 && s.confidence <= 1
        ? s.confidence
        : undefined;
    const references = Array.isArray(s.references)
      ? s.references.map((r: unknown) => String(r).trim()).filter(Boolean)
      : undefined;
    const scripts =
      typeof s.scripts === "string" && s.scripts.trim() ? s.scripts : undefined;
    const templates =
      typeof s.templates === "string" && s.templates.trim() ? s.templates : undefined;

    candidates.push({
      name: s.name,
      description: s.description,
      keywords,
      content: s.content,
      confidence,
      references: references && references.length > 0 ? references : undefined,
      scripts,
      templates,
    });
  }

  return candidates;
}

// ─── Skill Verification ──────────────────────────────────────────────────────

/** Structured output from skill verification fork. */
interface SkillVerifyResult {
  valid: boolean;
  score: number;
  issues: string[];
}

const SKILL_VERIFY_SYSTEM_PROMPT = `You are a skill-quality reviewer. Your job is to evaluate a **candidate** skill extracted from an agent session and decide whether it's worth persisting to the knowledge base.

You have access to read_file and grep_search tools to verify claims against the actual codebase.

---

**INPUT YOU WILL RECEIVE:**
- \`candidate\`: The skill proposed by ExtractionAgent (includes \`name\`, \`description\`, \`keywords\`, \`content\`, \`confidence\`, \`references\`, \`scripts\`, \`templates\`)
- \`existing_skills\`: List of already-persisted skills (names + summaries)
- \`session_transcript\`: The original conversation (for fact-checking)

---

**EVALUATION DIMENSIONS (Score 0-100):**

| Dimension | Weight | What to Check |
|:---|:---|:---|
| **Factual Accuracy** | 30% | Do claims match the codebase? Check \`references\` files exist and content matches. Check commands actually work. Cross-check against \`session_transcript\` — did this pattern actually emerge or is the agent hallucinating? |
| **Actionability** | 25% | Can a future LLM follow this without additional research? Are steps numbered? Are commands copy-pasteable? Are file paths absolute or relative to project root? |
| **Novelty vs Existing** | 20% | Does this add NEW knowledge? Compare against \`existing_skills\`. If 80%+ overlap → reject or suggest merge. Also check for **contradictions** — does this skill conflict with any existing skill? |
| **Completeness** | 15% | Are optional fields (\`references\`, \`scripts\`, \`templates\`) used appropriately? If a script is mentioned in \`content\`, is it also included in \`scripts\`? If files are referenced, are they listed in \`references\`? |
| **Confidence Calibration** | 10% | Does the candidate's \`confidence\` match your assessment? If ExtractionAgent gave 0.9 but you found errors → flag overconfidence. If 0.3 but content is solid → flag underconfidence (signals ExtractionAgent needs tuning). |

---

**DECISION RULES:**

| Score Range | Decision | Action |
|:---|:---|:---|
| 80-100 | ✅ **Pass** | Persist as-is (or with minor suggestions) |
| 60-79 | ⚠️ **Conditional Pass** | Persist but flag \`warnings\` — future users should be cautious |
| 40-59 | 🔄 **Suggest Merge** | If overlapping with existing skill, recommend merging. If novel but incomplete, recommend revision. |
| 0-39 | ❌ **Reject** | Not worth keeping. Provide specific reasons. |

---

**OUTPUT FORMAT:**

{
  "decision": "conditional",
  "valid": true,
  "score": 72,
  "verification_summary": "2-3 sentences summarizing what you verified and found",
  "issues": [
    "Step 2 references \`scripts/deploy.sh\` but this file does not exist in the codebase",
    "Command in step 4 uses \`--force\` flag without warning — this is dangerous"
  ],
  "warnings": [
    "This skill overlaps 70% with \`deployment-pipeline\` skill. Consider merging rather than adding separately."
  ],
  "suggestions": [
    "Add \`--dry-run\` as first step to prevent accidental deploys",
    "Reference the actual path: \`./scripts/deploy.sh\` instead of \`deploy.sh\`"
  ],
  "merge_target": null,
  "confidence_gap": {
    "candidate_confidence": 0.85,
    "reviewer_assessment": 0.65,
    "note": "Candidate overestimated verifiability — 2 of 3 file references were incorrect"
  }
}

---

**SPECIFIC CHECKS TO RUN:**

1. **References validation** — For each path in \`references\`:
   - Does the file exist? (\`read_file\` or \`grep_search\`)
   - Does the content match what the skill claims?
   - If a line range is specified (e.g., \`file.py#L10-L25\`), verify the claim matches that range.

2. **Scripts validation** — For each script in \`scripts\`:
   - Is it syntactically valid? (check shebang, basic syntax)
   - Do the commands match patterns used in the codebase?
   - Are there any dangerous flags (e.g., \`rm -rf\`, \`DROP TABLE\`) without warnings?

3. **Templates validation** — For each template in \`templates\`:
   - Does it match the structure of existing files of that type?
   - Are placeholders clearly marked (e.g., \`{{PROJECT_NAME}}\` vs hardcoded values)?

4. **Session fact-checking** — For key claims in \`content\`:
   - Did this pattern actually emerge in \`session_transcript\`?
   - Was the problem solved this way, or did the agent propose it but never execute it?
   - If the skill describes "what went wrong" — did that error actually occur in the session?

5. **Conflict detection** — For each \`existing_skill\`:
   - Does this candidate contradict any existing skill? (e.g., one says "use pip", another says "use poetry")
   - If contradiction exists, flag it in \`issues\` with \`[CONFLICT]\` prefix.

---

**RULES:**
- Score 0-100. \`decision\` must be one of: \`"pass"\`, \`"conditional"\`, \`"merge"\`, \`"reject"\`.
- \`valid\` must be \`true\` only for \`"pass"\` / \`"conditional"\` decisions, and \`false\` for \`"merge"\` / \`"reject"\`.
- \`merge_target\` is the name of the existing skill to merge into (string) for \`"merge"\` decisions, otherwise \`null\`.
- Be **specific** in \`issues\` — cite exact claims that are wrong. Don't say "step 3 is vague", say "step 3 says 'adjust the config' but doesn't specify which config or what to adjust".
- Use your tools to verify claims. If you can't verify something (e.g., external API behavior), note it as \`[unverifiable]\` in \`warnings\`.
- Don't fabricate issues. If the skill is solid, pass it with high score and minimal issues.
- For \`merge\` decisions, specify \`merge_target\` — which existing skill should absorb this candidate.
- Output ONLY the JSON object — no natural language, no markdown code fences.

**SELF-CHECK:**
[ ] Did I verify every file path in \`references\`?
[ ] Did I compare against \`existing_skills\` for duplication AND contradiction?
[ ] Did I check the session transcript for factual grounding?
[ ] Did I provide actionable \`suggestions\` if score < 80?
[ ] Is the output valid JSON?`;

/**
 * Build the verification prompt for a single skill candidate.
 */
function buildVerifyPrompt(
  candidate: SkillCandidate,
  input: PrecipitationInput,
): string {
  return [
    "Please review this skill candidate extracted from an agent session.",
    "",
    "=== Skill Candidate ===",
    `Name: ${candidate.name}`,
    `Description: ${candidate.description}`,
    `Keywords: ${candidate.keywords.join(", ")}`,
    `Confidence (extractor's self-assessment): ${candidate.confidence ?? "(not provided)"}`,
    ...(candidate.references && candidate.references.length > 0
      ? [`References:`, ...candidate.references.map((r) => `- ${r}`)]
      : [`References: (none provided)`]),
    ...(candidate.scripts ? [`Scripts:`, candidate.scripts] : []),
    ...(candidate.templates ? [`Templates:`, candidate.templates] : []),
    `Content:`,
    candidate.content,
    "",
    "=== Original User Query ===",
    input.userQuery,
    "",
    "=== Existing Skills (check for duplication) ===",
    ...input.existingSkillNames.map(
      (n) =>
        `- ${n}: ${input.existingSkillDescriptions[n] || "(no description)"}`,
    ),
    "",
    "Review the candidate and output your verdict as JSON.",
  ].join("\n");
}

/**
 * Parse the verification fork's answer into a structured result.
 *
 * Uses the same robust {@link extractJSON} parser as {@link parseCandidates}
 * so that nested code fences, bare JSON, and markdown noise are all handled
 * consistently.  Unlike the precipitation fork the verify agent is a
 * single-candidate, single-answer check — when it doesn't produce a score we
 * should NOT silently default to a passing score; we require an explicit
 * `valid: true` or a numeric `score >= 60` to pass.
 *
 * Fail-open ONLY for genuine parse errors (malformed JSON that
 * `extractJSON` couldn't salvage) — those are infra issues and shouldn't
 * block skill extraction.
 */
function parseVerifyResult(answer: string, logger: Logger): SkillVerifyResult {
  const json = extractJSON(answer);

  // No structured output at all — the verify agent didn't follow the
  // output contract.  Treat as a soft failure: the skill is NOT
  // verified, but we log prominently so operators can tune the prompt.
  if (!json) {
    // Distinguish "hit the ReAct iteration limit" (the loop's canned
    // apology message) from "model ignored the output format" — the
    // former is fixed by raising `skillVerificationMaxIterations`, the
    // latter by tuning the prompt/model.
    const hitIterationLimit = answer.includes(
      "unable to complete the task within",
    );
    if (hitIterationLimit) {
      logger.warn(
        "Precipitation",
        "Skill verify: fork hit its iteration limit before producing a verdict — " +
          "consider raising skillVerificationMaxIterations. Rejecting candidate.",
      );
    } else {
      logger.warn(
        "Precipitation",
        "Skill verify: no JSON in response — verify agent may not be following the output format. " +
          `Rejecting candidate. Raw answer (first 300 chars): ${answer.slice(0, 300)}`,
      );
    }
    return {
      valid: false,
      score: 0,
      issues: [
        hitIterationLimit
          ? "Verification fork hit its iteration limit before producing a verdict."
          : "Verification agent did not produce structured JSON output.",
      ],
    };
  }

  try {
    const parsed = JSON.parse(json);

    const hasExplicitValid = typeof parsed.valid === "boolean";
    const hasScore = typeof parsed.score === "number";
    const issues: string[] = Array.isArray(parsed.issues)
      ? parsed.issues.filter((i: unknown): i is string => typeof i === "string")
      : [];

    // Determine validity:
    //   valid: true  → explicit pass (regardless of score)
    //   score >= 60  → pass by score threshold
    //   neither      → fail (no evidence of quality)
    const valid = hasExplicitValid
      ? parsed.valid
      : hasScore
        ? parsed.score >= 60
        : false;

    const score = hasScore ? parsed.score : 0;

    if (!hasScore && !hasExplicitValid) {
      logger.warn(
        "Precipitation",
        "Skill verify: JSON found but neither 'valid' nor 'score' field present — rejecting by default.",
      );
    }

    return { valid, score, issues };
  } catch {
    // Genuine parse error — `extractJSON` found something that looks like
    // JSON but `JSON.parse` rejected it.  Fail-open to avoid blocking
    // skill extraction on an infra / model glitch.
    logger.warn(
      "Precipitation",
      "Skill verify: parse error — treating as pass (fail-open).",
    );
    return { valid: true, score: 70, issues: [] };
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
  /**
   * Maximum ReAct iterations for each skill-verification fork (default: 8).
   *
   * Verification agents call read_file / grep_search to check claims before
   * producing a JSON verdict.  3 iterations (the previous default) is too
   * tight — a single tool call plus the final answer already burns 2 rounds,
   * and any follow-up read or correction hits the limit immediately.
   */
  skillVerificationMaxIterations?: number;
  /**
   * Verify skill candidates before persisting. Forks an independent agent
   * to check each skill for actionability, self-consistency, and evidence
   * from the session. Default: true.
   */
  verifySkills?: boolean;
  /**
   * LLM provider for skill verification. When omitted, reuses `llm`.
   * Using an independent model here provides unbiased review.
   */
  skillVerificationLLM?: LLMProvider;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
  /** Hooks (e.g. TraceLogger) forwarded to the fork sub-agent. */
  hooks?: AgentHooks | AgentHooks[];
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
  private skillVerificationMaxIterations: number;
  private verifySkills: boolean;
  private skillVerificationLLM?: LLMProvider;
  private logger: Logger;
  private hooks: AgentHooks | AgentHooks[] | undefined;

  /** Hard timeout for the entire precipitation fork (5 minutes). */
  private static readonly PRECIPITATION_TIMEOUT_MS = 5 * 60 * 1000;

  /** Hard timeout for skill verification fork (2 minutes per candidate). */
  private static readonly SKILL_VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

  constructor(config: PrecipitateAgentConfig) {
    this.llm = config.llm;
    this.skillsDir = config.skillsDir;
    this.skillManager = config.skillManager;
    this.maxIterations = config.maxIterations ?? 15;
    this.skillVerificationMaxIterations =
      config.skillVerificationMaxIterations ?? 8;
    this.verifySkills = config.verifySkills ?? true;
    this.skillVerificationLLM = config.skillVerificationLLM;
    this.logger = config.logger ?? new ConsoleLogger();
    this.hooks = config.hooks;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to review the session and extract reusable skills.
   *
   * @returns Skill candidates that were successfully persisted to disk
   *          AND loaded into the SkillManager.
   * @throws If the skills directory does not exist or is not writable.
   * @throws If the precipitation fork times out or fails.
   * @throws If the LLM output cannot be parsed (distinct from "no skills").
   * @throws If skill persistence or reload fails.
   */
  async precipitate(input: PrecipitationInput): Promise<SkillCandidate[]> {
    // Ensure the skills directory exists. Create it if it doesn't —
    // precipitation is best-effort post-hoc work and a missing directory
    // is not a fatal error (mkdir with recursive: true is a no-op if
    // the directory already exists).
    await mkdir(this.skillsDir, { recursive: true });

    const taskPrompt = buildTaskPrompt(input);

    // Enforce a hard timeout so a slow/stuck LLM call can't block
    // the process indefinitely. Precipitation is non-critical post-hoc
    // work — it should fail fast rather than hang forever.
    //
    // An AbortController is used (not just a plain timer) so the
    // timeout signal propagates to the fork → ReActAgent → LLM chat() call,
    // cancelling the in-flight HTTP request and avoiding wasted API quota.
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      PrecipitateAgent.PRECIPITATION_TIMEOUT_MS,
    );

    try {
      const answer = await this.forkAndRun(taskPrompt, abortController.signal);

      const candidates = parseCandidates(answer, this.logger);

      // Verify candidates before persisting
      const verified = await this.verifyCandidates(candidates, input);

      // Persist to disk and reload
      return await this.persistCandidates(verified);
    } catch (err: unknown) {
      // Distinguish "cancelled by timeout" from genuine failures
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Precipitation fork timed out after ${PrecipitateAgent.PRECIPITATION_TIMEOUT_MS / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
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
      skillVerificationMaxIterations: opts.skillVerificationMaxIterations,
      verifySkills: opts.verifySkills,
      skillVerificationLLM: opts.skillVerificationLLM,
      logger: opts.logger,
      hooks: opts.hooks,
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
   *
   * @param signal — forwarded to the fork so the timeout in {@link precipitate}
   *                 can cancel in-flight LLM requests.
   */
  private forkAndRun(
    userPrompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return forkAgent(userPrompt, {
      llm: this.llm,
      systemPrompt: PRECIPITATION_SYSTEM_PROMPT,
      maxIterations: this.maxIterations,
      logger: this.logger,
      signal,
      hooks: TraceLogger.wrapHooksForFork(this.hooks, "precipitation"),
    });
  }

  // ─── Private: Skill Verification ─────────────────────────────────────

  /**
   * Verify each skill candidate before persisting.
   *
   * When {@link verifySkills} is enabled (default), forks an independent
   * agent per candidate to check:
   * - Actionability — is the content concrete enough to be useful?
   * - Self-consistency — are the steps/steps logical and non-contradictory?
   * - Evidence — can the claims be verified against the original session?
   * - Non-duplication — does this meaningfully differ from existing skills?
   *
   * Failed candidates are logged and filtered out. Verification timeout
   * or error → candidate passes (fail-open: don't block on infra issues).
   */
  private async verifyCandidates(
    candidates: SkillCandidate[],
    input: PrecipitationInput,
  ): Promise<SkillCandidate[]> {
    if (!this.verifySkills || candidates.length === 0) return candidates;

    this.logger.info(
      "Precipitation",
      `Verifying ${candidates.length} skill candidate(s)...`,
    );

    const verifyLLM = this.skillVerificationLLM ?? this.llm;
    const results: SkillCandidate[] = [];

    for (const c of candidates) {
      try {
        const passed = await this.verifyOne(c, input, verifyLLM);
        if (passed) {
          results.push(c);
        }
      } catch (err: unknown) {
        // Verification error → fail-open: include the candidate
        this.logger.warn(
          "Precipitation",
          `Skill verification error for "${c.name}": ${err instanceof Error ? err.message : String(err)} — including anyway.`,
        );
        results.push(c);
      }
    }

    const skipped = candidates.length - results.length;
    if (skipped > 0) {
      this.logger.info(
        "Precipitation",
        `${skipped} candidate(s) rejected by verification, ${results.length} passed.`,
      );
    }

    return results;
  }

  /**
   * Verify a single skill candidate by forking a lightweight agent.
   *
   * @returns true if the candidate passes verification.
   */
  private async verifyOne(
    candidate: SkillCandidate,
    input: PrecipitationInput,
    verifyLLM: LLMProvider,
  ): Promise<boolean> {
    const taskPrompt = buildVerifyPrompt(candidate, input);

    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      PrecipitateAgent.SKILL_VERIFY_TIMEOUT_MS,
    );

    try {
      const answer = await forkAgent(taskPrompt, {
        llm: verifyLLM,
        systemPrompt: SKILL_VERIFY_SYSTEM_PROMPT,
        maxIterations: this.skillVerificationMaxIterations,
        logger: this.logger,
        signal: abortController.signal,
        hooks: TraceLogger.wrapHooksForFork(
          this.hooks,
          `skill-verify:${candidate.name}`,
        ),
      });

      const result = parseVerifyResult(answer, this.logger);

      if (result.valid) {
        this.logger.info(
          "Precipitation",
          `Skill "${candidate.name}" verified (score: ${result.score}).`,
        );
        return true;
      }

      this.logger.warn(
        "Precipitation",
        `Skill "${candidate.name}" rejected by verification (score: ${result.score}): ${result.issues.join("; ")}`,
      );
      return false;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logger.warn(
          "Precipitation",
          `Skill verification timed out for "${candidate.name}" — including anyway.`,
        );
        return true; // fail-open
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
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

        const fileContent = buildSkillMarkdown(
          c.name,
          c.description,
          c.content,
          c.keywords,
          {
            confidence: c.confidence,
            references: c.references,
            scripts: c.scripts,
            templates: c.templates,
          },
        );
        const filePath = path.join(skillDir, "SKILL.md");
        await writeFile(filePath, fileContent, "utf-8");

        this.logger.info("Precipitation", `Written: ${filePath}`);
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
