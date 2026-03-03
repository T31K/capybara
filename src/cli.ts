#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";

import { ToolRegistry } from "./tools/index.js";
import { createProvider, parseModelString, MODEL_PRESETS, type ModelPreset } from "./llm/factory.js";
import { readFileTool, writeFileTool, editFileTool, listDirTool } from "./tools/file.js";
import { globTool, grepTool } from "./tools/search.js";
import { bashTool } from "./tools/exec.js";
import { fetchUrlTool, webSearchTool } from "./tools/web.js";
import { PlannerState, todoWriteTool } from "./agent/planner.js";
import { SteeringQueue } from "./agent/queue.js";
import { AgentLoop } from "./agent/loop.js";
import { ContextCompressor } from "./agent/compressor.js";
import { Renderer } from "./ui/renderer.js";
import { SessionManager } from "./memory/session.js";
import { buildSystemPrompt } from "./memory/project.js";

const program = new Command();

program
  .name("ai")
  .description("An agentic AI CLI tool")
  .version("0.1.0")
  .option("-p, --prompt <text>", "Run a one-shot prompt and exit")
  .option("-y, --yes", "Auto-accept all file writes and safe commands")
  .option("-c, --continue", "Continue the last session")
  .option("-r, --resume <id>", "Resume a specific session by ID")
  .option("-m, --model <name>", "Model to use (default: llama-qwen3.5-9b)", "llama-qwen3.5-9b")
  .option("--base-url <url>", "Custom OpenAI-compatible API base URL")
  .option("--cwd <path>", "Working directory (default: process.cwd())")
  .parse(process.argv);

const opts = program.opts<{
  prompt?: string;
  yes: boolean;
  continue: boolean;
  resume?: string;
  model: string;
  baseUrl?: string;
  cwd?: string;
}>();

// ── command history ────────────────────────────────────────────────────────────
const inputHistory: string[] = [];
let historyIdx = 0;

// ── raw-mode bottom input box ─────────────────────────────────────────────────
//
//  ─────────────────────────────────────────
//  › user types here█
//  ─────────────────────────────────────────
//
function getInput(sessionMgr: SessionManager, loop: AgentLoop): Promise<string | null> {
  return new Promise((resolve) => {
    const width = process.stdout.columns || 80;
    const sep = chalk.dim("─".repeat(width));
    let value = "";
    historyIdx = inputHistory.length;

    const draw = (isFirst: boolean) => {
      if (!isFirst) {
        // Cursor is on the input line — move up 1 to top separator
        process.stdout.write(`\x1B[1F`);
      }
      process.stdout.write(`\x1B[2K${sep}\n`);
      process.stdout.write(`\x1B[2K${chalk.bold.cyan("›")} ${value}\n`);
      process.stdout.write(`\x1B[2K${sep}\n`);
      // Move cursor back up to the input line, positioned after the typed value
      process.stdout.write(`\x1B[2A\x1B[${3 + value.length}G`);
    };

    const clear = () => {
      // Cursor is on the input line — move up 1 to top separator
      process.stdout.write(`\x1B[1F`);
      process.stdout.write(`\x1B[2K\n\x1B[2K\n\x1B[2K\n`);
      process.stdout.write(`\x1B[3A`);
    };

    draw(true);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      clear();
    };

    const onKey = (key: string) => {
      if (key === "\r") {
        // Enter
        const trimmed = value.trim();
        cleanup();
        if (trimmed && inputHistory[inputHistory.length - 1] !== trimmed) {
          inputHistory.push(trimmed);
        }
        resolve(trimmed);
      } else if (key === "\x03") {
        // Ctrl+C — save & exit
        cleanup();
        sessionMgr.save(loop.getMessages()).finally(() => {
          console.log(chalk.dim("\nSession saved."));
          process.exit(0);
        });
      } else if (key === "\x04") {
        // Ctrl+D — exit
        cleanup();
        resolve(null);
      } else if (key === "\x7f" || key === "\x08") {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          draw(false);
        }
      } else if (key === "\x1B[A") {
        // Up — history prev
        if (inputHistory.length > 0 && historyIdx > 0) {
          historyIdx--;
          value = inputHistory[historyIdx];
          draw(false);
        }
      } else if (key === "\x1B[B") {
        // Down — history next
        if (historyIdx < inputHistory.length - 1) {
          historyIdx++;
          value = inputHistory[historyIdx];
        } else {
          historyIdx = inputHistory.length;
          value = "";
        }
        draw(false);
      } else if (key.startsWith("\x1B")) {
        // Other escape sequences (e.g. left/right) — ignore
      } else if (key >= " " || key.charCodeAt(0) > 31) {
        value += key;
        draw(false);
      }
    };

    process.stdin.on("data", onKey);
  });
}

