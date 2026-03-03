import chalk from "chalk";
import os from "os";
import type { Delta } from "../llm/provider.js";


// ── dot colors ────────────────────────────────────────────────────────────────
const DOT = {
  tool:    chalk.hex("#d4a017")("●"),   // amber  – tool running
  done:    chalk.green("●"),            // green  – tool finished
  info:    chalk.blue("●"),             // blue   – info / system
  error:   chalk.red("●"),              // red    – error
  warn:    chalk.yellow("●"),           // yellow – warning
  text:    chalk.white("●"),            // white  – assistant text prefix
};

const PIPE  = chalk.gray("│");
const ELBOW = chalk.gray("└");

// ── tool-specific colors ──────────────────────────────────────────────────────
const TOOL_COLOR: Record<string, (s: string) => string> = {
  bash:       chalk.hex("#e8b86d"),   // warm yellow
  read_file:  chalk.hex("#7ec8e3"),   // sky blue
  write_file: chalk.hex("#a8d8a8"),   // soft green
  edit_file:  chalk.hex("#a8d8a8"),   // soft green
  list_dir:   chalk.hex("#7ec8e3"),   // sky blue
  glob:       chalk.hex("#c3a6ff"),   // lavender
  grep:       chalk.hex("#c3a6ff"),   // lavender
  fetch_url:  chalk.hex("#f4a261"),   // orange
  web_search: chalk.hex("#f4a261"),   // orange
  todo_write: chalk.hex("#90e0ef"),   // cyan
};

function toolColor(name: string): (s: string) => string {
  return TOOL_COLOR[name] ?? chalk.white;
}

