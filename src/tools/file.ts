import fs from "fs/promises";
import path from "path";
import { createPatch } from "diff";
import type { Tool, ToolContext } from "./index.js";
import { askPermission, isAlwaysAllowed } from "../permissions.js";

export const listDirTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the contents of a directory. Returns files and subdirectories with their types and sizes.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (absolute or relative to cwd). Defaults to cwd.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args, ctx) {
    const dirPath = args.path
      ? path.resolve(ctx.cwd, args.path as string)
      : ctx.cwd;

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      return `Error: Cannot list "${dirPath}": ${(err as Error).message}`;
    }

    const lines: string[] = [`${dirPath}/`, ""];

    const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      lines.push(`  ${d.name}/`);
    }
    for (const f of files) {
      let size = "";
      try {
        const stat = await fs.stat(path.join(dirPath, f.name));
        size = formatBytes(stat.size);
      } catch { /* skip */ }
      lines.push(`  ${f.name}  ${size}`);
    }

    lines.push("", `${dirs.length} director${dirs.length === 1 ? "y" : "ies"}, ${files.length} file${files.length === 1 ? "" : "s"}`);
    return lines.join("\n");
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function formatDiff(oldContent: string, newContent: string, filePath: string): string {
  return createPatch(filePath, oldContent, newContent, "before", "after");
}

export const readFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. Returns the file content as a string. For large files, specify offset and limit to read a range of lines.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file (absolute or relative to cwd)",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-indexed, optional)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read (optional, default: all)",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args, ctx) {
    const filePath = resolvePath(args.path as string, ctx.cwd);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return `Error: Cannot read file "${filePath}": ${(err as Error).message}`;
    }

    const lines = content.split("\n");
    const offset = typeof args.offset === "number" ? args.offset - 1 : 0;
    const limit = typeof args.limit === "number" ? args.limit : lines.length;

    const selected = lines.slice(offset, offset + limit);
    const numbered = selected
      .map((line, i) => `${String(offset + i + 1).padStart(6)}|${line}`)
      .join("\n");

    return `File: ${filePath}\nLines: ${offset + 1}-${offset + selected.length} of ${lines.length}\n\n${numbered}`;
  },
};

export const writeFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, replacing its entire contents. Shows a diff and asks for confirmation unless auto-accept is enabled.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file (absolute or relative to cwd)",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },

  async execute(args, ctx) {
    const filePath = resolvePath(args.path as string, ctx.cwd);
    const newContent = args.content as string;

    let oldContent = "";
    try {
      oldContent = await fs.readFile(filePath, "utf-8");
    } catch {
      // new file
    }

    const diff = formatDiff(oldContent, newContent, filePath);

    if (!ctx.autoAccept && !isAlwaysAllowed(`write:${filePath}`)) {
      console.log("\n" + diff);
      const perm = await askPermission(
        `Write to ${filePath}?`,
        `write:${filePath}`
      );
      if (perm === "deny") {
        return `Denied: write to ${filePath} was rejected by user.`;
      }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, newContent, "utf-8");
    return `Wrote ${newContent.length} bytes to ${filePath}`;
  },
};

export const editFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Make a targeted edit to a file by replacing an exact string with new content. Use this for surgical edits rather than rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file (absolute or relative to cwd)",
          },
          old_string: {
            type: "string",
            description:
              "The exact text to find and replace. Must be unique in the file. Include enough context (3-5 lines) to uniquely identify the location.",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },

  async execute(args, ctx) {
    const filePath = resolvePath(args.path as string, ctx.cwd);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return `Error: Cannot read file "${filePath}": ${(err as Error).message}`;
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return `Error: old_string not found in ${filePath}. Make sure the text matches exactly (including whitespace and indentation).`;
    }
    if (occurrences > 1) {
      return `Error: old_string appears ${occurrences} times in ${filePath}. Provide more context to uniquely identify the location.`;
    }

    const newContent = content.replace(oldString, newString);
    const diff = formatDiff(content, newContent, filePath);

    if (!ctx.autoAccept && !isAlwaysAllowed(`write:${filePath}`)) {
      console.log("\n" + diff);
      const perm = await askPermission(
        `Edit ${filePath}?`,
        `write:${filePath}`
      );
      if (perm === "deny") {
        return `Denied: edit to ${filePath} was rejected by user.`;
      }
    }

    await fs.writeFile(filePath, newContent, "utf-8");
    return `Edited ${filePath} successfully.`;
  },
};
