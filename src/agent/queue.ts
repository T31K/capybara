/**
 * Async dual-buffer steering queue (h2A equivalent).
 * Allows real-time injection of user interrupts mid-task.
 */

type Resolver<T> = (value: T) => void;

export class SteeringQueue<T> {
  private buffer: T[] = [];
  private waiters: Resolver<T>[] = [];
  private closed = false;

  push(item: T): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
    } else {
      this.buffer.push(item);
    }
  }

  async next(): Promise<T | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    if (this.closed) return null;
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  tryNext(): T | null {
    return this.buffer.shift() ?? null;
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w(null as unknown as T);
    this.waiters = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}

export interface SteeringEvent {
  type: "interrupt" | "inject";
  text: string;
}