const TOOL_VERB: Record<string, string> = {
  bash:       "Bash",
  read_file:  "Read",
  write_file: "Write",
  edit_file:  "Update",
  list_dir:   "List",
  glob:       "Glob",
  grep:       "Grep",
  fetch_url:  "Fetch",
  web_search: "Search",
  todo_write: "TodoWrite",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SPINNER_FRAMES = ["✢", "✦", "✧", "✤", "✣"];
const THINKING_WORDS = [
  "Prestidigitating",
  "Cogitating",
  "Ruminating",
  "Deliberating",
  "Contemplating",
  "Cerebrating",
  "Noodling",
  "Philosophizing",
  "Percolating",
  "Marinating",
  "Stewing",
  "Mulling",
  "Pondering",
  "Scheming",
  "Concocting",
  "Calculating",
  "Synthesizing",
  "Extrapolating",
  "Hypothesizing",
  "Ratiocinating",
];

const COGITATED_PHRASES = [
  "Cogitated for",
  "Deliberated for",
  "Ruminated for",
  "Noodled for",
  "Prestidigitated for",
  "Contemplated for",
  "Cerebrated for",
  "Philosophized for",
  "Pondered for",
  "Marinated on it for",
  "Stewed on it for",
  "Mulled it over for",
  "Wrestled with that for",
  "Chewed on that for",
  "Percolated for",
  "Meditated for",
  "Brooded for",
  "Schemed for",
  "Conjured an answer in",
  "Untangled that in",
  "Synthesized a response in",
  "Concocted something in",
  "Cooked that up in",
  "Extrapolated for",
  "Calculated for",
  "Hypothesized for",
  "Ratiocinated for",
  "Wrangled that in",
  "Divined an answer in",
  "Channeled the cosmos for",
  "Consulted the oracle in",
  "Cracked the enigma in",
  "Unraveled the mystery in",
  "Decoded that in",
  "Machinated for",
  "Plotted a response in",
  "Spun up the neurons for",
  "Fired up the synapses for",
  "Bootstrapped brilliance in",
  "Distilled wisdom in",
];

export class Renderer {
  private streamBuffer = "";
  private streamStarted = false;

  private thinkingTimer: ReturnType<typeof setInterval> | null = null;
  private thinkingWord = "";
  private thinkingFrame = 0;
  private thinkingActive = false;

  // ── thinking spinner ──────────────────────────────────────────────────────

  startThinking(): void {
    this.thinkingActive = true;
    this.thinkingFrame = 0;
    this.thinkingWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

    const tick = () => {
      const frame = chalk.yellow(SPINNER_FRAMES[this.thinkingFrame % SPINNER_FRAMES.length]);
      process.stdout.write(`\r${frame} ${chalk.dim(this.thinkingWord + "…")}`);
      this.thinkingFrame++;
    };

    process.stdout.write("\n");
    tick();
    this.thinkingTimer = setInterval(tick, 130);
  }

  stopThinking(): void {
    if (!this.thinkingActive) return;
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    process.stdout.write("\r\x1B[2K");
    this.thinkingActive = false;
  }

  printCogitated(ms: number, tokens?: number): void {
    const timeStr =
      ms >= 60_000
        ? `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`
        : `${(ms / 1000).toFixed(1)}s`;
    const phrase = COGITATED_PHRASES[Math.floor(Math.random() * COGITATED_PHRASES.length)];
    const tokenPart = tokens
      ? chalk.blue(` · ${tokens.toLocaleString()} tokens`)
      : "";
    console.log(`\n${chalk.blue("✻")} ${chalk.blue(phrase)} ${chalk.bold.blue(timeStr)}${tokenPart}`);
  }

  // ── stream deltas ─────────────────────────────────────────────────────────

  onDelta(delta: Delta): void {
    switch (delta.type) {
      case "text":
        if (delta.text) {
          if (!this.streamStarted) {
            this.stopThinking();
            this.streamStarted = true;
          }
          process.stdout.write(delta.text);
          this.streamBuffer += delta.text;
        }
        break;

      case "tool_call_start":
        this.stopThinking();
        if (this.streamBuffer && !this.streamBuffer.endsWith("\n")) {
          process.stdout.write("\n");
        }
        this.streamBuffer = "";
        this.streamStarted = false;
        break;

      case "done":
        if (this.streamBuffer && !this.streamBuffer.endsWith("\n")) {
          process.stdout.write("\n");
        }
        this.streamBuffer = "";
        this.streamStarted = false;
        break;
    }
  }

  // ⏺ Update(src/cli.ts)
  printToolCall(name: string, args: string): void {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(args); } catch { /* ignore */ }

    const verb = TOOL_VERB[name] ?? capitalize(name);
    const argStr = formatToolArgs(name, parsed);
    const color = toolColor(name);
    console.log(`\n${color(chalk.bold("⏺"))} ${color(chalk.bold(verb))}${chalk.dim("(")}${chalk.dim(argStr)}${chalk.dim(")")}`);
  }

  // ⎿  42 lines written
  printToolResult(name: string, result: string): void {
    const summary = summarizeResult(name, result);
    if (summary) {
      console.log(`  ${chalk.dim("⎿")}  ${chalk.dim(summary)}`);
    }
  }

  // ● Error: ...
  printError(msg: string): void {
    console.error(`\n${DOT.error} ${chalk.red(msg)}`);
  }

  // ● info text
  printInfo(msg: string): void {
    console.log(`${DOT.info} ${chalk.blue(msg)}`);
  }

  printPrompt(): void {
    process.stdout.write(chalk.bold.cyan("you") + chalk.dim("> "));
  }

  printUserMessage(text: string): void {
    const chevron = chalk.bgGray.bold.white(" › ");
    const content = chalk.bgGray.white(` ${text} `);
    console.log(`\n${chevron}${content}`);
  }

  printCommandResult(msg: string): void {
    console.log(`    ${ELBOW} ${msg}`);
  }

  printWelcome(_sessionId: string, model: string, _recentSessions: number): void {
    const BOX = 68;
    const INNER = BOX - 2; // 66
    const username = os.userInfo().username;
    const home = os.homedir();

    const stripAnsi = (s: string): string =>
      s.replace(/\x1B\[[0-9;]*m/g, "");

    const row = (text: string): string => {
      const vis = stripAnsi(text).length;
      const pad = INNER - vis;
      const l = Math.floor(pad / 2);
      const r = pad - l;
      return (
        chalk.gray("│") +
        " ".repeat(Math.max(0, l)) +
        text +
        " ".repeat(Math.max(0, r)) +
        chalk.gray("│")
      );
    };

    const empty = chalk.gray("│") + " ".repeat(INNER) + chalk.gray("│");

    const titleLabel = "─ ai-cli ";
    const top =
      chalk.gray("╭") +
      chalk.gray(titleLabel) +
      chalk.gray("─".repeat(INNER - titleLabel.length)) +
      chalk.gray("╮");
    const bot = chalk.gray("╰" + "─".repeat(INNER) + "╯");

    const art = ["▐▛███▜▌", "▝▜█████▛▘", "▘▘ ▝▝"];

    const rawCwd = process.cwd().startsWith(home)
      ? "~" + process.cwd().slice(home.length)
      : process.cwd();
    const cwd = truncatePath(rawCwd, 44);

    const isLocal = model.startsWith("llama:") || model.startsWith("ollama:");
    const providerLabel = isLocal ? "Local Model" : "OpenAI API";

    console.log();
    console.log(top);
    console.log(empty);
    console.log(row(`Welcome back ${chalk.bold(username)}!`));
    console.log(empty);
    console.log(empty);
    console.log(empty);
    for (const line of art) {
      console.log(row(line));
    }
    console.log(empty);
    console.log(row(chalk.bold(model)));
    console.log(row(chalk.dim(providerLabel)));
    console.log(row(chalk.dim(cwd)));
    console.log(empty);
    console.log(bot);
    console.log();
  }

  printHelp(): void {
    const b  = chalk.cyan;
    const bb = chalk.bold.cyan;
    const dim = chalk.dim;
    console.log();
    console.log(`${bb("Commands")}`);
    console.log(`  ${b("/help")}           ${dim("Show this help")}`);
    console.log(`  ${b("/model")}          ${dim("Interactive model picker")}`);
    console.log(`  ${b("/model <name>")}   ${dim("Switch directly, e.g. /model gpt-4o-mini")}`);
    console.log(`  ${b("/sessions")}       ${dim("List sessions for this directory")}`);
    console.log(`  ${b("/clear")}          ${dim("Clear conversation")}`);
    console.log(`  ${b("/compact")}        ${dim("Force context compression")}`);
    console.log(`  ${b("/context")}        ${dim("Show token usage + model")}`);
    console.log(`  ${b("/init")}           ${dim("Create a MEMORY.md for this project")}`);
    console.log(`  ${b("/exit")}           ${dim("Exit")}`);
    console.log();
    console.log(`${bb("Model prefixes")}`);
    console.log(`  ${dim("ollama:<name>")}    e.g. ${dim("ollama:qwen3.5:7b")}`);
    console.log(`  ${dim("llama:<path>")}     e.g. ${dim("llama:~/models/Qwen3.5-9B-Q4_K_M.gguf")}`);
    console.log();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  return "…" + p.slice(-(maxLen - 1));
}

function formatToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `${args.path}${args.offset ? `:${args.offset}` : ""}`;
    case "write_file":
      return String(args.path);
    case "edit_file":
      return String(args.path);
    case "list_dir":
      return String(args.path ?? ".");
    case "bash":
      return String(args.command ?? "").slice(0, 80);
    case "glob":
      return String(args.pattern);
    case "grep":
      return `/${args.pattern}/${args.case_insensitive ? "i" : ""} ${args.path ? `in ${args.path}` : ""}`.trim();
    case "fetch_url":
      return String(args.url).slice(0, 80);
    case "web_search":
      return String(args.query);
    case "todo_write":
      return `${(args.todos as unknown[])?.length ?? 0} items`;
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

function summarizeResult(name: string, result: string): string {
  if (result.startsWith("Error")) return result.split("\n")[0].slice(0, 120);

  switch (name) {
    case "bash": {
      const lines = result.split("\n").filter(Boolean);
      const exitLine = lines.find((l) => l.startsWith("exit code:"));
      const firstOutput = lines.find((l) => !l.startsWith("exit code:") && !l.startsWith("stdout:") && !l.startsWith("stderr:"));
      const parts = [firstOutput, exitLine].filter(Boolean);
      return parts.join("  ·  ").slice(0, 120);
    }
    case "read_file": {
      const match = result.match(/Lines: \d+-\d+ of (\d+)/);
      return match ? `${match[1]} lines` : result.split("\n")[0].slice(0, 80);
    }
    case "write_file":
      return result.slice(0, 80);
    case "edit_file":
      return result.slice(0, 80);
    case "list_dir": {
      const lastLine = result.split("\n").filter(Boolean).pop() ?? "";
      return lastLine;
    }
    case "glob": {
      const match = result.match(/Found (\d+) file/);
      return match ? `${match[1]} files matched` : result.split("\n")[0];
    }
    case "grep": {
      const match = result.match(/Found (\d+)/);
      return match ? `${match[1]} matches` : result.split("\n")[0];
    }
    case "fetch_url":
      return result.split("\n")[0].slice(0, 80);
    case "web_search":
      return result.split("\n")[0].slice(0, 80);
    case "todo_write":
      return result.slice(0, 80);
    default:
      return result.split("\n")[0].slice(0, 100);
  }
}
