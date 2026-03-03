import type { LLMProvider, Message } from "../llm/provider.js";

const COMPRESSION_THRESHOLD = 0.90; // compress at 90% context usage

export class ContextCompressor {
  private compressionCount = 0;

  async maybeCompress(
    messages: Message[],
    provider: LLMProvider
  ): Promise<boolean> {
    const tokenCount = provider.countTokens(messages);
    const usageRatio = tokenCount / provider.contextLimit;

    if (usageRatio < COMPRESSION_THRESHOLD) return false;

    await this.compress(messages, provider);
    return true;
  }

  private async compress(
    messages: Message[],
    provider: LLMProvider
  ): Promise<void> {
    this.compressionCount++;

    // Keep the system prompt and recent messages intact
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Keep the last 10 messages as recent context
    const recentCount = 10;
    const toSummarize = nonSystemMessages.slice(0, -recentCount);
    const recent = nonSystemMessages.slice(-recentCount);

    if (toSummarize.length === 0) return;

    // Summarize old messages
    const summary = await provider.summarize(toSummarize);

    // Build compressed message list
    const summaryMessage: Message = {
      role: "user",
      content: `[Conversation summary (compression #${this.compressionCount})]\n${summary}`,
    };

    // Splice in-place
    messages.splice(
      0,
      messages.length,
      ...systemMessages,
      summaryMessage,
      ...recent
    );
  }

  get compressions(): number {
    return this.compressionCount;
  }
}
