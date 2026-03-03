import OpenAI from "openai";
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  CompletionResponse,
  Delta,
  ToolCall,
} from "./provider.js";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  readonly model: string;
  readonly contextLimit: number;
  readonly baseURL: string | undefined;

  constructor(apiKey?: string, model = "gpt-4o", baseURL?: string) {
    this.baseURL = baseURL;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? "ollama",
      baseURL,
    });
    this.model = model;
    // Context limits by model (local models default to 32k)
    const limits: Record<string, number> = {
      "gpt-4o": 128_000,
      "gpt-4o-mini": 128_000,
      "gpt-4-turbo": 128_000,
      "gpt-3.5-turbo": 16_385,
    };
    this.contextLimit = limits[model] ?? 32_768;
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onDelta?: (delta: Delta) => void
  ): Promise<CompletionResponse> {
    const openaiMessages = messages.map(toOpenAIMessage);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: tools.length > 0 ? (tools as OpenAI.Chat.ChatCompletionTool[]) : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullText = "";
    const toolCallAccumulators: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) {
        if (chunk.usage) usage = chunk.usage;
        continue;
      }

      const delta = choice.delta;

      if (delta.content) {
        fullText += delta.content;
        onDelta?.({ type: "text", text: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
            onDelta?.({
              type: "tool_call_start",
              index: idx,
              tool_call: {
                id: tc.id ?? "",
                type: "function",
                function: { name: tc.function?.name ?? "", arguments: "" },
              },
            });
          }
          const acc = toolCallAccumulators.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) {
            acc.arguments += tc.function.arguments;
            onDelta?.({
              type: "tool_call_delta",
              index: idx,
              tool_call: {
                id: acc.id,
                type: "function",
                function: { name: acc.name, arguments: tc.function.arguments },
              },
            });
          }
        }
      }

      if (chunk.usage) usage = chunk.usage;
    }

    const tool_calls: ToolCall[] = [];
    for (const [, acc] of toolCallAccumulators) {
      const tc: ToolCall = {
        id: acc.id,
        type: "function",
        function: { name: acc.name, arguments: acc.arguments },
      };
      tool_calls.push(tc);
      onDelta?.({ type: "tool_call_end", tool_call: tc });
    }

    onDelta?.({ type: "done" });

    const message: Message = {
      role: "assistant",
      content: fullText || null,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
    };

    return { message, usage };
  }

  async summarize(messages: Message[]): Promise<string> {
    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => `[${m.role}]: ${m.content ?? "(tool call)"}`)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "You are a summarizer. Produce a concise summary of the following conversation, preserving key decisions, code changes made, and important context for continuing the task.",
        },
        { role: "user", content: transcript },
      ],
    });

    return response.choices[0]?.message.content ?? "";
  }

  countTokens(messages: Message[]): number {
    // Rough estimate: ~4 chars per token
    const totalChars = messages.reduce((sum, m) => {
      const content = typeof m.content === "string" ? m.content : "";
      const toolContent = m.tool_calls
        ? JSON.stringify(m.tool_calls)
        : "";
      return sum + content.length + toolContent.length;
    }, 0);
    return Math.ceil(totalChars / 4);
  }
}

function toOpenAIMessage(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === "system") {
    return { role: "system", content: m.content ?? "" };
  }
  if (m.role === "user") {
    return { role: "user", content: m.content ?? "" };
  }
  if (m.role === "assistant") {
    const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: m.content ?? null,
    };
    if (m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: tc.function,
      }));
    }
    return msg;
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content ?? "",
      tool_call_id: m.tool_call_id ?? "",
    };
  }
  throw new Error(`Unknown role: ${(m as Message).role}`);
}