// ── self-contained raw-mode single-line prompt ────────────────────────────────
function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = "";

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKey = (key: string) => {
      if (key === "\r") {
        cleanup();
        process.stdout.write("\n");
        resolve(value.trim());
      } else if (key === "\x03" || key === "\x1B") {
        cleanup();
        process.stdout.write("\n");
        resolve("");
      } else if (key === "\x7f" || key === "\x08") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write(`\r\x1B[2K${prompt}${value}`);
        }
      } else if (!key.startsWith("\x1B") && key >= " ") {
        value += key;
        process.stdout.write(key);
      }
    };

    process.stdin.on("data", onKey);
  });
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  const cwd = opts.cwd ?? process.cwd();
  const autoAccept = opts.yes ?? false;
  const model = opts.model;

  const parsed = parseModelString(model);
  const baseURL = opts.baseUrl ?? parsed.baseURL;
  const isLocal = !!baseURL || parsed.model.startsWith("llama:");

  const provider = createProvider({
    model: parsed.model,
    baseURL,
    apiKey: isLocal ? "ollama" : process.env.OPENAI_API_KEY,
  });

  const renderer = new Renderer();
  const planner = new PlannerState();
  const steeringQueue = new SteeringQueue<{ type: "interrupt" | "inject"; text: string }>();
  const compressor = new ContextCompressor();

  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(listDirTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(fetchUrlTool);
  registry.register(webSearchTool);
  const todoTool = todoWriteTool(planner);
  registry.register({
    definition: { type: "function", function: todoTool.definition.function },
    execute: (args) => todoTool.execute(args),
  });

  let sessionId: string | undefined;
  if (opts.resume) {
    sessionId = opts.resume;
  } else if (opts.continue) {
    sessionId = (await SessionManager.getLatestSession(cwd)) ?? undefined;
  }

  const sessionMgr = new SessionManager(cwd, sessionId);
  await sessionMgr.init();

  const isLlamaCpp = parsed.model.startsWith("llama:");
  const systemPrompt = await buildSystemPrompt(cwd, isLlamaCpp);

  const toolCtx = { cwd, autoAccept, subagentDepth: 0 };

  const loop = new AgentLoop({
    provider,
    tools: registry,
    planner,
    steeringQueue,
    compressor,
    renderer,
    toolCtx,
    systemPrompt,
  });

  if (sessionId) {
    const saved = await sessionMgr.load();
    if (saved.length > 0) {
      loop.setMessages(saved);
      renderer.printInfo(`Resumed session ${sessionMgr.sessionId.slice(0, 8)} (${saved.length} messages)`);
    }
  }

  // One-shot mode
  if (opts.prompt) {
    const response = await loop.run(opts.prompt);
    await sessionMgr.save(loop.getMessages());
    if (!response.endsWith("\n")) console.log();
    process.exit(0);
  }

  // Interactive REPL
  const allSessions = await SessionManager.listSessions(cwd);
  const recentCount = allSessions.filter((s) => s.id !== sessionMgr.sessionId).length;
  renderer.printWelcome(sessionMgr.sessionId, model, recentCount);

  // SIGINT during AI inference (raw mode is off at that point)
  process.on("SIGINT", async () => {
    await sessionMgr.save(loop.getMessages());
    console.log(chalk.dim("\nSession saved."));
    process.exit(0);
  });

  while (true) {
    const input = await getInput(sessionMgr, loop);

    if (input === null || input === "/exit" || input === "/quit") {
      await sessionMgr.save(loop.getMessages());
      console.log(chalk.dim(`Session saved: ${sessionMgr.sessionId}`));
      break;
    }

    if (!input) continue;

    renderer.printUserMessage(input);

    const handled = await handleCommand(input, loop, sessionMgr, renderer, cwd);
    if (handled) continue;

    try {
      await loop.run(input);
      await sessionMgr.save(loop.getMessages());
    } catch (err) {
      renderer.printError(`Unexpected error: ${(err as Error).message}`);
    }

    console.log();
  }
}

