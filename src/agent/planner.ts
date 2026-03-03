export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "low" | "medium" | "high";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export class PlannerState {
  private todos: Map<string, TodoItem> = new Map();

  update(todos: TodoItem[]): void {
    // Replace the full list on each update (matching Claude Code's behavior)
    this.todos.clear();
    for (const item of todos) {
      this.todos.set(item.id, item);
    }
  }

  getAll(): TodoItem[] {
    return Array.from(this.todos.values());
  }

  toReminderText(): string {
    const items = this.getAll();
    if (items.length === 0) return "";

    const lines = items.map((item) => {
      const statusIcon =
        item.status === "completed"
          ? "[x]"
          : item.status === "in_progress"
          ? "[~]"
          : item.status === "cancelled"
          ? "[-]"
          : "[ ]";
      return `  ${statusIcon} ${item.content} (${item.priority})`;
    });

    return `\n[Current TODO list]\n${lines.join("\n")}\n`;
  }

  hasActiveWork(): boolean {
    return this.getAll().some(
      (t) => t.status === "pending" || t.status === "in_progress"
    );
  }
}

export const todoWriteTool = (planner: PlannerState) => ({
  definition: {
    type: "function" as const,
    function: {
      name: "todo_write",
      description:
        "Update the TODO list for the current task. Always replace the entire list. Use this to track multi-step plans and mark progress. Statuses: pending, in_progress, completed, cancelled.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete, updated list of todo items",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier" },
                content: { type: "string", description: "Task description" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
                priority: {
                  type: "string",
                  enum: ["low", "medium", "high"],
                  description: "Optional priority (default: medium)",
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const todos = (args.todos as TodoItem[]).map((t) => ({
      ...t,
      priority: t.priority ?? "medium",
    }));
    planner.update(todos);
    const active = todos.filter(
      (t) => t.status === "pending" || t.status === "in_progress"
    ).length;
    const done = todos.filter((t) => t.status === "completed").length;
    return `TODO list updated: ${todos.length} total, ${done} completed, ${active} remaining.`;
  },
});
