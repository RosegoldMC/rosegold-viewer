import type { TerrainBatch } from "./wire.js";

export const MAX_CHAT_LINES = 8;
export const MAX_CHAT_CHARS = 256;

const unsafe = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]", "g");

export function cleanLine(text: string): string {
  return text.replace(unsafe, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_CHARS);
}

export type Outgoing = { ok: true; text: string } | { ok: false; reason: string };

export function outgoing(raw: string): Outgoing {
  const text = cleanLine(raw);
  if (text === "") return { ok: false, reason: "" };
  if (text.replace(/^\/+/, "").trim() === "") return text.startsWith("/") ? { ok: false, reason: "Type a command after the /." } : { ok: false, reason: "" };
  if (new TextEncoder().encode(text).length > MAX_CHAT_CHARS) return { ok: false, reason: "Message is too long." };
  return { ok: true, text };
}

interface ChatSink {
  show(lines: string[]): void;
}

export class ViewerChat {
  private epoch: number | null = null;
  private chatEpoch: number | null = null;
  private lastId = 0;
  private lines: string[] = [];

  constructor(private readonly sink: ChatSink) {}

  reset(): void {
    this.epoch = this.chatEpoch = null;
    this.lastId = 0;
    if (this.lines.length) this.sink.show([]);
    this.lines = [];
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready" || batch.epoch !== this.epoch) {
      this.reset();
      if (batch.status !== "ready") return;
      this.epoch = batch.epoch;
    }
    const chat = batch.chat;
    if (!chat) return;
    if (chat.epoch !== this.chatEpoch) {
      this.chatEpoch = chat.epoch;
      this.lastId = 0;
      this.lines = [];
    }
    for (const [id, text] of chat.entries) {
      if (id <= this.lastId) continue;
      this.lastId = id;
      const line = cleanLine(text);
      if (line) this.lines.push(line);
    }
    this.lines = this.lines.slice(-MAX_CHAT_LINES);
    this.sink.show(this.lines);
  }
}
