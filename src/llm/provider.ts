export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Delta {
  type: "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done";
  text?: string;
  tool_call?: ToolCall;
  index?: number;
}

export interface CompletionResponse {
  message: Message;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMProvider {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    onDelta?: (delta: Delta) => void
  ): Promise<CompletionResponse>;

  summarize(messages: Message[]): Promise<string>;

  countTokens(messages: Message[]): number;

  readonly model: string;
  readonly contextLimit: number;
}