// ── slash commands ─────────────────────────────────────────────────────────────
async function handleCommand(
  input: string,
  loop: AgentLoop,
  session: SessionManager,
  renderer: Renderer,
  cwd: string
): Promise<boolean> {
  if (input === "/help") {
    renderer.printHelp();
    return true;
  }

  if (input === "/clear") {
    loop.setMessages([]);
    renderer.printCommandResult("Conversation cleared.");
    return true;
  }

  if (input === "/context") {
    const messages = loop.getMessages();
    const p = loop.getProvider();
    const tokens = p.countTokens(messages);
    const pct = ((tokens / p.contextLimit) * 100).toFixed(1);
    renderer.printCommandResult(`tokens: ${chalk.bold(`${tokens.toLocaleString()} / ${p.contextLimit.toLocaleString()}`)} (${pct}%)`);
    renderer.printCommandResult(`messages: ${chalk.bold(String(messages.length))}`);
    renderer.printCommandResult(`model: ${chalk.bold(p.model)}`);
    return true;
  }

  if (input === "/compact") {
    const messages = loop.getMessages();
    const p = loop.getProvider();
    const orig = p.countTokens.bind(p);
    p.countTokens = () => p.contextLimit;
    const { ContextCompressor } = await import("./agent/compressor.js");
    await new ContextCompressor().maybeCompress(messages, p);
    p.countTokens = orig;
    loop.setMessages(messages);
    renderer.printCommandResult(`Context compressed. ${chalk.bold(String(messages.length))} messages remaining.`);
    return true;
  }

  if (input === "/sessions") {
    const sessions = await SessionManager.listSessions(cwd);
    if (sessions.length === 0) {
      renderer.printCommandResult("No sessions for this directory.");
    } else {
      for (const s of sessions) {
        const date = new Date(s.updatedAt).toLocaleString();
        const isCurrent = s.id === session.sessionId;
        renderer.printCommandResult(
          `${isCurrent ? chalk.cyan("›") : " "} ${chalk.bold(s.id.slice(0, 8))}  ${s.messageCount} msgs  ${chalk.dim(date)}`
        );
      }
    }
    return true;
  }

  if (input === "/init") {
    const memPath = `${cwd}/MEMORY.md`;
    const { writeFile, access } = await import("fs/promises");
    try {
      await access(memPath);
      renderer.printCommandResult(`MEMORY.md already exists at ${chalk.bold(memPath)}`);
    } catch {
      const template = [
        "# Project Memory",
        "",
        "## Stack",
        "- (describe your tech stack here)",
        "",
        "## Conventions",
        "- (describe conventions)",
        "",
        "## Commands",
        "- Build: `npm run build`",
        "- Test: `npm test`",
      ].join("\n");
      await writeFile(memPath, template, "utf-8");
      renderer.printCommandResult(`Created ${chalk.bold("MEMORY.md")} at ${chalk.dim(memPath)}`);
    }
    return true;
  }

  if (input === "/model" || input.startsWith("/model ")) {
    await handleModelSwitch(input, loop, renderer);
    return true;
  }

  return false;
}

