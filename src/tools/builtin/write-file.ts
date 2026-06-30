import { existsSync } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Tool } from "../types";

/**
 * Write content to a file (creates or overwrites).
 *
 * Parameters:
 * - file_path (required): Absolute path to write to.
 * - content   (required): Content to write.
 */
export const WriteFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file if it doesn't exist, " +
    "or overwrites it if it does. Also creates parent directories automatically.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path of the file to write.",
      },
      content: {
        type: "string",
        description: "Content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const content = args.content as string;

    if (!filePath || typeof filePath !== "string") {
      return 'Error: "file_path" must be a non-empty string.';
    }
    if (typeof content !== "string") {
      return 'Error: "content" must be a string.';
    }

    const resolvedPath = path.resolve(filePath);

    try {
      // Create parent directories if needed
      const dir = path.dirname(resolvedPath);
      await fsp.mkdir(dir, { recursive: true });

      // Write file
      await fsp.writeFile(resolvedPath, content, "utf-8");

      const stat = await fsp.stat(resolvedPath);
      return `Successfully wrote ${stat.size} bytes to ${resolvedPath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file "${resolvedPath}": ${message}`;
    }
  },
  requireApproval: true,
};
