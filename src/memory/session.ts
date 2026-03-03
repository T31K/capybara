import fs from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import type { Message } from "../llm/provider.js";

const APP_DIR = path.join(os.homedir(), ".ai-cli");

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

function cwdToKey(cwd: string): string {
  // Encode cwd as a safe directory name
  return cwd.replace(/\//g, "__").replace(/:/g, "_").replace(/\s/g, "-");
}

function sessionDir(cwd: string): string {
  return path.join(APP_DIR, "projects", cwdToKey(cwd));
}

export class SessionManager {
  private id: string;
  private cwd: string;
  private filePath: string;
  private messages: Message[] = [];

  constructor(cwd: string, id?: string) {
    this.cwd = cwd;
    this.id = id ?? uuidv4();
    this.filePath = path.join(sessionDir(cwd), `${this.id}.jsonl`);
  }

  get sessionId(): string {
    return this.id;
  }

  async init(): Promise<void> {
    await fs.mkdir(sessionDir(this.cwd), { recursive: true });
  }

  async load(): Promise<Message[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.messages = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Message);
      return this.messages;
    } catch {
      this.messages = [];
      return [];
    }
  }

  async append(messages: Message[]): Promise<void> {
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(this.filePath, lines, "utf-8");
  }

  async save(messages: Message[]): Promise<void> {
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.writeFile(this.filePath, lines, "utf-8");
  }

  async getMeta(): Promise<SessionMeta> {
    let stat;
    try {
      stat = await fs.stat(this.filePath);
    } catch {
      stat = null;
    }
    return {
      id: this.id,
      cwd: this.cwd,
      createdAt: stat?.birthtimeMs ?? Date.now(),
      updatedAt: stat?.mtimeMs ?? Date.now(),
      messageCount: this.messages.length,
    };
  }

  static async listSessions(cwd: string): Promise<SessionMeta[]> {
    const dir = sessionDir(cwd);
    try {
      const files = await fs.readdir(dir);
      const sessions: SessionMeta[] = [];

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.replace(".jsonl", "");
        const mgr = new SessionManager(cwd, id);
        await mgr.load();
        sessions.push(await mgr.getMeta());
      }

      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  static async getLatestSession(cwd: string): Promise<string | null> {
    const sessions = await SessionManager.listSessions(cwd);
    return sessions[0]?.id ?? null;
  }
}
