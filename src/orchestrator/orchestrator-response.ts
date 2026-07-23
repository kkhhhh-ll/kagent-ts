/**
 * Structured JSON response schemas and LLM prompt templates for the
 * OrchestratorAgent's three decision phases:
 *
 *   1. DECOMPOSE  — analyse the user request and produce a TaskGraph.
 *   2. SYNTHESIZE — review completed node results and decide completeness.
 *   3. ADAPT      — generate new TaskNodes to fill identified gaps.
 *
 * Each phase has its own JSON shape, parser, and system-prompt fragment.
 */

import type {
  OrchestrationPlan,
  SynthesisResult,
  AdaptResult,
  TaskNode,
} from "./orchestrator-types";

// Re-use the same JSON extraction logic used by the core agents.
// extractJSON is not exported from response-schema.ts, so we inline a copy.
import { extractJSON } from "./json-extractor";

// ─── 1. DECOMPOSE ──────────────────────────────────────────────────────────

/**
 * Parsed response from the decompose LLM call.
 */
export function parseDecomposeResponse(raw: string): OrchestrationPlan {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");

        const nodes: TaskNode[] = [];
        if (parsed.taskGraph && Array.isArray(parsed.taskGraph.nodes)) {
          for (const n of parsed.taskGraph.nodes) {
            nodes.push({
              id: String(n.id ?? ""),
              description: String(n.description ?? ""),
              subAgentName: String(n.subAgentName ?? ""),
              input: String(n.input ?? ""),
              dependsOn: Array.isArray(n.dependsOn)
                ? n.dependsOn.map(String)
                : [],
              status: "pending" as const,
              retryCount: 0,
            });
          }
        }

        return { thought, taskGraph: { nodes } };
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: wrap raw text as thought with no nodes
  return { thought: raw, taskGraph: { nodes: [] } };
}

/**
 * System prompt fragment injected during the Decompose phase.
 *
 * Teaches the LLM to break a user request into a DAG of sub-agent tasks.
 * The `availableSubAgents` placeholder is filled at runtime from the
 * sub-agent manager (same source as the system-prompt hint).
 */
export function buildDecomposePrompt(availableSubAgents: string): string {
  return `You are an expert task orchestrator. Your job is to analyse the user's request and
decompose it into a structured task graph that can be executed by specialised sub-agents.

=== Available Sub-Agents ===
${availableSubAgents}

=== Task Graph Rules ===
1. Each node represents ONE sub-agent invocation with a concrete, self-contained task.
2. Nodes whose "dependsOn" list is empty can run in PARALLEL.
3. A node listed in "dependsOn" MUST complete before the dependant node can start.
4. Use descriptive node IDs (e.g. "research_api", "review_security", "write_report").
5. Every node MUST specify a "subAgentName" that exists in the available list above.
6. The "input" field is the exact prompt sent to the sub-agent. Be specific and include
   all context the sub-agent needs. Do NOT use template variables like {{...}} —
   the sub-agent receives exactly what you write.

Respond with ONLY a JSON object:
{
  "thought": "<your decomposition reasoning>",
  "taskGraph": {
    "nodes": [
      {
        "id": "<unique_node_id>",
        "description": "<what this node does>",
        "subAgentName": "<name from available list>",
        "input": "<exact prompt for the sub-agent>",
        "dependsOn": ["<node_id>", ...]
      }
    ]
  }
}

Rules:
- "thought" is REQUIRED — explain your decomposition strategy.
- The JSON must be valid — no trailing commas, no comments.
- Every "dependsOn" entry must reference an "id" that exists in the graph.
- Prefer MAXIMUM parallelism — don't add dependencies unless one task genuinely
  needs another's output.`;
}

// ─── 2. SYNTHESIZE ─────────────────────────────────────────────────────────

/**
 * Parse the LLM's synthesis response.
 */
export function parseSynthesizeResponse(raw: string): SynthesisResult {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");
        const isComplete = Boolean(parsed.isComplete);

        const result: SynthesisResult = { thought, isComplete };

        if (isComplete && typeof parsed.finalAnswer === "string") {
          result.finalAnswer = parsed.finalAnswer;
        }

        if (!isComplete && Array.isArray(parsed.gaps)) {
          result.gaps = parsed.gaps.map(String);
        }

        return result;
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: treat as incomplete with raw text as the only gap
  return {
    thought: raw,
    isComplete: false,
    gaps: ["Unable to parse synthesis — raw response: " + raw.slice(0, 500)],
  };
}

