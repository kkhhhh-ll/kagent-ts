import { existsSync } from "fs";
import * as fsp from "fs/promises";
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
          "Examples: '**/*.ts', 'src/**/*.json', '*.{ts,js}'.",
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

    if (!existsSync(resolvedPath)) {
      return `Error: Path not found: ${resolvedPath}`;
    }

    try {
      const allFiles = await listAllFiles(resolvedPath);
      const matcher = buildGlobMatcher(rawPattern, resolvedPath);
      const matched = allFiles.filter(matcher);

      // Sort by modification time (newest first).
      // Pre-compute mtimes to avoid O(n log n) stat calls.
      const mtimeMap = new Map<string, number>();
      for (const f of matched) {
        try {
          mtimeMap.set(f, (await fsp.stat(f)).mtimeMs);
        } catch {
          mtimeMap.set(f, 0);
        }
      }
      matched.sort((a, b) => (mtimeMap.get(b) ?? 0) - (mtimeMap.get(a) ?? 0));

      const results = matched.slice(0, maxResults);
      const cwd = process.cwd();

      if (results.length === 0) {
        return `No files found matching pattern "${rawPattern}" in ${resolvedPath}.`;
      }

      const formattedLines: string[] = [];
      for (const filePath of results) {
        const relative = path.relative(cwd, filePath);
        try {
          const stat = await fsp.stat(filePath);
          const size = stat.size;
          const mtime = stat.mtime.toISOString().split("T")[0];
          const sizeStr =
            size > 1024 * 1024
              ? `${(size / 1024 / 1024).toFixed(1)} MB`
              : size > 1024
                ? `${(size / 1024).toFixed(1)} KB`
                : `${size} B`;
          formattedLines.push(`${relative}  (${sizeStr}, ${mtime})`);
        } catch {
          formattedLines.push(relative);
        }
      }

      const formatted = formattedLines.join("\n");
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
async function listAllFiles(rootPath: string): Promise<string[]> {
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

  async function walk(dir: string): Promise<void> {
    let entries: fsp.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied, skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  try {
    const stat = await fsp.stat(rootPath);
    if (stat.isFile()) {
      return [rootPath];
    }
  } catch {
    return [];
  }

  await walk(rootPath);
  return results;
}

/**
 * Build a glob matcher function (unchanged — pure logic).
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
