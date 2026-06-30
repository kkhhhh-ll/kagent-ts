import * as fs from "fs";
import * as path from "path";
import { Tool } from "../types";

/**
 * Search file contents using regex or plain text patterns.
 *
 * Parameters:
 * - pattern (required): Regex or plain text to search for.
 * - path (optional): File or directory to search in (default: current directory).
 * - glob (optional): File pattern filter (e.g. "*.ts", "*.{ts,js}").
 * - case_sensitive (optional): Whether the search is case-sensitive (default: false).
 *
 * Uses a recursive file walk with Node.js built-in fs — no external dependencies.
 */
export const GrepSearchTool: Tool = {
  name: "grep_search",
  description:
    "Search for text patterns in files. Supports regex and plain text search, " +
    "with optional file glob filtering and case-sensitivity control. " +
    "Results show the file path, line number, and matching line content.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "The regex or plain text pattern to search for. " +
          "Supports JavaScript regex syntax.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in. Defaults to the current working directory.",
      },
      glob: {
        type: "string",
        description:
          "File glob pattern to filter results (e.g. '*.ts', '*.{ts,js,json}'). " +
          "Only files matching this pattern will be searched.",
      },
      case_sensitive: {
        type: "boolean",
        description:
          "Whether the search should be case-sensitive. Default: false (case-insensitive).",
      },
    },
    required: ["pattern"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPattern = args.pattern as string;
    const searchPath = (args.path as string) || process.cwd();
    const globPattern = args.glob as string | undefined;
    const caseSensitive = args.case_sensitive === true;

    if (!rawPattern || typeof rawPattern !== "string") {
      return 'Error: "pattern" must be a non-empty string.';
    }

    // Build regex from pattern
    let regex: RegExp;
    try {
      regex = new RegExp(rawPattern, caseSensitive ? "g" : "gi");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Invalid regex pattern "${rawPattern}": ${message}`;
    }

    const resolvedPath = path.resolve(searchPath);

    if (!fs.existsSync(resolvedPath)) {
      return `Error: Path not found: ${resolvedPath}`;
    }

    // Build glob filter: only check files whose name matches the pattern
    const globFilter = globPattern
      ? buildGlobFilter(globPattern)
      : () => true;

    try {
      const results: string[] = [];
      const MAX_RESULTS = 200;
      const MAX_FILE_SIZE = 1024 * 1024; // 1 MB per file

      const files = listFilesRecursive(resolvedPath);

      for (const filePath of files) {
        if (results.length >= MAX_RESULTS) break;

        const relativePath = path.relative(process.cwd(), filePath);

        // Apply glob filter
        if (!globFilter(filePath)) continue;

        // Check file size
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0; // Reset regex state
            if (regex.test(lines[i])) {
              const trimmed = lines[i].trim();
              const display = trimmed.length > 200
                ? trimmed.substring(0, 200) + "..."
                : trimmed;
              results.push(`${relativePath}:${i + 1}: ${display}`);
              if (results.length >= MAX_RESULTS) break;
            }
          }
        } catch {
          // Skip binary files or files we can't read
          continue;
        }
      }

      if (results.length === 0) {
        return `No matches found for pattern "${rawPattern}" in ${resolvedPath}.`;
      }

      const summary = `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${rawPattern}"`;
      return `${summary}:\n\n${results.join("\n")}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error during grep search: ${message}`;
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * List all files recursively under a directory (or a single file).
 * Skips node_modules, .git, and hidden directories.
 */
function listFilesRecursive(rootPath: string): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", ".claude",
    "__pycache__", ".cache",
  ]);

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden dirs and common ignore dirs
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          // Skip binary extensions
          const ext = path.extname(entry.name).toLowerCase();
          const BINARY_EXTS = new Set([
            ".png", ".jpg", ".jpeg", ".gif", ".ico",
            ".woff", ".woff2", ".ttf", ".eot",
            ".zip", ".tar", ".gz", ".rar",
            ".o", ".obj", ".exe", ".dll", ".so", ".dylib",
            ".mp3", ".mp4", ".avi", ".mov",
            ".pdf", ".doc", ".docx",
          ]);
          if (BINARY_EXTS.has(ext)) continue;
          results.push(fullPath);
        }
      }
    } catch {
      // Permission denied, skip
    }
  }

  try {
    const stat = fs.statSync(rootPath);
    if (stat.isFile()) {
      return [rootPath];
    }
  } catch {
    return [];
  }

  walk(rootPath);
  return results;
}

/**
 * Build a glob filter function from a simple glob pattern.
 * Supports: *.ts, *.{ts,js}, **/
function buildGlobFilter(pattern: string): (filePath: string) => boolean {
  const normalized = pattern.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  // Simple single-level pattern (e.g., "*.ts") — match against basename only
  if (parts.length === 1 && !parts[0].includes("**")) {
    const regex = globToRegex(parts[0]);
    return (filePath: string) => regex.test(path.basename(filePath));
  }

  // Multi-level pattern (e.g., "src/**/*.ts") — match against full path.
  // matchSlash=false: * matches within one segment, ** matches across directories.
  const regex = globToRegex(normalized, false);
  return (filePath: string) => {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return regex.test(normalizedPath);
  };
}

/**
 * Convert a glob pattern to a case-insensitive RegExp.
 *
 * When `matchSlash` is true (default), `*` matches any character including `/`.
 * When false, `*` matches `[^/]*` (within one path segment) and `**` matches `.*`
 * (across segments). Also supports `?`, brace expansion `{a,b}`, and escapes `.`
 * so it matches a literal dot.
 */
function globToRegex(glob: string, matchSlash = true): RegExp {
  const anyChar = matchSlash ? "." : "[^/]";
  let str = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // **/ matches zero or more directory levels
          str += "(.*/)?";
          i += 2;
        } else {
          // ** at end or followed by non-slash
          str += ".*";
          i++;
        }
      } else {
        str += anyChar + "*";
      }
    } else if (c === "?") {
      str += anyChar;
    } else if (c === ".") {
      str += "\\.";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const items = glob.substring(i + 1, end).split(",");
        str +=
          "(" +
          items
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|") +
          ")";
        i = end;
      } else {
        str += "\\{";
      }
    } else {
      str += c;
    }
  }
  str += "$";
  return new RegExp(str, "i");
}
