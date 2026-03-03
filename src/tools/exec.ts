import { spawn } from "child_process";
import type { Tool } from "./index.js";
import {
  classifyRisk,
  sanitizeCommand,
  askPermission,
  isAlwaysAllowed,
} from "../permissions.js";

const COMMAND_TIMEOUT_MS = 60_000;

export const bashTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command and return its output. For long-running commands, use a timeout. Prefer read-only commands where possible.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (optional, default: ${COMMAND_TIMEOUT_MS})`,
          },
          description: {
            type: "string",
            description: "Brief description of what this command does (shown to user)",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(args, ctx) {
    const command = args.command as string;
    const timeoutMs = (args.timeout_ms as number | undefined) ?? COMMAND_TIMEOUT_MS;
    const description = (args.description as string | undefined) ?? command;

    // Security: check for injection
    const { safe, reason } = sanitizeCommand(command);
    if (!safe) {
      return `Error: Command blocked — ${reason}`;
    }

    const risk = classifyRisk(command);

    // Always ask for dangerous commands
    if (risk === "dangerous") {
      console.log(`\n⚠️  Dangerous command: ${command}`);
      const perm = await askPermission(
        `This command is potentially destructive. Run it?`,
        undefined // don't always-allow dangerous commands
      );
      if (perm === "deny") return "Denied: user rejected dangerous command.";
    } else if (risk === "moderate" && !ctx.autoAccept && !isAlwaysAllowed(`bash:${command}`)) {
      const perm = await askPermission(
        `Run: ${description}`,
        `bash:${command}`
      );
      if (perm === "deny") return "Denied: user rejected command.";
    }

    return runCommand(command, ctx.cwd, timeoutMs);
  },
};

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(
        `Error: Command timed out after ${timeoutMs}ms\nPartial stdout:\n${stdout}\nPartial stderr:\n${stderr}`
      );
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = [
        stdout.trim() ? `stdout:\n${truncate(stdout)}` : null,
        stderr.trim() ? `stderr:\n${truncate(stderr)}` : null,
        `exit code: ${code}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      resolve(output || `(no output, exit code: ${code})`);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error: Failed to spawn command: ${err.message}`);
    });
  });
}

function truncate(s: string, maxChars = 20_000): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... (truncated, ${s.length - maxChars} more chars)`;
}
