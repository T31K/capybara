import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import type { Tool } from "./index.js";

const execFileAsync = promisify(execFile);

async function hasRipgrep(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export const globTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern. Returns a list of matching file paths relative to cwd.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'Glob pattern (e.g. "**/*.ts", "src/**/*.test.js", "*.json")',
          },
          cwd: {
            type: "string",
            description: "Directory to search in (optional, defaults to project cwd)",
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args, ctx) {
    const pattern = args.pattern as string;
    const searchDir = args.cwd
      ? path.resolve(ctx.cwd, args.cwd as string)
      : ctx.cwd;

    try {
      // Use ripgrep's --files with glob if available, else fall back to find
      const useRg = await hasRipgrep();
      let files: string[] = [];

      if (useRg) {
        const { stdout } = await execFileAsync(
          "rg",
          ["--files", "--glob", pattern, "--hidden", "--no-ignore-vcs"],
          { cwd: searchDir }
        );
        files = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((f) => path.relative(ctx.cwd, path.resolve(searchDir, f)));
      } else {
        // Fallback: Node.js glob-like using fs
        files = await findFilesRecursive(searchDir, pattern, ctx.cwd);
      }

      if (files.length === 0) return `No files found matching "${pattern}"`;
      return `Found ${files.length} file(s):\n${files.slice(0, 200).join("\n")}${files.length > 200 ? `\n... (${files.length - 200} more)` : ""}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

async function findFilesRecursive(
  dir: string,
  pattern: string,
  cwd: string
): Promise<string[]> {
  const results: string[] = [];
  const regexPattern = globToRegex(pattern);

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !pattern.includes(".*")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(cwd, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (regexPattern.test(relPath) || regexPattern.test(entry.name)) {
        results.push(relPath);
      }
    }
  }

  await walk(dir);
  return results;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "(.+)")
    .replace(/\*/g, "([^/]+)")
    .replace(/\?/g, "([^/])");
  return new RegExp(`(^|/)${escaped}$`);
}

export const grepTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for",
          },
          path: {
            type: "string",
            description:
              'File or directory to search in (optional, defaults to cwd). Can be a glob like "src/**/*.ts".',
          },
          case_insensitive: {
            type: "boolean",
            description: "Case-insensitive search (optional, default: false)",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (optional, default: 50)",
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args, ctx) {
    const pattern = args.pattern as string;
    const searchPath = args.path
      ? path.resolve(ctx.cwd, args.path as string)
      : ctx.cwd;
    const caseInsensitive = args.case_insensitive as boolean | undefined;
    const maxResults = (args.max_results as number | undefined) ?? 50;

    try {
      const useRg = await hasRipgrep();

      if (useRg) {
        const rgArgs = [
          "--line-number",
          "--with-filename",
          "--color=never",
          "--max-count=1",
        ];
        if (caseInsensitive) rgArgs.push("--ignore-case");
        rgArgs.push(pattern, searchPath);

        const { stdout } = await execFileAsync("rg", rgArgs, {
          cwd: ctx.cwd,
        }).catch((e) => {
          // rg exits with 1 when no matches found
          if (e.code === 1) return { stdout: "" };
          throw e;
        });

        const lines = stdout.trim().split("\n").filter(Boolean);
        const limited = lines.slice(0, maxResults);

        if (limited.length === 0) return `No matches found for "${pattern}"`;

        const results = limited
          .map((line) => {
            const [file, lineNum, ...rest] = line.split(":");
            const relFile = path.relative(ctx.cwd, file);
            return `${relFile}:${lineNum}: ${rest.join(":")}`;
          })
          .join("\n");

        return `Found ${limited.length}${lines.length > maxResults ? `+ (showing ${maxResults} of ${lines.length})` : ""} match(es) for "${pattern}":\n\n${results}`;
      } else {
        // Pure Node.js fallback
        return await grepFallback(pattern, searchPath, ctx.cwd, caseInsensitive ?? false, maxResults);
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

async function grepFallback(
  pattern: string,
  searchPath: string,
  cwd: string,
  caseInsensitive: boolean,
  maxResults: number
): Promise<string> {
  const flags = caseInsensitive ? "i" : "";
  const regex = new RegExp(pattern, flags);
  const results: string[] = [];

  async function searchFile(filePath: string) {
    if (results.length >= maxResults) return;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          const relFile = path.relative(cwd, filePath);
          results.push(`${relFile}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    } catch {
      // skip binary/unreadable files
    }
  }

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        await searchFile(fullPath);
      }
    }
  }

  const stat = await fs.stat(searchPath).catch(() => null);
  if (stat?.isFile()) {
    await searchFile(searchPath);
  } else {
    await walk(searchPath);
  }

  if (results.length === 0) return `No matches found for "${pattern}"`;
  return `Found ${results.length} match(es):\n\n${results.join("\n")}`;
}
