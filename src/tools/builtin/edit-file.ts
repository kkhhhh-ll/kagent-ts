import * as fs from "fs";
import * as path from "path";
import { Tool } from "../types";

/**
 * Edit a file by finding and replacing exact text.
 *
 * Parameters:
 * - file_path  (required): Absolute path to the file to edit.
 * - old_string (required): The exact text to find (must match exactly).
 * - new_string (required): The replacement text.
 * - replace_all (optional): Replace all occurrences (default: false).
 */
export const EditFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by performing an exact string replacement. " +
    "The old_string must match the file contents exactly, including whitespace and indentation. " +
    "Useful for making targeted edits without rewriting the entire file.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit.",
      },
      old_string: {
        type: "string",
        description:
          "The exact text to search for and replace. " +
          "Must match the file contents exactly (including indentation).",
      },
      new_string: {
        type: "string",
        description: "The text to replace old_string with.",
      },
      replace_all: {
        type: "boolean",
        description:
          "If true, replace all occurrences of old_string. " +
          "If false (default), only replace the first occurrence.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true;

    if (!filePath || typeof filePath !== "string") {
      return 'Error: "file_path" must be a non-empty string.';
    }
    if (!oldString || typeof oldString !== "string") {
      return 'Error: "old_string" must be a non-empty string.';
    }
    if (newString === undefined || newString === null) {
      return 'Error: "new_string" is required.';
    }

    const resolvedPath = path.resolve(filePath);

    // Validate file exists
    if (!fs.existsSync(resolvedPath)) {
      return `Error: File not found: ${resolvedPath}`;
    }

    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");

      // Check that old_string exists in the file
      if (!content.includes(oldString)) {
        return (
          `Error: The specified text was not found in the file.\n` +
          `Make sure the text matches exactly, including whitespace and indentation.`
        );
      }

      // Perform the replacement
      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, () => newString);

      // Write back
      fs.writeFileSync(resolvedPath, newContent, "utf-8");

      // Count occurrences replaced
      const oldCount = content.split(oldString).length - 1;
      const newLen = newContent.length;
      const diff = newLen - content.length;

      return (
        `Successfully applied edit to ${resolvedPath}\n` +
        `Replaced ${replaceAll ? oldCount : 1} occurrence(s). ` +
        `File size: ${diff > 0 ? "+" : ""}${diff} bytes (${content.length} → ${newLen}).`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error editing file "${resolvedPath}": ${message}`;
    }
  },
  requireApproval: true,
};
