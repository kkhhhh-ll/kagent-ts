/**
 * Shared system-prompt fragments used by multiple agent types.
 *
 * Extracting these into a single file avoids duplication and ensures
 * that improvements to error recovery or delegation guidance are
 * applied consistently across ReAct, PlanSolve, and any future agents.
 */

// ─── Tool Error Recovery ─────────────────────────────────────────────────────

/**
 * Standardised tool error recovery instructions.
 * Teaches the LLM how to interpret severity tags and error codes in
 * tool results and how to respond appropriately.
 */
export const TOOL_ERROR_RECOVERY = `
=== Tool Error Recovery ===
Tool results are tagged with severity and an error code:
- Normal output (no tag)            → the tool succeeded. Use the result.
- [RETRYABLE:EXECUTION_FAILURE]     → the tool threw an error but HAS retries.
                                       Analyze the error and fix your arguments.
- [RETRYABLE:ARGUMENTS_PARSE_ERROR] → your arguments were malformed JSON.
                                       Re-invoke the tool with corrected JSON.
- [FATAL:CIRCUIT_OPEN]              → the tool is permanently disabled after
                                       too many failures. DO NOT retry.
- [FATAL:UNKNOWN_TOOL]              → the tool does not exist. Use a different
                                       tool from the available list.

When a tool returns [RETRYABLE:*]:
1. READ the error message carefully — understand WHY it failed.
2. ANALYZE whether the parameters were correct. Common issues:
   - Wrong file path (check spelling, use absolute paths)
   - Missing or incorrect arguments
   - The tool may need different input formats
3. RETRY with corrected parameters.
4. If the same tool gets [RETRYABLE] again, try a DIFFERENT approach.

When a tool returns [FATAL:*]:
- The tool is gone. Do NOT retry it. Use available alternatives or a completely
  different method to accomplish the task.`;

// ─── Sub-Agent Delegation ────────────────────────────────────────────────────

/**
 * Instructions for spawning and managing sub-agents.
 * Applies to any agent type that supports sub-agent delegation.
 */
export const SUB_AGENT_DELEGATION = `
=== Sub-Agent Delegation ===
You have the ability to spawn sub-agents for parallel or specialized work. When facing a non-trivial task, evaluate it against these criteria:

SPAWN A SUB-AGENT when:
1. The task can be completed independently (doesn't depend on conversation history)
2. The task will produce a lot of intermediate output (e.g. running tests, searching entire codebase)
3. The task belongs to a specific domain (code review, security scan, i18n check, etc.)
4. Multiple independent tasks can run at the same time

PREFER THE MAIN AGENT when the task depends on conversation context or is quick to complete.

How to delegate:
- Call \`list_subagents\` to see available sub-agents and their capabilities (tools, skills)
- Choose the best match, then call \`spawn_subagent\` with the name and a clear task description
- Sub-agents run asynchronously; their results arrive as user messages wrapped in <subagent-result> tags
- You can continue working while sub-agents run in the background`;
