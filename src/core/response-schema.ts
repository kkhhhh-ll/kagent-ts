/**
 * Structured JSON response schema for LLM outputs.
 *
 * Instead of parsing free-text ReAct format (Thought/Action/Action Input),
 * the LLM is instructed to respond with a JSON object that the agent
 * can reliably parse. This eliminates ambiguity in the agent loop.
 */

// ─── Response Types ─────────────────────────────────────────────────────

/**
 * Parsed ReAct response.
 *
 * The `thought` field contains the LLM's reasoning (or the full content
 * for NL models). The optional `answer` field is set when:
 * - A legacy JSON `{"answer": "..."}` is detected, or
 * - A natural-language "Final Answer:" marker is found.
 *
 * The agent determines finality based on the presence of `tool_calls`
 * in the LLM response — NOT on whether `answer` is present.
 */
export interface ReActResponse {
  /** Step-by-step reasoning (or the full response content for NL models). */
  thought: string;
  /** Explicit final answer (from legacy JSON or NL markers). */
  answer?: string;
}

// ─── Response Parser ────────────────────────────────────────────────────

/**
 * Parse a raw LLM content string into a structured ReActResponse.
 *
 * The caller determines whether the response is a final answer based on
 * the presence of tool_calls in the LLM response — no JSON format required.
 *
 * Handles:
 * - Natural language text (default for modern models like DeepSeek, Claude, GPT)
 * - Legacy JSON:     {"thought": "...", "answer": "..."}
 * - NL markers:      "Final Answer: ..." → treated as answer
 */
export function parseReActResponse(raw: string): ReActResponse {
  // Try legacy JSON format first (backward compatible)
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");
        if ("answer" in parsed && parsed.answer !== undefined && parsed.answer !== null) {
          return { thought, answer: String(parsed.answer) };
        }
        return { thought };
      }
    } catch {
      // JSON parse failed — fall through
    }
  }

  // Try NL answer detection (Final Answer: markers)
  return parseNLFallback(raw);
}

/**
 * Detect whether a natural-language response is a final answer.
 *
 * Strategy (in priority order):
 * 1. Explicit markers: "Final Answer:", "最终回答：", "回答：", etc.
 * 2. If the response has no tool-call-like patterns (Action:, Thought:)
 *    and reads as a complete answer, treat it as one.
 * 3. Otherwise treat as pure thought.
 */
function parseNLFallback(raw: string): ReActResponse {
  const trimmed = raw.trim();
  if (!trimmed) return { thought: raw };

  // 1. Try explicit "Final Answer:" markers (case-insensitive, multiline).
  //    CJK patterns use (?:^|\s) instead of \b because CJK characters are
  //    not \w in JavaScript regex — \b behaves unpredictably around them.
  const finalAnswerPatterns = [
    /\bFinal\s+Answer\s*:\s*/i,
    /(?:^|\s)最终回答\s*[：:]\s*/,
    /(?:^|\s)回答\s*[：:]\s*/,
    /\bAnswer\s*:\s*/i,
  ];

  for (const pattern of finalAnswerPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const after = trimmed.slice(match.index! + match[0].length).trim();
      if (after) {
        return {
          thought: trimmed.slice(0, match.index).trim() || after,
          answer: after,
        };
      }
    }
  }

  // 2. If the text contains classic ReAct action patterns, it's not a final answer
  const actionPattern = /\b(Action|Action\s*Input)\s*:\s*/i;
  if (actionPattern.test(trimmed)) {
    return { thought: raw };
  }

  // 3. Pure content with no action markers — treat as both thought and answer.
  //    (The caller may have already determined there are no tool_calls.)
  return { thought: raw, answer: trimmed };
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
export function extractJSON(text: string): string | null {
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

  // Final fallback: try to repair any brace-delimited JSON-like content
  // in the original text, even when balanced-brace extraction fails
  // due to syntax errors.
  for (const variant of uniqueVariants) {
    const braceStart = variant.indexOf("{");
    if (braceStart >= 0) {
      const fromBrace = variant.slice(braceStart);
      const endIdx = fromBrace.lastIndexOf("}");
      if (endIdx > 0) {
        const candidate = fromBrace.slice(0, endIdx + 1);
        const repaired = repairJSON(candidate);
        if (repaired && isValidJSON(repaired)) return repaired;
      }
    }
  }

  return null;
}

/**
 * Try all extraction strategies on a single variant of the text.
 */
