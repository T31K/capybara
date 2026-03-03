import path from "path";
import os from "os";
import { existsSync } from "fs";
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  CompletionResponse,
  Delta,
  ToolCall,
} from "./provider.js";

// Thrown from inside a tool handler to stop inference and capture the call
class ToolCallCaptured extends Error {
  constructor(
    public readonly toolName: string,
    public readonly toolParams: unknown
  ) {
    super("__tool_call_captured__");
    Object.setPrototypeOf(this, ToolCallCaptured.prototype);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llamaInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modelCache = new Map<string, any>();

async function getLlamaInstance() {
  if (!llamaInstance) {
    const { getLlama } = await import("node-llama-cpp");
    llamaInstance = await getLlama();
  }
  return llamaInstance;
}

function resolveAbsPath(modelPath: string): string {
  if (modelPath.startsWith("~")) {
    return modelPath.replace(/^~/, os.homedir());
  }
  if (modelPath.startsWith("./") || modelPath.startsWith("../")) {
    return path.resolve(process.cwd(), modelPath);
  }
  if (!path.isAbsolute(modelPath)) {
    // Bare filename → look in ./models/ relative to cwd
    return path.join(process.cwd(), "models", modelPath);
  }
  return modelPath;
}

async function loadModel(modelPath: string) {
  const resolved = resolveAbsPath(modelPath);
  if (!modelCache.has(resolved)) {
    if (!existsSync(resolved)) {
      throw new Error(
        `Model file not found: ${resolved}\n` +
          `Download a GGUF model and place it in the ./models/ directory.\n` +
          `Example:\n` +
          `  curl -L -o models/Qwen3.5-9B-Q4_K_M.gguf \\\n` +
          `    "https://huggingface.co/Qwen/Qwen3.5-9B-Instruct-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"`
      );
    }
    const llama = await getLlamaInstance();
    const model = await llama.loadModel({ modelPath: resolved, gpuLayers: 0 });
    modelCache.set(resolved, model);
  }
  return modelCache.get(resolved)!;
}

/**
 * Convert OpenAI-style messages to node-llama-cpp ChatHistoryItem[].
 *
 * Rules:
 *  - assistant messages with tool_calls are paired with subsequent tool
 *    messages that share the same tool_call_id, forming a "functionCall" entry.
 *  - Orphaned tool messages (no matching assistant call) are skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messagesToChatHistory(messages: Message[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history: any[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "system") {
      history.push({ type: "system", text: msg.content ?? "" });
      i++;
    } else if (msg.role === "user") {
      history.push({ type: "user", text: msg.content ?? "" });
      i++;
    } else if (msg.role === "assistant") {
      if (msg.tool_calls?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: any[] = [];
        if (msg.content) response.push(msg.content);

        for (const tc of msg.tool_calls) {
          // Find matching tool result message
          let result = "";
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === "tool" && messages[j].tool_call_id === tc.id) {
              result = messages[j].content ?? "";
              break;
            }
          }

          let params: unknown = {};
          try {
            params = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* keep empty object */
          }

          response.push({
            type: "functionCall",
            name: tc.function.name,
            params,
            result,
          });
        }

        history.push({ type: "model", response });

        // Skip the paired tool messages
        i++;
        while (i < messages.length && messages[i].role === "tool") {
          i++;
        }
      } else {
        history.push({ type: "model", response: [msg.content ?? ""] });
        i++;
      }
    } else {
      // Skip orphaned tool messages or unknown roles
      i++;
    }
  }

  return history;
}

export function resolveModelPath(modelOrPath: string): string {
  // Bare filename (no path separators) → default models dir
  if (!modelOrPath.includes("/") && !modelOrPath.includes("\\")) {
    return path.join("~", ".cache", "ai-cli", "models", modelOrPath);
  }
  return modelOrPath; // absolute or ~/relative — resolveAbsPath handles expansion later
}

export class LlamaCppProvider implements LLMProvider {
  readonly model: string;
  readonly contextLimit: number;
  private readonly modelPath: string;

  constructor(modelPath: string, contextLimit = 2_048) {
    this.modelPath = modelPath;
    this.model = path.basename(modelPath);
    this.contextLimit = contextLimit;
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onDelta?: (delta: Delta) => void
  ): Promise<CompletionResponse> {
    const { LlamaChatSession } = await import("node-llama-cpp");

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) throw new Error("No messages provided");

