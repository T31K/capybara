import fs from "fs/promises";
import path from "path";
import os from "os";

const APP_DIR = path.join(os.homedir(), ".ai-cli");

export interface Snapshot {
  filePath: string;
  content: string;
  timestamp: number;
}

export class SnapshotManager {
  private sessionId: string;
  private snapshots: Map<string, Snapshot> = new Map();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async capture(filePath: string): Promise<void> {
    if (this.snapshots.has(filePath)) return; // only capture first (original) state
    try {
      const content = await fs.readFile(filePath, "utf-8");
      this.snapshots.set(filePath, {
        filePath,
        content,
        timestamp: Date.now(),
      });
    } catch {
      // File doesn't exist yet — snapshot as empty
      this.snapshots.set(filePath, {
        filePath,
        content: "",
        timestamp: Date.now(),
      });
    }
  }

  async restore(filePath: string): Promise<boolean> {
    const snapshot = this.snapshots.get(filePath);
    if (!snapshot) return false;

    if (snapshot.content === "") {
      try {
        await fs.unlink(filePath);
      } catch {
        // already gone
      }
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, snapshot.content, "utf-8");
    }
    return true;
  }

  async restoreAll(): Promise<string[]> {
    const restored: string[] = [];
    for (const [filePath] of this.snapshots) {
      const ok = await this.restore(filePath);
      if (ok) restored.push(filePath);
    }
    return restored;
  }

  getSnapshotPaths(): string[] {
    return Array.from(this.snapshots.keys());
  }

  async persist(): Promise<void> {
    const dir = path.join(APP_DIR, "snapshots");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.sessionId}.json`);
    const data = Array.from(this.snapshots.values());
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
  }
}
