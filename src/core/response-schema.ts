/**
 * Structured JSON response schema for LLM outputs.
 *
 * Instead of parsing free-text ReAct format (Thought/Action/Action Input),
 * the LLM is instructed to respond with a JSON object that the agent
 * can reliably parse. This eliminates ambiguity in the agent loop.
 */

// ─── Response Types ─────────────────────────────────────────────────────

/**
 * Intermediate reasoning step (no final answer yet).
 */
export interface ReActReasoning {
  /** Step-by-step reasoning about what to do next. */
  thought: string;
}

/**
 * Final answer from the agent.
 */
export interface ReActFinalAnswer {
  /** Final reasoning before answering. */
  thought: string;
  /** The complete answer for the user. */
  answer: string;
}

/**
 * Union of all possible ReAct response shapes.
 */
export type ReActResponse = ReActReasoning | ReActFinalAnswer;

// ─── Response Parser ────────────────────────────────────────────────────

/**
 * Parse a raw LLM content string into a structured ReActResponse.
 *
 * Handles:
 * - Raw JSON:     {"thought": "...", "answer": "..."}
 * - Code blocks:  ```json\n{"thought": "..."}\n```
 * - Extra text:   Let me think... {"thought": "..."}
 *
 * Falls back to wrapping the raw text as a thought when JSON parsing fails.
 */
export function parseReActResponse(raw: string): ReActResponse {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);

      // Must be an object with at least "thought"
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");

        if ("answer" in parsed && parsed.answer !== undefined && parsed.answer !== null) {
          return { thought, answer: String(parsed.answer) };
        }

        return { thought };
      }
    } catch {
      // JSON parse failed — fall through to fallback
    }
  }

  // Fallback: treat the entire raw string as the thought
  return { thought: raw };
}

/**
 * Try to extract a JSON object from a string that may contain
 * markdown, extra text, malformed newlines, or other noise.
 *
 * Strategy in order:
 * 1. Direct parse of the trimmed text.
 * 2. Extract from ```json ... ``` markdown block.
 * 3. Find balanced { ... } via depth counting, then try to parse.
 * 4. Clean up common issues (unescaped newlines) and retry steps 1-3.
 *
 * Returns the JSON string if found, or null.
 */
function extractJSON(text: string): string | null {
  if (!text) return null;

  // Try with progressively more aggressive cleanup
  const variants = [
    text.trim(),
    cleanupJSON(text.trim()),
    text.trim().replace(/\n/g, " ").replace(/\r/g, ""),
  ];

  // De-duplicate variants
  const seen = new Set<string>();
  const uniqueVariants = variants.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });

  for (const variant of uniqueVariants) {
    const result = tryExtractJSON(variant);
    if (result) return result;
  }

  return null;
}

/**
 * Try all extraction strategies on a single variant of the text.
 */
function tryExtractJSON(text: string): string | null {
  // 1. Try the entire string as JSON
  if (isValidJSON(text)) return text;

  // 2. Try extracting from markdown code blocks: ```json ... ```
  const blockMatch = text.match(
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/
  );
  if (blockMatch && isValidJSON(blockMatch[1])) return blockMatch[1];

  // 3. Try finding the first { ... } with balanced braces
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    const fromBrace = text.slice(braceStart);
    const result = extractBalancedBraces(fromBrace);
    if (result) return result;
  }

  return null;
}

/**
 * Find balanced { ... } and validate as JSON.
 * Handles strings with escaped quotes to avoid false brace matching.
 */
