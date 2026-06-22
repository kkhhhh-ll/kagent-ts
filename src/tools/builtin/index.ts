import { ToolRegistry } from "../tool-registry";
import { Tool } from "../types";
import { ReadFileTool } from "./read-file";
import { WriteFileTool } from "./write-file";
import { EditFileTool } from "./edit-file";
import { GrepSearchTool } from "./grep-search";
import { GlobSearchTool } from "./glob-search";

/**
 * Array of all built-in tools.
 */
export const BUILTIN_TOOLS: Tool[] = [
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GrepSearchTool,
  GlobSearchTool,
];

/**
 * Names of every built-in tool (both static and dynamically-created).
 * Used to distinguish framework tools from MCP / user-registered tools.
 */
export const BUILTIN_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "glob_search",
  "grep_search",
  "skill",
  "spawn_subagent",
  "list_subagents",
  "remember",
  "recall",
  "list_errors",
]);

// Re-export individual tools
export { ReadFileTool } from "./read-file";
export { WriteFileTool } from "./write-file";
export { EditFileTool } from "./edit-file";
export { GrepSearchTool } from "./grep-search";
export { GlobSearchTool } from "./glob-search";
export { createListSubagentsTool } from "./list-subagents";
export { createSpawnSubagentTool } from "./spawn-subagent";
export { createListErrorsTool } from "./list-errors";
export { createSkillTool } from "./skill";
export { createRememberTool } from "./remember";
export { createRecallTool } from "./recall";

/**
 * Register all built-in tools into the given registry.
 * Silently skips tools that are already registered.
 *
 * @param registry  The ToolRegistry to register tools into.
 * @param overwrite If true, re-registers even if a tool with the same name exists.
 *                  Default: false.
 */
export function registerAllBuiltinTools(
  registry: ToolRegistry,
  overwrite = false
): void {
  for (const tool of BUILTIN_TOOLS) {
    if (registry.has(tool.name)) {
      if (overwrite) {
        registry.remove(tool.name);
        registry.register(tool);
      }
      // else skip silently
    } else {
      registry.register(tool);
    }
  }
}
