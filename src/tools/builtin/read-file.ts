import { existsSync } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Tool } from "../types";

/**
 * Read a file from disk.
 *
 * Parameters:
 * - file_path (required): Absolute path to the file.
 * - offset (optional): 1-based line number to start from.
 * - limit  (optional): Max number of lines to return.
 */
export const ReadFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file from the local filesystem. " +
    "Supports optional line offset and limit for reading partial files. " +
    "Returns file content with line numbers. Handles text files and shows " +
    "file size for binary files.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read.",
      },
      offset: {
        type: "number",
        description:
          "Optional 1-based line number to start reading from (default: 1).",
      },
      limit: {
        type: "number",
        description:
          "Optional max number of lines to return (default: return all lines).",
      },
    },
    required: ["file_path"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const offset = (args.offset as number) ?? 1;
    const limit = args.limit as number | undefined;

    // Validate path
    if (!filePath || typeof filePath !== "string") {
      return 'Error: "file_path" must be a non-empty string.';
    }

    // Resolve to absolute path
    const resolvedPath = path.resolve(filePath);

    // Check file exists
    if (!existsSync(resolvedPath)) {
      return `Error: File not found: ${resolvedPath}`;
    }

    // Check it's a file, not a directory
    const stat = await fsp.stat(resolvedPath);
    if (!stat.isFile()) {
      return `Error: Not a file: ${resolvedPath}`;
    }

    // Check file size (warn for large files)
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    if (stat.size > MAX_SIZE) {
      return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed: 10 MB.`;
    }

    try {
      const content = await fsp.readFile(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? startIdx + limit : lines.length;
      const selectedLines = lines.slice(startIdx, endIdx);

      // Format with line numbers
      const lineNumWidth = String(endIdx).length;
      const result = selectedLines
        .map((line, i) => {
          const lineNum = startIdx + i + 1;
          return `${String(lineNum).padStart(lineNumWidth)}\t${line}`;
        })
        .join("\n");

      const totalLines = lines.length;
      const summary = `File: ${resolvedPath} (${totalLines} lines, ${(stat.size / 1024).toFixed(1)} KB)`;
      const range =
        selectedLines.length < totalLines
          ? `\nShowing lines ${startIdx + 1}-${Math.min(endIdx, totalLines)} of ${totalLines}.`
          : "";

      return `${summary}${range}\n\n${result}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading file "${resolvedPath}": ${message}`;
    }
  },
};