    // After tool execution the last message is role "tool" — use all messages
    // as history and inject a minimal continuation signal so the model responds.
    let historyMessages: Message[];
    let lastUserMessage: string;

    if (lastMsg.role === "user") {
      historyMessages = messages.slice(0, -1);
      lastUserMessage = lastMsg.content ?? "";
    } else {
      // tool / assistant continuation
      historyMessages = messages;
      lastUserMessage = "Continue.";
    }

    const llamaModel = await loadModel(this.modelPath);
    const context = await llamaModel.createContext({ contextSize: this.contextLimit });

    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      if (historyMessages.length > 0) {
        const history = messagesToChatHistory(historyMessages);
        await session.setChatHistory(history);
      }

      // Build node-llama-cpp functions map; throw to capture the first tool call
      let fullText = "";
      let capturedCall: ToolCall | null = null;
      const bufferedChunks: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const functions: Record<string, any> = {};
      for (const tool of tools) {
        const toolName = tool.function.name;
        functions[toolName] = {
          description: tool.function.description,
          params: tool.function.parameters,
          handler: (params: unknown) => {
            throw new ToolCallCaptured(toolName, params);
          },
        };
      }

      try {
        await (session.prompt as Function)(lastUserMessage, {
          functions: tools.length > 0 ? functions : undefined,
          onTextChunk: (chunk: string) => {
            fullText += chunk;
            bufferedChunks.push(chunk);
          },
        });
      } catch (e) {
        if (!(e instanceof ToolCallCaptured)) throw e;
        // Handler threw — capture the tool call
        fullText = "";
        const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        capturedCall = {
          id,
          type: "function",
          function: { name: e.toolName, arguments: JSON.stringify(e.toolParams) },
        };
        onDelta?.({ type: "tool_call_start", index: 0, tool_call: capturedCall });
        onDelta?.({ type: "tool_call_end", tool_call: capturedCall });
      }

      // Fallback: if no handler fired, parse grammar-format output directly.
      // node-llama-cpp grammar forces: ||functionName(params: {JSON})
      if (!capturedCall && tools.length > 0) {
        const parsed = parseGrammarFunctionCall(fullText);
        if (parsed && functions[parsed.name]) {
          fullText = "";
          const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          capturedCall = {
            id,
            type: "function",
            function: { name: parsed.name, arguments: parsed.args },
          };
          onDelta?.({ type: "tool_call_start", index: 0, tool_call: capturedCall });
          onDelta?.({ type: "tool_call_end", tool_call: capturedCall });
        }
      }

      // Only emit text if no tool call was captured
      if (!capturedCall) {
        for (const chunk of bufferedChunks) {
          onDelta?.({ type: "text", text: chunk });
        }
      }

      onDelta?.({ type: "done" });

      const message: Message = capturedCall
        ? { role: "assistant", content: fullText || null, tool_calls: [capturedCall] }
        : { role: "assistant", content: fullText };

      return { message };
    } finally {
      await context.dispose();
    }
  }

  async summarize(messages: Message[]): Promise<string> {
    const { LlamaChatSession } = await import("node-llama-cpp");

    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => `[${m.role}]: ${m.content ?? "(tool call)"}`)
      .join("\n");

    const llamaModel = await loadModel(this.modelPath);
    const context = await llamaModel.createContext({ contextSize: this.contextLimit });
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });
      return await session.prompt(
        `Produce a concise summary of the following conversation, preserving key decisions, code changes made, and important context:\n\n${transcript}`
      );
    } finally {
      await context.dispose();
    }
  }

  countTokens(messages: Message[]): number {
    const totalChars = messages.reduce((sum, m) => {
      const content = typeof m.content === "string" ? m.content : "";
      const toolContent = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
      return sum + content.length + toolContent.length;
    }, 0);
    return Math.ceil(totalChars / 4);
  }
}

/**
 * Parse node-llama-cpp grammar-constrained function call text.
 * Format: ||functionName(params: {JSON})
 */
function parseGrammarFunctionCall(text: string): { name: string; args: string } | null {
  const match = text.match(/\|\|(\w+)\((?:params:\s*)?/);
  if (!match || match.index == null) return null;

  const name = match[1];
  const jsonStart = match.index + match[0].length;

  // Walk forward to find the balanced closing } of the JSON object
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }

  if (jsonEnd === -1) return null;

  const args = text.slice(jsonStart, jsonEnd);
  try {
    JSON.parse(args); // validate
    return { name, args };
  } catch {
    return null;
  }
}
