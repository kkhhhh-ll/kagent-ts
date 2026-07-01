import { Tool } from "./types";

// ─── ToolFilter ──────────────────────────────────────────────────────────────

/**
 * A tool filter decides whether a given tool should be included.
 *
 * Pass a filter to a sub-agent definition so you can restrict which
 * tools the sub-agent can access without editing the main agent's
 * ToolRegistry.
 *
 * Built-in factories (`allowlist`, `denylist`, `pattern`) cover common
 * cases; implement this interface directly for custom logic.
 */
export interface ToolFilter {
  /** Human-readable name shown in debug/log output. */
  readonly name: string;

  /** Return `true` to include the tool, `false` to exclude. */
  filter(tool: Tool): boolean;
}

// ─── Built-in Filters ────────────────────────────────────────────────────────

/**
 * Only allow tools whose name is in the provided list.
 *
 * @example
 * ```ts
 * const filter = allowlist("read_file", "grep", "glob");
 * ```
 */
export function allowlist(...names: string[]): ToolFilter {
  const set = new Set(names);
  return {
    name: `allowlist(${names.join(", ")})`,
    filter: (tool) => set.has(tool.name),
  };
}

/**
 * Allow all tools EXCEPT those whose name is in the provided list.
 * Useful for removing dangerous or unnecessary tools from sub-agents.
 *
 * @example
 * ```ts
 * const filter = denylist("spawn_subagent", "list_subagents");
 * ```
 */
export function denylist(...names: string[]): ToolFilter {
  const set = new Set(names);
  return {
    name: `denylist(${names.join(", ")})`,
    filter: (tool) => !set.has(tool.name),
  };
}

/**
 * Include only tools whose name matches a regex pattern.
 *
 * @example
 * ```ts
 * const filter = pattern(/^(read|write|edit)_/);  // file-system tools only
 * ```
 */
export function pattern(regex: RegExp): ToolFilter {
  return {
    name: `pattern(/${regex.source}/${regex.flags})`,
    filter: (tool) => regex.test(tool.name),
  };
}

/**
 * Combine multiple filters with AND logic — a tool must pass ALL filters.
 *
 * @example
 * ```ts
 * // Allow file tools, but exclude write
 * const filter = all(pattern(/^(read|write|edit)_/), denylist("write_file"));
 * ```
 */
export function all(...filters: ToolFilter[]): ToolFilter {
  return {
    name: `all(${filters.map((f) => f.name).join(", ")})`,
    filter: (tool) => filters.every((f) => f.filter(tool)),
  };
}

/**
 * Combine multiple filters with OR logic — a tool must pass AT LEAST ONE filter.
 *
 * @example
 * ```ts
 * // Allow read_file or exact grep match
 * const filter = any(allowlist("read_file"), allowlist("grep"));
 * ```
 */
export function any(...filters: ToolFilter[]): ToolFilter {
  return {
    name: `any(${filters.map((f) => f.name).join(", ")})`,
    filter: (tool) => filters.some((f) => f.filter(tool)),
  };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Apply a filter to a tool array and return the filtered subset.
 */
export function filterTools(tools: Tool[], filter: ToolFilter): Tool[] {
  return tools.filter((t) => filter.filter(t));
}
