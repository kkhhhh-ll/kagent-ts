import { exec } from "child_process";
import { Tool } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024;

export const BashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command in the current working directory. " +
    "Captures stdout and stderr. Commands are limited to 120 seconds maximum. " +
    "Output is limited to 50 KB. This tool is useful for running build scripts, " +
    "test suites, or any command-line tool. " +
    "⚠️ WARNING: This is an irreversible system operation — approval is required.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The shell command to execute. Must be a single command string. " +
          "Pipe and redirect operators (|, >, <, &&, ||) are supported.",
      },
      workdir: {
        type: "string",
        description:
          "Working directory for the command (defaults to the current directory).",
      },
      timeout: {
        type: "number",
        description:
          `Maximum execution time in milliseconds (default: ${DEFAULT_TIMEOUT_MS / 1000}s, max: ${MAX_TIMEOUT_MS / 1000}s).`,
      },
    },
    required: ["command"],
  },
  requireApproval: true,
  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? "");
    const workdir = args.workdir ? String(args.workdir) : undefined;
    const timeoutMs = Math.min(
      typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    if (!command.trim()) {
      return "Error: Command must not be empty.";
    }

    return new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd: workdir ?? process.cwd(),
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        },
        (error, stdout, stderr) => {
          const exitCode =
            typeof error?.code === "number" ? error.code : error?.code ? 1 : 0;
          const signal = error?.signal;

          let output = `(exit code: ${exitCode})\n`;

          if (stdout.trim()) {
            output += stdout.trimEnd() + "\n";
          } else {
            output += "(no stdout)\n";
          }

          if (stderr.trim()) {
            output += "\n(stderr:\n" + stderr.trimEnd() + "\n)";
          }

          if (signal) {
            output += `\n(process killed by signal: ${signal})`;
          }

          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            resolve(
              `Error: Command not found or shell not available.\n` +
              `Make sure the command exists and is in your PATH.\n\n${output}`,
            );
            return;
          }

          resolve(output);
        },
      );
    });
  },
};
