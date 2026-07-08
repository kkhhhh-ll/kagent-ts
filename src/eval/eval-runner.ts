import type { LLMProvider, LLMResponse } from "../llm/interface";
import type { MessageData } from "../messages/types";
import { Role } from "../messages/types";
import { ToolCallEvaluator } from "./tool-call-evaluator";
import type { EvalCase, EvalResult, LLMEvalJudgment } from "./types";

// ─── Re-export for convenience ─────────────────────────────────────────────

export type { EvalCase, EvalResult, LLMEvalJudgment } from "./types";

/**
 * An agent factory — called once per eval case to create a fresh agent
 * with a ToolCallEvaluator hook attached.
 */
export type AgentFactory = (evaluator: ToolCallEvaluator) => {
  run(input: string): Promise<string>;
  cancel(): void;
};

/**
 * Configuration for the EvalRunner.
 */
export interface EvalRunnerConfig {
  /**
   * Default timeout per case in milliseconds.
   * Cases can override with their own `timeoutMs`.
   * Default: 120_000 (2 minutes).
   */
  defaultTimeoutMs?: number;

  /**
   * Optional LLM provider for answer quality judging.
   * When set, each case's final answer is independently evaluated.
   *
   * Using a different model than the agent's own LLM provides an
   * unbiased quality assessment. Pass `router.forReflection()` from
   * a ModelRouter for this purpose.
   */
  judgeLLM?: LLMProvider;
}

// ─── LLM Judge System Prompt ──────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluation judge. Your job is to assess the quality
of an AI agent's answer to a user query.

Evaluate the answer across these dimensions:
- **Correctness**: Is the answer factually correct?
- **Completeness**: Does it fully address the user's query?
- **Clarity**: Is the answer well-structured and easy to understand?
- **Efficiency**: Did the agent use a reasonable approach? Any obvious wasted effort?

