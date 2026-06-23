import * as fs from "fs";
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
    if (content === undefined || content === null) {
      return 'Error: "content" is required.';
    }

    const resolvedPath = path.resolve(filePath);

    try {
      // Create parent directories if needed
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });

      // Write file
      fs.writeFileSync(resolvedPath, String(content), "utf-8");

      const stat = fs.statSync(resolvedPath);
      return `Successfully wrote ${stat.size} bytes to ${resolvedPath}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file "${resolvedPath}": ${message}`;
    }
  },
  requireApproval: true,
};