function tryExtractJSON(text: string): string | null {
  // 1. Try the entire string as JSON
  if (isValidJSON(text)) return text;

  // 2. Try extracting from markdown code blocks (any language tag or none).
  //    LLMs sometimes use ```typescript, ```javascript, etc. around JSON.
  const blockMatch = text.match(
    /```(?:\w+)?\s*([\s\S]*?)\s*```/
  );
  if (blockMatch) {
    const inner = blockMatch[1].trim();
    // Direct valid JSON
    if (isValidJSON(inner)) return inner;
    // Try to find a JSON object within the code block content
    const braceStart = inner.indexOf("{");
    if (braceStart >= 0) {
      const fromBrace = inner.slice(braceStart);
      const result = extractBalancedBraces(fromBrace);
      if (result) return result;
    }
  }

  // 3. Try finding the first { ... } with balanced braces in the full text
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    const fromBrace = text.slice(braceStart);
    const result = extractBalancedBraces(fromBrace);
    if (result) return result;
  }

  // 4. Try repair on the fence-extracted content (even if not valid JSON)
  if (blockMatch) {
    const inner = blockMatch[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      const repaired = repairJSON(inner);
      if (repaired && isValidJSON(repaired)) return repaired;
    }
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
 * Attempt to repair common JSON formatting errors made by LLMs.
 *
 * Handles (in order):
 * - Single-line comments:    // comment  (string-value aware)
 * - Multi-line comments:     /* comment *​/
 * - Trailing commas:        {"a": 1,}  → {"a": 1}
 *
 * Returns the repaired string, or the original if repair is not applicable.
 */
/**
 * Remove JavaScript-style comments from text while preserving `//` inside
 * JSON string values (e.g. URLs like "https://example.com/api").
 *
 * Splits on JSON string boundaries so comment stripping is only applied
 * to regions outside of strings.
 */
function removeJSONComments(text: string): string {
  // Split on JSON string literals: "…" with escaped-quote awareness.
  // Matches a string token; capture group keeps it in the output array.
  const parts = text.split(/("(?:\\.|[^"\\])*")/g);
  return parts
    .map((part, i) => {
      // Odd indices are inside string values — preserve exactly
      if (i % 2 === 1) return part;
      // Even indices are outside strings — safe to strip comments
      return part
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    })
    .join("");
}

function repairJSON(text: string): string {
  let result = text;

  // 1. Remove single-line and multi-line comments (string-value aware)
  result = removeJSONComments(result);

  // 2. Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, "$1");

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
=== Response Guidelines ===
- When you need information or need to take an action, use the available tools.
- When you have the complete answer, respond directly with your final answer.
- Always think step by step before acting or answering.
- You do NOT need to wrap your response in JSON — just write naturally.`;

/**
 * Compact one-line reminder appended to each assistant message
 * to reinforce the JSON format.
 */
export const STRUCTURED_OUTPUT_REMINDER =
  "\n\nRemember: Use tools when you need information, respond directly when you have the answer.";

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
// ─── Bracket-marker parsing (fallback for models that ignore JSON) ──────────

/**
 * Bracketed section from a model's natural-language response.
 * Matches markers like [Thought], [Plan], [Final Answer], etc.
 */
interface BracketSection {
  marker: string;
  content: string;
}

/** Split text at bracket-marker boundaries like `[Thought]`, `[Plan]`, etc. */
function splitByBracketMarkers(text: string): BracketSection[] {
  const sections: BracketSection[] = [];
  const regex = /^\[(Thought|Plan|Revised Plan|Current Step|Final Answer)\]\s*/gim;

  let lastIndex = 0;
  let lastMarker = "";
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (lastMarker) {
      sections.push({
        marker: lastMarker,
        content: text.slice(lastIndex, match.index).trim(),
      });
    } else if (match.index > 0) {
      // Text before the first marker — capture as preamble (treated as Thought)
      const preamble = text.slice(0, match.index).trim();
      if (preamble) {
        sections.push({ marker: "Thought", content: preamble });
      }
    }
    lastMarker = match[1];
    lastIndex = match.index + match[0].length;
  }

  // Final section
  if (lastMarker) {
    sections.push({
      marker: lastMarker,
      content: text.slice(lastIndex).trim(),
    });
  }

  return sections;
}

/** Extract numbered-list items from plan / revised-plan content. */
function parseNumberedList(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^\d+[.)]\s+(.+)/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

/**
 * Try to parse a Plan-Solve response from bracket-delimited markers.
 *
 * Accepts:  [Thought] ... [Plan] / [Revised Plan] / [Current Step] /
 *           [Final Answer]
 *
 * Returns null if the text doesn't contain any recognized bracket markers.
 */
function parseBracketMarkers(raw: string): PlanSolveResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const sections = splitByBracketMarkers(trimmed);
  if (sections.length === 0) return null;

  const result: PlanSolveResponse = { thought: "" };
  const thoughts: string[] = [];

  for (const sec of sections) {
    const marker = sec.marker.toLowerCase();
    switch (marker) {
      case "thought":
        if (sec.content) thoughts.push(sec.content);
        break;
      case "plan":
        result.plan = parseNumberedList(sec.content);
        break;
      case "revised plan":
        result.revised_plan = parseNumberedList(sec.content);
        break;
      case "final answer":
        result.answer = sec.content || trimmed;
        break;
      case "current step": {
        const n = parseInt(sec.content, 10);
        if (!isNaN(n) && n >= 1) result.currentStep = n;
        break;
      }
    }
  }

  result.thought = thoughts.join("\n") || trimmed;

  // If nothing actionable was found (no plan, no answer, no step),
  // promote the thought to the answer ONLY when it looks like a conclusion.
  // Skip promotion when the thought contains mid-reasoning markers
  // (e.g. "I need to think", "让我想想", etc.) — promoting those would
  // prematurely terminate the agent loop.
  if (!result.plan && !result.revised_plan && !result.answer && result.currentStep === undefined) {
    const looksLikeMidReasoning =
      /\b(?:need to|should I|let me|maybe|perhaps|possibly|再想想|再看看|先看看|让我想|我得想|还不确定|maybe)\b/i.test(
        result.thought,
      );
    if (!looksLikeMidReasoning) {
      result.answer = result.thought;
    }
    return result;
  }

  return result;
}

// ─── Plan-Solve Response Parsing ────────────────────────────────────────────

/**
 * Populate plan/revised_plan/answer/currentStep from a parsed JSON object.
 *
 * Extracted so both `parsePlanSolveResponse` and `parseFusionResponse`
 * share a single implementation — their response shapes are identical.
 */
function populatePlanSolveFields(
  parsed: Record<string, unknown>,
): PlanSolveResponse {
  const thought = String(parsed.thought ?? "");
  const result: PlanSolveResponse = { thought };

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

export function parsePlanSolveResponse(raw: string): PlanSolveResponse {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return populatePlanSolveFields(parsed);
      }
    } catch {
      // JSON parse failed — fall through to fallback
    }
  }

  // Fallback 1: try bracket-delimited markers ([Thought], [Plan], etc.)
  const bracketResult = parseBracketMarkers(raw);
  if (bracketResult) return bracketResult;

  // Fallback 2: natural-language answer detection (Final Answer:, etc.)
  return parseNLFallback(raw) as PlanSolveResponse;
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

ALTERNATIVELY, you may use bracket-delimited markers (especially if JSON escaping is difficult):
[Thought] <analysis of the task>
[Plan]
1. First step description
2. Second step description

[Thought] <reasoning>
[Current Step] 2

[Thought] <why the plan needs to change>
[Revised Plan]
1. Updated step A
2. Updated step B

[Thought] <summary>
[Final Answer] <complete answer for the user>

Bracket format rules:
- Every response MUST start with [Thought].
- [Plan] is ONLY for the initial plan (numbered list follows).
- [Revised Plan] replaces REMAINING steps.
- [Current Step] is the 1-based step index you are about to execute.
- [Final Answer] signals task completion — only use when truly done.

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

/**
 * Text-mode instructions for the Plan-and-Solve paradigm.
 *
 * The classic plan format uses numbered lists instead of JSON arrays,
 * and uses text ReAct patterns (Thought/Action/Action Input/Final Answer).
 * Plans and revisions are expressed as numbered lists prefixed with markers.
 */
export const TEXT_PLAN_SOLVE_INSTRUCTIONS = `
=== Plan-and-Resolve Paradigm (Text Mode) ===
You follow a structured two-phase approach to solve tasks:

Phase 1 — PLAN: Analyze the user's request and create a detailed, numbered plan.
Phase 2 — RESOLVE: Execute each step. Revise remaining steps if needed.

=== Response Format ===
You MUST use the text ReAct format. Do NOT output JSON.

Creating the INITIAL PLAN:
Thought: <analysis of the task>
Plan:
1. First step description
2. Second step description
...

Executing steps:
Thought: <reasoning about the current step>
Action: <tool_name>
Action Input: <JSON arguments>

REVISING the plan (replaces REMAINING steps, mark with "Revised Plan:"):
Thought: <why the plan needs to change>
Revised Plan:
1. Updated step A
2. Updated step B
...

Final answer:
Thought: <summary of what was accomplished>
Final Answer: <complete answer for the user>

Rules:
- ALWAYS include "Thought:" before any action or final answer.
- "Plan:" is ONLY for the initial plan creation.
- "Revised Plan:" replaces REMAINING steps — do NOT re-list already done steps.
- "Action:" and "Action Input:" MUST appear together.
- "Final Answer:" signals that the task is COMPLETE.
- If in doubt, output a "Revised Plan:" rather than retrying a failing approach.`;

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
        return populatePlanSolveFields(parsed) as FusionResponse;
      }
    } catch {
      // Fall through
    }
  }

  // Fallback 1: try bracket-delimited markers ([Thought], [Plan], etc.)
  const bracketResult = parseBracketMarkers(raw);
  if (bracketResult) return bracketResult as FusionResponse;

  // Fallback 2: try natural-language answer detection
  return parseNLFallback(raw) as FusionResponse;
}

// ─── Fusion Agent System Prompt Templates ─────────────────────────────────

/**
 * Instructions injected into the system prompt for the routing phase.
 *
 * The LLM is asked to classify whether the user's request needs a plan.
 */
export const FUSION_ROUTE_INSTRUCTIONS = `
You are a task complexity classifier. Analyze the user's request and determine whether it requires a structured plan.

A request needs a PLAN ("complex") when it:
- Involves orchestrating MULTIPLE INDEPENDENT sub-tasks across different domains or tools
- Requires multi-source cross-referencing or multi-hop reasoning (e.g. "compare X from A with Y from B,
  then reconcile differences")
- Is a "build", "create", or "refactor" request with non-trivial scope (multiple files, multiple steps)
- Will likely take 5+ tool calls to resolve, where those calls form a non-trivial dependency chain

A request does NOT need a plan ("simple") when it is:
- A factual question, lookup, or single-source retrieval (including knowledge-base / RAG lookups)
- A single straightforward action (read a file, run a command, search a codebase)
- A brief conversational exchange
- A request to summarize, introduce, or explain based on retrieved content — the standard
  ReAct loop (search → read → answer) handles these naturally without a formal plan
- Immediately answerable from general knowledge without tools

Respond with ONLY a JSON object:
{"complexity": "simple", "reason": "..."}
or
{"complexity": "complex", "reason": "..."}

Rules:
- The JSON must be valid and parseable — no trailing commas, no comments.
- "reason" should be a short (1 sentence) explanation of your classification.
- Default to "simple" when the task can reasonably be completed in a direct ReAct loop.
  A plan adds 2 extra LLM calls (plan generation + plan tracking overhead), so only
  classify as "complex" when the structure genuinely adds value.`;

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

// ─── Text-Based ReAct Parsing ──────────────────────────────────────────────

import type { ToolCall } from "../messages/types";

/**
 * Extended response type for text-based ReAct parsing,
 * which can extract tool calls from natural language in addition
 * to thought/answer.
 */
export interface TextReActResponse {
  /** Step-by-step reasoning. */
  thought: string;
  /** Final answer (only present when the model signals completion). */
  answer?: string;
  /** Tool calls extracted from text (Action + Action Input patterns). */
  toolCalls?: ToolCall[];
}

/**
 * Parse a raw LLM response using classic text-based ReAct format.
 *
 * Supports the following patterns (case-insensitive):
 * ```
 * Thought: <reasoning>
 * Action: <tool_name>
 * Action Input: <json_args>
 *
 * Final Answer: <answer>
 * ```
 *
 * Multiple Action/Action Input pairs within a single response are collected
 * and returned as an array of synthetic tool calls.
 *
 * If no patterns are matched, the entire raw text is treated as thought.
 */
export function parseTextReActResponse(raw: string): TextReActResponse {
  const trimmed = raw.trim();
  if (!trimmed) return { thought: raw };

  const tc = parseTextToolCalls(trimmed);
  const thought = extractThought(trimmed);
  const answer = extractFinalAnswer(trimmed);

  return {
    thought,
    ...(answer ? { answer } : {}),
    ...(tc.length > 0 ? { toolCalls: tc } : {}),
  };
}

/**
 * Extract tool calls from classic ReAct text patterns:
 * ```
 * Action: tool_name
 * Action Input: {"key": "value"}
 * ```
 *
 * Handles multi-line Action Input and nested JSON objects/arrays.
 */
function parseTextToolCalls(text: string): ToolCall[] {
  const results: ToolCall[] = [];
  // Match Action: <name> followed (on the next line) by Action Input: <json>
  const actionPattern = /\bAction\s*:\s*([^\n]+)\s*\n\s*\bAction\s+Input\s*:\s*\{/gi;

  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = actionPattern.exec(text)) !== null) {
    const name = match[1].trim();
    // The regex consumed up to and including the opening `{`
    const braceStart = match.index + match[0].length - 1; // position of '{'

    // Extract balanced JSON (handles nested objects / arrays)
    const jsonStr = extractBracedJSON(text, braceStart);
    if (!jsonStr) continue;

    let args = jsonStr;

    // Validate JSON
    try {
      JSON.parse(args);
    } catch {
      // Try to fix common issues: unescaped newlines, trailing commas
      args = args
        .replace(/\n/g, "\\n")
        .replace(/,(\s*[}\]])/g, "$1");
      try {
        JSON.parse(args);
      } catch {
        // Still invalid — skip this tool call
        continue;
      }
    }

    results.push({
      id: `text_tc_${idx++}_${Date.now()}`,
      type: "function",
      function: { name, arguments: args },
    });
  }

  return results;
}

/**
 * Extract a balanced `{…}` JSON object starting at `startPos` within `text`.
 *
 * Tracks nesting depth, strings, and escape sequences.  Does NOT validate
 * JSON — callers should validate separately so they can apply repair logic
 * for common LLM formatting errors.
 *
 * Returns the substring or null if no balanced closing `}` is found.
 */
function extractBracedJSON(text: string, startPos: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startPos, i + 1);
    }
  }

  return null;
}

/**
 * Extract the "Thought:" content from text. If no explicit Thought marker,
 * returns the text before the first Action: or Final Answer: marker.
 */
function extractThought(text: string): string {
  const thoughtMatch = text.match(/\bThought\s*:\s*([\s\S]*?)(?=\n\s*(?:Action|Final\s+Answer)|\s*$)/i);
  if (thoughtMatch) {
    return thoughtMatch[1].trim();
  }

  // No explicit Thought: — use text before any action/answer patterns
  const beforeAction = text.match(/^([\s\S]*?)(?=\n\s*\b(?:Action|Final\s+Answer)\s*:)/i);
  if (beforeAction) {
    return beforeAction[1].trim() || text;
  }

  return text;
}

/**
 * Extract the "Final Answer:" content from text.
 */
function extractFinalAnswer(text: string): string | undefined {
  const patterns = [
    /\bFinal\s+Answer\s*:\s*([\s\S]*?)$/i,
    /(?:^|\s)最终回答\s*[：:]\s*([\s\S]*?)$/,
    /(?:^|\s)回答\s*[：:]\s*([\s\S]*?)$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const answer = match[1].trim();
      if (answer) return answer;
    }
  }

  return undefined;
}

// ─── Text ReAct System Prompt ──────────────────────────────────────────────

/**
 * System prompt instructions for models that use classic text-based
 * ReAct format instead of JSON. Use this with {@link AgentConfig.responseFormat}
 * set to `"text"` or as a base prompt for models that don't support
 * native function calling.
 *
 * The format mirrors the original ReAct paper pattern:
 * Thought → Action → Action Input → Observation → ... → Final Answer
 */
export const TEXT_REACT_INSTRUCTIONS = `
=== Response Format (Text Mode) ===
You MUST follow this exact format for every response. Do NOT output JSON.

When using a tool, write:
Thought: <your step-by-step reasoning about what to do>
Action: <tool_name>
Action Input: <JSON arguments for the tool>

Example:
Thought: I need to read the config file to understand the settings.
Action: read_file
Action Input: {"path": "/app/config.json"}

When you have the COMPLETE FINAL ANSWER for the user, write:
Thought: <summary of what you did and why the answer is complete>
Final Answer: <your complete answer to the user>

Rules:
- "Thought:" is REQUIRED before every Action or Final Answer.
- "Action:" and "Action Input:" MUST appear together — one Action per pair.
- "Action Input:" MUST be valid JSON (no trailing commas, no comments).
- "Final Answer:" signals that the task is COMPLETE — only use it when truly done.
- Never output both "Action:" and "Final Answer:" in the same response.
- If you realize you're done, output Final Answer: immediately — do not take unnecessary actions.`;