function extractBalancedBraces(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
        escapeNext = false;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(0, i + 1);
          if (isValidJSON(candidate)) return candidate;
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Clean up common JSON formatting issues from LLM output.
 */
function cleanupJSON(text: string): string {
  let result = text;

  // Normalize CRLF → LF, strip isolated CR (Windows/macOS line endings)
  result = result.replace(/\r\n/g, "\n").replace(/\r/g, "");

  return result;
}

/**
 * Quick check if a string is valid JSON.
 */
function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ─── System Prompt Templates ────────────────────────────────────────────

/**
 * Instructions injected into the system prompt to teach the LLM
 * the JSON response format.
 */
export const STRUCTURED_OUTPUT_INSTRUCTIONS = `
=== Response Format ===
You MUST respond with a valid JSON object in the "content" field of your message.
Do NOT wrap the JSON in markdown code blocks.

When you have the FINAL ANSWER for the user:
{"thought": "...step-by-step reasoning...", "answer": "...complete answer for the user..."}

When you are REASONING (intermediate step, before or after using tools):
{"thought": "...step-by-step reasoning..."}

Rules:
- "thought" is REQUIRED in every response — it contains your step-by-step reasoning.
- "answer" is ONLY included in your final response, when you have the complete answer.
- The JSON must be valid and parseable — no trailing commas, no comments.
- If you need to use a tool, put your reasoning in "thought" as JSON, and send the tool call via the function calling mechanism.`;

/**
 * Compact one-line reminder appended to each assistant message
 * to reinforce the JSON format.
 */
export const STRUCTURED_OUTPUT_REMINDER =
  "\n\nRemember: Respond with a JSON object: {\"thought\": \"...\", \"answer\": \"...\"} (answer only for final response).";

// ─── Plan-and-Solve Response Types ────────────────────────────────────────

/**
 * Response from the Plan-and-Solve agent.
 *
 * Different phases produce different shapes:
 * - Planning:    { thought, plan: string[] }
 * - Executing:   { thought } (may also include tool_calls)
 * - Revising:    { thought, revised_plan: string[] }
 * - Final:       { thought, answer }
 */
export interface PlanSolveResponse {
  /** Step-by-step reasoning (required in every response). */
  thought: string;
  /** Initial plan — numbered steps covering the full task. */
  plan?: string[];
  /** Replacement plan — overrides remaining steps. */
  revised_plan?: string[];
  /** Final answer for the user. */
  answer?: string;
  /**
   * 1-based index of the step the LLM is currently working on.
   * Used for plan progress tracking and display.
   * Steps before this are marked as completed.
   */
  currentStep?: number;
}

/**
 * Parse a raw LLM content string into a PlanSolveResponse.
 *
 * Reuses the same multi-strategy JSON extraction as parseReActResponse
 * but handles the Plan-and-Solve shapes (plan/revised_plan arrays).
 */
export function parsePlanSolveResponse(raw: string): PlanSolveResponse {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");
        const result: PlanSolveResponse = { thought };

        // plan — array of strings
        if (parsed.plan && Array.isArray(parsed.plan)) {
          result.plan = parsed.plan.map(String);
        }

        // revised_plan — array of strings
        if (parsed.revised_plan && Array.isArray(parsed.revised_plan)) {
          result.revised_plan = parsed.revised_plan.map(String);
        }

        // answer — final response
        if (parsed.answer !== undefined && parsed.answer !== null) {
          result.answer = String(parsed.answer);
        }

        // currentStep — step progress indicator (1-based)
        if (typeof parsed.currentStep === "number" && parsed.currentStep >= 1) {
          result.currentStep = Math.floor(parsed.currentStep);
        }

        return result;
      }
    } catch {
      // JSON parse failed — fall through to fallback
    }
  }

  // Fallback: treat the entire raw string as thought
  return { thought: raw };
}

/**
 * System prompt instructions for the Plan-and-Solve paradigm.
 *
 * The LLM is instructed to separate planning from execution:
 * 1. Phase 1 — PLAN:  Analyze and create a detailed numbered plan.
 * 2. Phase 2 — RESOLVE: Work through each step, using tools.
 *    Revise remaining steps if new information emerges.
 * 3. Final: When all steps are complete, provide the full answer.
 */
