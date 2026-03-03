import type { LLMProvider, Message } from "../llm/provider.js";
import type { ToolRegistry, ToolContext } from "../tools/index.js";
import type { PlannerState } from "./planner.js";
import type { SteeringQueue, SteeringEvent } from "./queue.js";
import type { ContextCompressor } from "./compressor.js";
import type { Renderer } from "../ui/renderer.js";

export interface AgentLoopOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  planner: PlannerState;
  steeringQueue: SteeringQueue<SteeringEvent>;
  compressor: ContextCompressor;
  renderer: Renderer;
  toolCtx: ToolContext;
  systemPrompt: string;
}

export class AgentLoop {
  private messages: Message[] = [];
  private opts: AgentLoopOptions;
  private interrupted = false;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    this.messages.push({
      role: "system",
      content: opts.systemPrompt,
    });
  }

  getMessages(): Message[] {
    return this.messages;
  }

  setMessages(messages: Message[]): void {
    this.messages = messages;
  }

  setProvider(provider: LLMProvider): void {
    this.opts.provider = provider;
  }

  getProvider(): LLMProvider {
    return this.opts.provider;
  }

  async run(userInput: string): Promise<string> {
    const { provider, tools, planner, steeringQueue, compressor, renderer, toolCtx } =
      this.opts;

    this.interrupted = false;
    this.messages.push({ role: "user", content: userInput });

    let finalResponse = "";
    let totalTokens = 0;
    const runStart = Date.now();

    while (true) {
      // Check for steering interrupts before each LLM call
      const interrupt = steeringQueue.tryNext();
      if (interrupt?.type === "interrupt") {
        this.messages.push({ role: "user", content: interrupt.text });
        renderer.printInfo(`\n[Interrupted] ${interrupt.text}`);
      }

      // Compress context if approaching limit
      await compressor.maybeCompress(this.messages, provider);

      // Call the LLM
      let response;
      renderer.startThinking();
      try {
        response = await provider.complete(
          this.messages,
          tools.getDefinitions(),
          (delta) => renderer.onDelta(delta)
        );
      } catch (err) {
        renderer.stopThinking();
        const msg = `LLM error: ${(err as Error).message}`;
        renderer.printError(msg);
        return msg;
      }

      totalTokens += response.usage?.total_tokens ?? 0;
      this.messages.push(response.message);

      // No tool calls → loop ends, print summary and return final text
      if (
        !response.message.tool_calls ||
        response.message.tool_calls.length === 0
      ) {
        renderer.printCogitated(Date.now() - runStart, totalTokens || undefined);
        finalResponse = response.message.content ?? "";
        break;
      }

      // Execute all tool calls in this round
      for (const toolCall of response.message.tool_calls) {
        const name = toolCall.function.name;
        const args = toolCall.function.arguments;

        renderer.printToolCall(name, args);

        const result = await tools.execute(name, args, toolCtx);

        renderer.printToolResult(name, result);

        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
          name,
        });
      }

      // Inject TODO reminder as a system message after each round
      const todoReminder = planner.toReminderText();
      if (todoReminder) {
        this.messages.push({
          role: "user",
          content: `[System reminder]${todoReminder}`,
        });
      }
    }

    return finalResponse;
  }

  interrupt(text: string): void {
    this.interrupted = true;
    this.opts.steeringQueue.push({ type: "interrupt", text });
  }
}