/**
 * Build the synthesis prompt with all completed node results injected.
 */
export function buildSynthesizePrompt(
  userRequest: string,
  completedResults: string,
  fallbackNotice?: string,
): string {
  return `You are a synthesiser. Review the results below from multiple sub-agents
that were working on the user's request, and determine whether you have enough
information to provide a complete, high-quality answer.

=== User's Original Request ===
${userRequest}
${fallbackNotice ?? ""}
=== Sub-Agent Results ===
${completedResults}

=== Decision Criteria ===
- Set "isComplete": true ONLY when you can provide a thorough answer that fully
  addresses the user's request. Better to request one more round of work than
  to give an incomplete answer.
- Set "isComplete": false when information is missing, results are contradictory,
  or important aspects of the request are not yet covered.
- When false, list specific, actionable gaps — each gap becomes a new sub-agent
  task in the next round.

Respond with ONLY a JSON object:
{
  "thought": "<your analysis of what was learned>",
  "isComplete": true,
  "finalAnswer": "<complete answer for the user>"
}

OR (when more work is needed):

{
  "thought": "<your analysis>",
  "isComplete": false,
  "gaps": ["<specific gap description 1>", "<specific gap description 2>", ...]
}

Rules:
- "thought" is REQUIRED.
- "finalAnswer" is REQUIRED when isComplete is true.
- "gaps" is REQUIRED when isComplete is false — each gap should be a concrete,
  one-sentence description of what still needs to be investigated or done.
- The JSON must be valid — no trailing commas, no comments.`;
}

// ─── 3. ADAPT ──────────────────────────────────────────────────────────────

/**
 * Parse the LLM's adapt response.
 */
export function parseAdaptResponse(raw: string): AdaptResult {
  const json = extractJSON(raw);

  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const thought = String(parsed.thought ?? "");
        const stuck = typeof parsed.stuck === "boolean" ? parsed.stuck : false;

        const newNodes: TaskNode[] = [];
        if (Array.isArray(parsed.newNodes)) {
          for (const n of parsed.newNodes) {
            newNodes.push({
              id: String(n.id ?? ""),
              description: String(n.description ?? ""),
              subAgentName: String(n.subAgentName ?? ""),
              input: String(n.input ?? ""),
              dependsOn: Array.isArray(n.dependsOn)
                ? n.dependsOn.map(String)
                : [],
              status: "pending" as const,
              retryCount: 0,
            });
          }
        }

        return { thought, newNodes, stuck };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: stuck — can't generate new nodes
  return {
    thought: raw,
    newNodes: [],
    stuck: true,
  };
}

/**
 * Build the adapt prompt with gaps and available sub-agents.
 */
export function buildAdaptPrompt(
  gaps: string[],
  availableSubAgents: string,
): string {
  const gapList = gaps.map((g, i) => `${i + 1}. ${g}`).join("\n");

  return `You are an adaptive task planner. The synthesiser has identified gaps
in the current results. Your job is to create NEW task nodes to fill those gaps.

=== Available Sub-Agents ===
${availableSubAgents}

=== Gaps to Fill ===
${gapList}

=== Rules ===
1. Create one TaskNode per gap UNLESS multiple gaps can be handled by a single
   well-scoped sub-agent task.
2. Use only sub-agent names from the available list above.
3. New nodes may depend on nodes that already completed earlier, but you don't
   need to list those dependencies unless a new node genuinely requires another
   NEW node's output first.
4. If you cannot think of any useful new tasks (the gaps are unfillable, or no
   suitable sub-agent exists), set "stuck": true.

Respond with ONLY a JSON object:
{
  "thought": "<your reasoning about how to fill the gaps>",
  "newNodes": [
    {
      "id": "<unique_node_id>",
      "description": "<what this node does>",
      "subAgentName": "<name from available list>",
      "input": "<exact prompt for the sub-agent>",
      "dependsOn": ["<new_node_id>", ...]
    }
  ],
  "stuck": false
}

If you are stuck:
{
  "thought": "<why you cannot fill these gaps>",
  "newNodes": [],
  "stuck": true
}

Rules:
- "thought" is REQUIRED.
- The JSON must be valid — no trailing commas, no comments.
- Prefer fewer, higher-quality nodes over many narrow ones.`;
}