export const PLAN_SOLVE_INSTRUCTIONS = `
=== Plan-and-Resolve Paradigm ===
You follow a structured two-phase approach to solve tasks:

Phase 1 — PLAN: Analyze the user's request and create a detailed, step-by-step plan covering all the work needed. Each step must be concrete and actionable.

Phase 2 — RESOLVE: Execute each step of the plan. Use tools as needed.
- After each step, you may REVISE remaining steps if the plan needs updating.
- A revision replaces all remaining steps — do NOT re-list already completed steps.

=== Response Format ===
You MUST respond with a valid JSON object in the "content" field.

Creating the INITIAL PLAN:
{"thought": "...analysis...", "plan": ["Step 1: description", "Step 2: description", "..."]}

Executing steps (use "currentStep" to indicate your progress):
{"thought": "...reasoning...", "currentStep": 2}

REVISING the plan (replaces REMAINING steps only):
{"thought": "...reasoning about why the plan needs to change...", "revised_plan": ["Updated Step A: ...", "Updated Step B: ...", "..."]}

Final answer:
{"thought": "...summary...", "answer": "...complete answer for the user..."}

Rules:
- "thought" is REQUIRED in every response.
- "plan" is ONLY for the initial plan creation (first response after user input).
- "revised_plan" replaces REMAINING steps — do NOT re-list already done steps.
- "currentStep" is the 1-based index of the step you are about to execute next.
- "answer" is ONLY for the final response, when ALL steps are complete.
- The JSON must be valid and parseable — no trailing commas, no comments.

=== When to Replan — output "revised_plan" when: ===
1. REPEATED TOOL FAILURES: A tool fails 2+ consecutive times on the same step.
   → The current approach isn't working — try a completely different method.

2. CONTRADICTED ASSUMPTIONS: A tool result reveals information that disproves
   a key assumption your plan was based on.
   → Adjust remaining steps to account for the new reality.

3. EXECUTION DRIFT: The actual state of things differs from what the plan
   expected at this point.
   → Realign the remaining steps with what has actually happened.

4. STUCK ON A STEP: You cannot make progress on the current step after
   multiple attempts with different approaches.
   → Skip or reorder steps — try a different angle to reach the goal.

IMPORTANT: Replanning is a normal part of problem-solving. If in doubt,
output a "revised_plan" rather than retrying the same failing approach.`;

// ─── Fusion Agent Response Types ──────────────────────────────────────────

/**
 * Response from the LLM during the routing phase (complexity judgement).
 */
export interface FusionRouteResponse {
  /** "simple" = ReAct only, "complex" = Plan → Execute. */
  complexity: "simple" | "complex";
  /** Short explanation of why this complexity was chosen. */
  reason: string;
}

/**
 * Parse a raw LLM content string into a FusionRouteResponse.
 *
 * Handles the same JSON extraction strategies as the other parsers.
 */
export function parseFusionRouteResponse(raw: string): FusionRouteResponse {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const complexity = parsed.complexity;
        if (complexity === "simple" || complexity === "complex") {
          return {
            complexity,
            reason: String(parsed.reason ?? ""),
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  // Default: assume complex to be safe (planning never hurts)
  return { complexity: "complex", reason: "Route response unparseable; defaulting to complex." };
}

/**
 * Response from the Fusion Agent combining ReAct + Plan-and-Solve shapes.
 *
 * Different phases produce different shapes:
 * - Planning:    { thought, plan: string[] }
 * - Executing:   { thought, currentStep?: number }
 * - Revising:    { thought, revised_plan: string[] }
 * - Final:       { thought, answer }
 */
export interface FusionResponse {
  /** Step-by-step reasoning (required in every response). */
  thought: string;
  /** Initial plan — numbered steps covering the full task. */
  plan?: string[];
  /** Replacement plan — overrides remaining steps. */
  revised_plan?: string[];
  /** Final answer for the user. */
  answer?: string;
  /**
   * 1-based index of the step the LLM is currently working on.
   * Used for plan progress tracking and display.
   */
  currentStep?: number;
}

/**
 * Parse a raw LLM content string into a FusionResponse.
 *
 * This is a thin wrapper around parsePlanSolveResponse — the Fusion
 * response shape is intentionally compatible with PlanSolveResponse.
 */
export function parseFusionResponse(raw: string): FusionResponse {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");
        const result: FusionResponse = { thought };

        if (parsed.plan && Array.isArray(parsed.plan)) {
          result.plan = parsed.plan.map(String);
        }

        if (parsed.revised_plan && Array.isArray(parsed.revised_plan)) {
          result.revised_plan = parsed.revised_plan.map(String);
        }

        if (parsed.answer !== undefined && parsed.answer !== null) {
          result.answer = String(parsed.answer);
        }

        if (typeof parsed.currentStep === "number" && parsed.currentStep >= 1) {
          result.currentStep = Math.floor(parsed.currentStep);
        }

        return result;
      }
    } catch {
      // Fall through
    }
  }

  return { thought: raw };
}

