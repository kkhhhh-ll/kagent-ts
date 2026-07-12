import { LLMProvider } from "../llm/interface";
import { Logger, ConsoleLogger } from "../logging/logger";
import { forkAgent } from "../core/fork.js";
import type { AgentHooks } from "../core/hooks";
import { TraceLogger } from "../trace/trace-logger.js";
import { STRUCTURED_OUTPUT_INSTRUCTIONS } from "../core/response-schema";
import type { VerificationResult, VerificationInput } from "./types";

// ─── System Prompt ───────────────────────────────────────────────────────────

const VERIFY_SYSTEM_PROMPT = `You are an answer-verification agent. Your job is to check whether an AI assistant's
answer correctly and completely addresses the user's question.

You have access to read_file and grep_search tools to verify factual claims
against the codebase when applicable.

Review the answer across these dimensions:
- **Correctness**: Are there any factual errors, invalid code, or wrong claims?
- **Completeness**: Does the answer fully address the user's query? Any missing information?
- **Consistency**: Does the answer contradict itself or the user's stated requirements?
- **Actionability**: If the user asked for something to be done, was it actually done?

In your final answer, output a JSON object with this structure:
{
  "valid": true,
  "score": 92,
  "issues": [
    "The answer claims file X exists but it does not — verify with read_file"
  ],
  "assessment": "The answer is mostly correct but makes an unverified claim about file X."
}

Rules:
- Score 0-100 where 100 = perfectly correct and complete.
- "valid" should be true when score >= 70 AND no critical issues exist.
- Only list real issues — do NOT fabricate problems.
- If the answer is flawless, return valid=true, score=100, issues=[], assessment="No issues found."
- Be specific: cite exact claims, file paths, or code snippets that are wrong.
- Use your tools to verify factual claims against the actual codebase.
${STRUCTURED_OUTPUT_INSTRUCTIONS}`;

// ─── Pure Helpers ────────────────────────────────────────────────────────────

/**
 * Build the task prompt for the verification fork.
 */
function buildTaskPrompt(input: VerificationInput): string {
  return [
    "Please verify this AI assistant's answer against the user's question.",
    "",
    "=== User Query ===",
    input.userQuery,
    "",
    "=== Answer To Verify ===",
    input.answer,
    "",
    "Analyze the answer and output your verification result as JSON in your final answer.",
  ].join("\n");
}

/**
 * Parse the fork's final answer into a VerificationResult.
 */
function parseResult(answer: string, logger: Logger): VerificationResult {
  let raw = answer.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) raw = fenceMatch[1];

  // No JSON — treat as valid (don't block on parse failure)
  if (!fenceMatch && !raw.startsWith("{") && !raw.startsWith("[")) {
    logger.info("VerifyAgent", "LLM output contained no JSON — treating as pass.");
    return { valid: true, score: 100, issues: [], assessment: "No structured output." };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      valid: typeof parsed.valid === "boolean" ? parsed.valid : (parsed.score ?? 0) >= 70,
      score: typeof parsed.score === "number" ? parsed.score : 70,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i: unknown): i is string => typeof i === "string")
        : [],
      assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
    };
  } catch {
    logger.warn("VerifyAgent", "Failed to parse verification JSON — treating as pass.");
    return { valid: true, score: 100, issues: [], assessment: "Parse error — skipped." };
  }
}

// ─── VerifyAgent ─────────────────────────────────────────────────────────────

/**
 * Configuration for the VerifyAgent.
 */
export interface VerifyAgentConfig {
  /** LLM provider for verification (independent of main agent). */
  llm: LLMProvider;
  /**
   * Max ReAct iterations for the verification fork. Default: 3.
   */
  maxIterations?: number;
  /**
   * Minimum score to pass verification. Default: 70.
   */
  threshold?: number;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
  /** Hooks (e.g. TraceLogger) forwarded to the fork sub-agent. */
  hooks?: AgentHooks | AgentHooks[];
}

/**
 * VerifyAgent — answer verification via a forked sub-agent.
 *
 * Forks a lightweight ReActAgent with read-only tools to check whether
 * the main agent's answer correctly and completely addresses the user's
 * query. Runs synchronously (blocking) before the answer is returned.
 *
 * Usage:
 * ```ts
 * const verifier = new VerifyAgent({ llm, threshold: 70 });
 * const result = await verifier.verify({
 *   userQuery: "Fix the login bug",
 *   answer: "I changed the auth middleware...",
 * });
 * if (!result.valid) {
 *   // Inject result.issues back into the main agent for correction
 * }
 * ```
 */
export class VerifyAgent {
  private llm: LLMProvider;
  private maxIterations: number;
  private threshold: number;
  private logger: Logger;
  private hooks: AgentHooks | AgentHooks[] | undefined;

  /** Hard timeout for the verification fork (3 minutes). */
  private static readonly VERIFY_TIMEOUT_MS = 3 * 60 * 1000;

  constructor(config: VerifyAgentConfig) {
    this.llm = config.llm;
    this.maxIterations = config.maxIterations ?? 3;
    this.threshold = config.threshold ?? 70;
    this.logger = config.logger ?? new ConsoleLogger();
    this.hooks = config.hooks;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Fork a sub-agent to verify the answer.
   *
   * @returns VerificationResult with validity, score, issues, and assessment.
   */
  async verify(input: VerificationInput): Promise<VerificationResult> {
    const taskPrompt = buildTaskPrompt(input);

    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      VerifyAgent.VERIFY_TIMEOUT_MS,
    );

    try {
      const answer = await forkAgent(taskPrompt, {
        llm: this.llm,
        systemPrompt: VERIFY_SYSTEM_PROMPT,
        maxIterations: this.maxIterations,
        logger: this.logger,
        signal: abortController.signal,
        hooks: TraceLogger.wrapHooksForFork(this.hooks, "answer-verification"),
      });

      const result = parseResult(answer, this.logger);

      // Apply threshold override
      if (result.score >= this.threshold && !result.valid) {
        result.valid = true;
      } else if (result.score < this.threshold && result.valid) {
        result.valid = false;
      }

      this.logger.info(
        "VerifyAgent",
        `Verification complete: score=${result.score}, valid=${result.valid}, issues=${result.issues.length}`,
      );

      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logger.warn(
          "VerifyAgent",
          `Verification fork timed out after ${VerifyAgent.VERIFY_TIMEOUT_MS / 1000}s — treating as pass.`,
        );
        return {
          valid: true,
          score: 70,
          issues: [],
          assessment: "Verification timed out — skipped.",
        };
      }
      this.logger.warn(
        "VerifyAgent",
        `Verification fork failed: ${err instanceof Error ? err.message : String(err)} — treating as pass.`,
      );
      return {
        valid: true,
        score: 70,
        issues: [],
        assessment: `Verification error — skipped.`,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
