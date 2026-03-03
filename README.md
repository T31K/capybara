# ai-cli

An agentic AI CLI tool — a local alternative to Claude Code that can run any model.

## Features

- **Agentic loop** — the model thinks, calls tools, reads results, and repeats until done
- **File tools** — read, write, and patch files with colorized diffs and undo snapshots
- **Search tools** — glob file patterns, grep with regex (uses ripgrep if available)
- **Shell execution** — run bash commands with risk classification and permission prompts
- **Session memory** — conversations persist locally at `~/.ai-cli/projects/`
- **Project memory** — place a `MEMORY.md` in your project root for persistent instructions
- **Context compressor** — automatically summarizes at ~90% context window usage
- **Provider-agnostic** — OpenAI today, easily swap to Anthropic, Ollama, etc.

## Install

### 1. Install dependencies

```bash
npm install
```

### 2. Download the default model (Qwen3.5 9B Q4)

```bash
mkdir -p models
curl -L -o models/Qwen3.5-9B-Q4_K_M.gguf \
  "https://huggingface.co/Qwen/Qwen3.5-9B-Instruct-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
```

Model files go in the `./models/` directory relative to where you run the CLI.

### 3. Build and run

```bash
npm run build
node dist/cli.js
```


## Project Memory
Create a `MEMORY.md` in your project root:


## Architecture

```
src/
  cli.ts             Entry point, arg parsing, REPL
  agent/
    loop.ts          Master agent loop
    queue.ts         Async steering queue for mid-task interrupts
    compressor.ts    Context compressor (~90% token limit)
    planner.ts       TODO list tracker
  tools/
    index.ts         Tool registry + JSON schema definitions
    file.ts          read_file, write_file, edit_file
    search.ts        glob, grep
    exec.ts          bash (sandboxed, risk-classified)
    web.ts           fetch_url (web_search coming soon)
    agent.ts         spawn_subagent (depth-limited)
  llm/
    provider.ts      Abstract LLMProvider interface
    openai.ts        OpenAI streaming implementation
  memory/
    session.ts       Session persistence (JSONL)
    project.ts       MEMORY.md loader
    snapshots.ts     File snapshots for undo
  ui/
    renderer.ts      Streaming output, diffs, spinners
  permissions.ts     Allow/deny for writes and shell commands
```