async function handleModelSwitch(input: string, loop: AgentLoop, renderer: Renderer): Promise<void> {
  const inlineArg = input.startsWith("/model ") ? input.slice(7).trim() : "";

  if (inlineArg) {
    switchToModel(inlineArg, loop, renderer);
    return;
  }

  const selected = await pickModelInteractive(loop.getProvider().model);
  if (!selected) return;

  if (selected === "custom") {
    const customModel = await askLine(chalk.cyan("  model name: "));
    if (!customModel) return;
    const customURL = await askLine(chalk.cyan("  base URL (blank for OpenAI): "));
    const parsed = parseModelString(customModel);
    const baseURL = customURL || parsed.baseURL;
    loop.setProvider(
      createProvider({
        model: parsed.model,
        baseURL,
        apiKey: baseURL ? "ollama" : process.env.OPENAI_API_KEY,
      })
    );
    renderer.printCommandResult(`Switched to ${chalk.bold(parsed.model)}${baseURL ? chalk.dim(` @ ${baseURL}`) : ""}`);
    return;
  }

  switchToModel(selected.id, loop, renderer);
}

async function pickModelInteractive(currentModel: string): Promise<ModelPreset | "custom" | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log();
    MODEL_PRESETS.forEach((p, i) => {
      console.log(`  ${chalk.cyan(String(i + 1))}. ${p.label}`);
    });
    const answer = await askLine(chalk.cyan("  enter number: "));
    if (!answer || answer === "q") return null;
    if (answer.toLowerCase() === "c") return "custom";
    return MODEL_PRESETS[parseInt(answer, 10) - 1] ?? null;
  }

  return new Promise((resolve) => {
    const totalItems = MODEL_PRESETS.length + 1; // +1 for custom
    let selected = Math.max(0, MODEL_PRESETS.findIndex((p) => p.model === currentModel));
    const menuLines = totalItems + 2; // title + blank + items

    const render = (isFirst: boolean) => {
      if (!isFirst) process.stdout.write(`\x1B[${menuLines}F`);

      process.stdout.write(`\x1B[2K${chalk.bold("Select a model")} ${chalk.dim("(↑↓  enter  esc)")}\n`);
      process.stdout.write(`\x1B[2K\n`);

      MODEL_PRESETS.forEach((p, i) => {
        const active = i === selected;
        const tag = p.local ? chalk.green("local") : chalk.dim("api");
        const cursor = active ? chalk.cyan("❯") : " ";
        const label = active ? chalk.bold.white(p.label) : chalk.dim(p.label);
        process.stdout.write(`\x1B[2K ${cursor} ${label}  ${tag}\n`);
      });

      const customActive = selected === MODEL_PRESETS.length;
      process.stdout.write(
        `\x1B[2K ${customActive ? chalk.cyan("❯") : " "} ${customActive ? chalk.bold.white("Custom model / URL") : chalk.dim("Custom model / URL")}\n`
      );
    };

    console.log();
    render(true);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log();
    };

    const onKey = (key: string) => {
      if (key === "\x1B[A") {
        selected = (selected - 1 + totalItems) % totalItems;
        render(false);
      } else if (key === "\x1B[B") {
        selected = (selected + 1) % totalItems;
        render(false);
      } else if (key === "\r") {
        cleanup();
        resolve(selected === MODEL_PRESETS.length ? "custom" : MODEL_PRESETS[selected]);
      } else if (key === "\x1B" || key === "q" || key === "\x03") {
        cleanup();
        resolve(null);
      }
    };

    process.stdin.on("data", onKey);
  });
}

function switchToModel(raw: string, loop: AgentLoop, renderer: Renderer): void {
  const parsed = parseModelString(raw);
  const isLocal = !!parsed.baseURL || parsed.model.startsWith("llama:");
  loop.setProvider(
    createProvider({
      model: parsed.model,
      baseURL: parsed.baseURL,
      apiKey: isLocal ? "ollama" : process.env.OPENAI_API_KEY,
    })
  );
  renderer.printCommandResult(`Switched to ${chalk.bold(parsed.model)}`);
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
