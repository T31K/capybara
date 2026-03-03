import fs from "fs/promises";
import path from "path";

const MEMORY_FILES = ["MEMORY.md", "CLAUDE.md", ".ai-cli.md"];
const MAX_LINES = 200;

export async function loadProjectMemory(cwd: string): Promise<string | null> {
  for (const filename of MEMORY_FILES) {
    const filePath = path.join(cwd, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n").slice(0, MAX_LINES);
      const truncated = lines.length < content.split("\n").length;
      return (
        `[Project Memory from ${filename}]\n${lines.join("\n")}` +
        (truncated ? `\n... (truncated to ${MAX_LINES} lines)` : "")
      );
    } catch {
      continue;
    }
  }
  return null;
}

export async function buildSystemPrompt(cwd: string, compact = false): Promise<string> {
  const projectMemory = await loadProjectMemory(cwd);

  const toolList = `Available tools (you MUST call these — never describe actions in text):
- bash: run shell commands
- read_file: read a file
- write_file: create or overwrite a file
- edit_file: make a targeted edit to a file
- list_dir: list directory contents
- glob: find files by pattern
- grep: search file contents
- fetch_url: fetch a URL
- web_search: search the web
- todo_write: track tasks`;

  const basePrompt = compact
    ? `You are a coding assistant. Always call tools to perform actions — never describe what you would do.

${toolList}

Rules:
- To create/edit files: call write_file or edit_file. Do NOT show code blocks.
- To run commands: call bash. Do NOT show shell commands in text.
- Read files before editing them.
- Ask if unsure.

cwd: ${cwd}`
    : `You are an expert software engineer and coding assistant. You help users with any task they can do from a terminal: writing code, reading and editing files, running commands, searching codebases, debugging, and more.

You operate in an agentic loop: you call tools, observe results, and repeat until the task is complete. When you produce a plain response without tool calls, the loop ends and control returns to the user.

IMPORTANT: Always call tools to perform actions. Never describe what you would do or show code in text — just call the appropriate tool directly.

${toolList}

Guidelines:
- Read files before editing them.
- Prefer edit_file over write_file for targeted changes.
- After code changes, run tests/build to verify.
- Use todo_write to plan multi-step tasks.
- Ask the user if you are unsure.

Current directory: ${cwd}
Date: ${new Date().toISOString().split("T")[0]}`;

  if (projectMemory) {
    return `${basePrompt}\n\n${projectMemory}`;
  }

  return basePrompt;
}
