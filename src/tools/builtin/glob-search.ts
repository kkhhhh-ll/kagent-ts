import * as fs from "fs";
import * as path from "path";
import { Tool } from "../types";

/**
 * Find files matching a glob pattern.
 *
 * Parameters:
 * - pattern (required): Glob pattern (e.g. "**\/*.ts", "src/**\/*.json").
 * - path (optional): Root directory to search in (default: current directory).
 * - max_results (optional): Maximum number of results (default: 100).
 */
export const GlobSearchTool: Tool = {
  name: "glob_search",
  description:
    "Find files matching a glob pattern. Supports ** for recursive matching, " +
    "* for wildcards, {a,b} for alternatives. Skips node_modules and hidden directories. " +
    "Results are sorted by modification time (newest first).",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match file paths against. " +
          "Examples: '** / *.ts', 'src/** / *.json', '*.{ts,js}'.",
      },
      path: {
        type: "string",
        description:
          "Root directory to search in. Defaults to the current working directory.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return (default: 100).",
      },
    },
    required: ["pattern"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPattern = (args.pattern as string) ?? "";
    const searchPath = (args.path as string) || process.cwd();
    const maxResults = (args.max_results as number) ?? 100;

    if (!rawPattern || typeof rawPattern !== "string") {
      return 'Error: "pattern" must be a non-empty string.';
    }

    const resolvedPath = path.resolve(searchPath);

    if (!fs.existsSync(resolvedPath)) {
      return `Error: Path not found: ${resolvedPath}`;
    }

    try {
      const allFiles = listAllFiles(resolvedPath);
      const matcher = buildGlobMatcher(rawPattern, resolvedPath);
      const matched = allFiles.filter(matcher);

      // Sort by modification time (newest first)
      matched.sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

      const results = matched.slice(0, maxResults);
      const cwd = process.cwd();

      if (results.length === 0) {
        return `No files found matching pattern "${rawPattern}" in ${resolvedPath}.`;
      }

      const formatted = results
        .map((filePath) => {
          const relative = path.relative(cwd, filePath);
          try {
            const stat = fs.statSync(filePath);
            const size = stat.size;
            const mtime = stat.mtime.toISOString().split("T")[0];
            const sizeStr =
              size > 1024 * 1024
                ? `${(size / 1024 / 1024).toFixed(1)} MB`
                : size > 1024
                  ? `${(size / 1024).toFixed(1)} KB`
                  : `${size} B`;
            return `${relative}  (${sizeStr}, ${mtime})`;
          } catch {
            return relative;
          }
        })
        .join("\n");

      const summary =
        results.length < matched.length
          ? `Found ${matched.length} files, showing ${results.length} (newest first):`
          : `Found ${results.length} files:`;

      return `${summary}\n\n${formatted}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error during glob search: ${message}`;
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Recursively list all non-binary files under a root path.
 */
function listAllFiles(rootPath: string): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    ".claude",
    "__pycache__",
    ".cache",
  ]);

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission denied, skip
    }
  }

  try {
    if (fs.statSync(rootPath).isFile()) {
      return [rootPath];
    }
  } catch {
    return [];
  }

  walk(rootPath);
  return results;
}

/**
 * Build a glob matcher function.
 * Supports: ** (recursive), * (single-segment wildcard), ? (single char),
 * {a,b} (alternatives).
 *
 * Tries three matching strategies in order:
 * 1. Match against the absolute path directly.
 * 2. Match relative to the search root directory.
 * 3. Match against just the file basename (for simple patterns like "*.ts").
 */
function buildGlobMatcher(
  pattern: string,
  rootPath: string
): (filePath: string) => boolean {
  // Normalize separators
  const normalized = pattern.replace(/\\/g, "/");
  const normalizedRoot = path
    .resolve(rootPath)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  // Build regex from glob
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*" && normalized[i + 1] === "*" && normalized[i + 2] === "/") {
      // **/ - matches zero or more directory levels
      regexStr += "(.*/)?";
      i += 3;
    } else if (
      c === "*" &&
      normalized[i + 1] === "*" &&
      i + 2 === normalized.length
    ) {
      // ** at end
      regexStr += ".*";
      i += 2;
    } else if (c === "*") {
      regexStr += "[^/]*";
      i += 1;
    } else if (c === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (c === ".") {
      regexStr += "\\.";
      i += 1;
    } else if (c === "{") {
      const end = normalized.indexOf("}", i);
      if (end > i) {
        const items = normalized.substring(i + 1, end).split(",");
        regexStr +=
          "(" +
          items
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|") +
          ")";
        i = end + 1;
      } else {
        regexStr += "\\{";
        i += 1;
      }
    } else {
      regexStr += c;
      i += 1;
    }
  }
  regexStr += "$";

  const regex = new RegExp(regexStr);

  return (filePath: string) => {
    const normalizedPath = filePath.replace(/\\/g, "/");

    // 1. Try matching the absolute path directly
    if (regex.test(normalizedPath)) return true;

    // 2. Try matching relative to the root search directory
    if (
      normalizedPath.startsWith(normalizedRoot + "/") ||
      normalizedPath === normalizedRoot
    ) {
      const relativePath =
        normalizedPath === normalizedRoot
          ? "."
          : normalizedPath.slice(normalizedRoot.length + 1);
      if (regex.test(relativePath)) return true;
    }

    // 3. Try matching just the basename (for simple patterns like "*.ts")
    const basename = normalizedPath.split("/").pop() ?? "";
    return regex.test(basename);
  };
}