// ─── Fusion Agent System Prompt Templates ─────────────────────────────────

/**
 * Instructions injected into the system prompt for the routing phase.
 *
 * The LLM is asked to classify whether the user's request needs a plan.
 */
export const FUSION_ROUTE_INSTRUCTIONS = `
You are a task complexity classifier. Analyze the user's request and determine whether it requires a structured plan.

A request needs a PLAN when it:
- Involves multiple distinct steps or sub-tasks
- Requires research, analysis, or data gathering before answering
- Spans multiple domains or tools
- Is a "build", "create", "analyze", "refactor", or "investigate" type request
- Will likely take 3+ tool calls to resolve

A request does NOT need a plan when it is:
- A simple factual question or lookup
- A single straightforward action (read this file, run this command)
- A brief conversational exchange
- Immediately answerable from knowledge without tools

Respond with ONLY a JSON object:
{"complexity": "simple", "reason": "..."}
or
{"complexity": "complex", "reason": "..."}

Rules:
- The JSON must be valid and parseable — no trailing commas, no comments.
- "reason" should be a short (1 sentence) explanation of your classification.
- When unsure, default to "complex" — having a plan for a simple task is harmless.`;

/**
 * Full system prompt instructions for Fusion Agent execution mode.
 *
 * Combines ReAct JSON format rules with Plan-and-Solve plan management.
 */
export const FUSION_EXECUTION_INSTRUCTIONS = `
=== Fusion Agent Paradigm ===
You are a Fusion Agent that combines ReAct (Reasoning + Acting) with Plan-and-Solve.

When you HAVE a plan (complex tasks):
1. Work through each step of the plan using tools as needed.
2. Track your progress with "currentStep" (1-based index of the step you are about to execute).
3. If you encounter unexpected results or tool failures, revise remaining steps with "revised_plan".
4. When all steps are complete, provide the final "answer".

When you DON'T have a plan (simple tasks):
1. Think step by step about what the user needs.
2. Use tools as needed to gather information.
3. When you have enough information, provide the final "answer".

=== Response Format ===
You MUST respond with a valid JSON object in the "content" field.

Creating the INITIAL PLAN:
{"thought": "...analysis...", "plan": ["Step 1: description", "Step 2: description", "..."]}

Executing steps (with a plan):
{"thought": "...reasoning...", "currentStep": 2}

REVISING the plan (replaces REMAINING steps only):
{"thought": "...reasoning about why the plan needs to change...", "revised_plan": ["Updated Step A: ...", "Updated Step B: ..."]}

Final answer:
{"thought": "...summary...", "answer": "...complete answer for the user..."}

Simple execution (no plan):
{"thought": "...reasoning..."}

Rules:
- "thought" is REQUIRED in every response.
- "plan" is ONLY for the initial plan creation (first response after user input).
- "revised_plan" replaces REMAINING steps — do NOT re-list already done steps.
- "currentStep" is the 1-based index of the step you are about to execute next.
- "answer" is ONLY for the final response, when the task is fully complete.
- The JSON must be valid and parseable — no trailing commas, no comments.
- If you need to use a tool, put your reasoning in "thought" as JSON, and send the tool call via the function calling mechanism.

=== When to Replan ===
1. REPEATED TOOL FAILURES: A tool fails 2+ consecutive times on the same step.
2. CONTRADICTED ASSUMPTIONS: Tool results disprove a key plan assumption.
3. EXECUTION DRIFT: The actual state differs from what the plan expected.
4. STUCK ON A STEP: Cannot make progress after multiple attempts.

If in doubt, output a "revised_plan" rather than retrying.`;

/**
 * Inline-reflection prompt template.
 *
 * Injected as a user message during execution so the LLM self-checks
 * its progress before continuing.
 */
export const INLINE_REFLECTION_PROMPT =
  `[Internal Reflection] Pause and evaluate your progress so far:

1. Are you on track to answer the user's original request?
2. Have any tool calls returned unexpected or empty results?
3. Is the current plan still appropriate, or should it be revised?
4. What is the single most important action to take next?

Respond with a JSON object:
{
  "on_track": true,
  "issues_found": ["..."],
  "should_replan": false,
  "next_action": "..."
}

Then resume execution normally — do NOT include "answer" unless you are truly done.`;

