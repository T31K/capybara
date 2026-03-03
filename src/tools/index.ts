import type { ToolDefinition } from "../llm/provider.js";

export interface ToolContext {
  cwd: string;
  autoAccept: boolean;
  subagentDepth: number;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    rawArgs: string,
    ctx: ToolContext
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return `Error: Invalid JSON arguments for tool "${name}": ${rawArgs}`;
    }

    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing ${name}: ${msg}`;
    }
  }
}