Output a JSON object:
{
  "passed": true/false,
  "score": 0-100,
  "reasoning": "brief explanation (1-3 sentences)",
  "issues": ["issue 1", "issue 2"]  // empty array if no issues
}`;

/**
 * EvalRunner — runs test cases against an agent and produces pass/fail results.
 *
 * Uses an agent factory so each case starts fresh (no context pollution between
 * cases). The factory receives a ToolCallEvaluator hook to collect metrics.
 *
 * Usage:
 * ```ts
 * const runner = new EvalRunner({ judgeLLM: router.forReflection() });
 *
 * const results = await runner.run(
 *   (evaluator) => new ReActAgent({ llm, hooks: [evaluator] }),
 *   [
 *     { name: "basic math", input: "2+2=?", expectedTools: ["calculator"] },
 *     { name: "file read", input: "read README.md", expectedTools: ["read_file"] },
 *   ],
 * );
 *
 * console.log(runner.generateReport(results));
 * ```
 */
export class EvalRunner {
  private defaultTimeoutMs: number;
  private judgeLLM?: LLMProvider;

  constructor(config?: EvalRunnerConfig) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120_000;
    this.judgeLLM = config?.judgeLLM;
  }

  /**
   * Run a batch of evaluation cases.
   *
   * @param factory Creates a fresh agent for each case. Receives a
   *                ToolCallEvaluator hook that MUST be attached to the
   *                agent's hooks array.
   * @param cases   The test cases to run.
   * @returns One EvalResult per case.
   */
  async run(
    factory: AgentFactory,
    cases: EvalCase[],
  ): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const c of cases) {
      const evaluator = new ToolCallEvaluator();
      const agent = factory(evaluator);
      const caseTimeout = c.timeoutMs ?? this.defaultTimeoutMs;
      const startedAt = Date.now();

      let answer: string;
      let iterations = 0;
      const toolCalls: string[] = [];
      const failures: string[] = [];

      try {
        answer = await withTimeout(agent.run(c.input), caseTimeout);

        // Collect tool calls from the evaluator
        for (const r of evaluator.getRecords()) {
          if (r.endTime) toolCalls.push(r.toolName);
        }
        iterations = toolCalls.length;

        // ── Checks ──────────────────────────────────────────────────

        if (c.expectedTools && c.expectedTools.length > 0) {
          for (const expected of c.expectedTools) {
            if (!toolCalls.includes(expected)) {
              failures.push(
                `Expected tool "${expected}" was not called.`,
              );
            }
          }
        }

        if (c.forbiddenTools && c.forbiddenTools.length > 0) {
          for (const forbidden of c.forbiddenTools) {
            if (toolCalls.includes(forbidden)) {
              failures.push(
                `Forbidden tool "${forbidden}" was called.`,
              );
            }
          }
        }

        if (c.expectedOutput) {
          const pattern = c.expectedOutput;
          const matches =
            typeof pattern === "string"
              ? answer.includes(pattern)
              : pattern.test(answer);
          if (!matches) {
            failures.push(
              `Answer does not match expected pattern: "${pattern}".`,
            );
          }
        }
      } catch (err: unknown) {
        // Stop the agent to prevent resource leaks (e.g., orphaned LLM calls
        // or tool executions continuing after timeout).
        agent.cancel();

        answer = err instanceof Error ? err.message : String(err);
        failures.push(`Execution error: ${answer}`);
      }

      const durationMs = Date.now() - startedAt;
      const scorecard = evaluator.getScorecard();

      // ── LLM Judging ───────────────────────────────────────────────
      let llmJudgment: LLMEvalJudgment | undefined;
      if (this.judgeLLM && failures.length === 0) {
        try {
          llmJudgment = await this.judgeAnswer(c.input, answer);
        } catch {
          // Judge failed — leave judgment undefined
        }
      }

      if (llmJudgment && !llmJudgment.passed) {
        failures.push(
          `LLM judge (score ${llmJudgment.score}/100): ${llmJudgment.reasoning}`,
        );
      }

      results.push({
        caseName: c.name,
        passed: failures.length === 0,
        answer,
        toolCalls,
        iterations,
        durationMs,
        scorecard,
        llmJudgment,
        failures,
      });
    }

    return results;
  }

  /**
   * Run a single case and return the result (convenience method).
   */
  async runCase(
    factory: AgentFactory,
    c: EvalCase,
  ): Promise<EvalResult> {
    const results = await this.run(factory, [c]);
    return results[0];
  }

  /**
   * Generate a Markdown report from evaluation results.
   */
  generateReport(results: EvalResult[]): string {
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";
    const avgLatency =
      total > 0
        ? Math.round(
            results.reduce((s, r) => s + r.durationMs, 0) / total,
          )
        : 0;

    let report = `# Evaluation Report\n\n`;
    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Cases | ${total} |\n`;
    report += `| Passed | ${passed} |\n`;
    report += `| Failed | ${total - passed} |\n`;
    report += `| Pass Rate | ${passRate}% |\n`;
    report += `| Avg Duration | ${avgLatency}ms |\n\n`;

    report += `## Results\n\n`;

    for (const r of results) {
      const icon = r.passed ? "✅" : "❌";
      report += `### ${icon} ${r.caseName}\n\n`;
      report += `- **Duration:** ${r.durationMs}ms\n`;
      report += `- **Tool calls:** ${r.toolCalls.join(", ") || "(none)"}\n`;
      report += `- **Tool success rate:** ${(r.scorecard.overallSuccessRate * 100).toFixed(1)}%\n`;

      if (r.llmJudgment) {
        report += `- **Judge score:** ${r.llmJudgment.score}/100\n`;
        if (r.llmJudgment.issues.length > 0) {
          report += `- **Issues:**\n`;
          for (const issue of r.llmJudgment.issues) {
            report += `  - ${issue}\n`;
          }
        }
      }

      if (r.failures.length > 0) {
        report += `- **Failures:**\n`;
        for (const f of r.failures) {
          report += `  - ${f}\n`;
        }
      }

      report += `\n<details>\n<summary>Answer</summary>\n\n${r.answer}\n\n</details>\n\n`;
    }

    report += `---\n*Generated at ${new Date().toISOString()}*\n`;
    return report;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async judgeAnswer(
    query: string,
    answer: string,
  ): Promise<LLMEvalJudgment> {
    if (!this.judgeLLM) {
      return { passed: true, score: 100, reasoning: "", issues: [] };
    }

    const messages: MessageData[] = [
      { role: Role.System, content: JUDGE_SYSTEM_PROMPT },
      {
        role: Role.User,
        content: [
          `User query: ${query}`,
          ``,
          `Agent answer: ${answer}`,
          ``,
          `Please evaluate the answer quality. Output JSON only.`,
        ].join("\n"),
      },
    ];

    const response: LLMResponse = await this.judgeLLM.chat(messages);
    return this.parseJudgment(response.content);
  }

  private parseJudgment(raw: string): LLMEvalJudgment {
    try {
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) json = fenceMatch[1];

      const parsed = JSON.parse(json);

      return {
        passed: Boolean(parsed.passed),
        score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
        reasoning: String(parsed.reasoning ?? ""),
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.map(String)
          : [],
      };
    } catch {
      return {
        passed: true,
        score: 50,
        reasoning: "Could not parse judge response.",
        issues: [],
      };
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs / 1000}s.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
