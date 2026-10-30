import { StringDecoder } from "node:string_decoder";
import { DockerCanvasError } from "./errors.mjs";

/**
 * Parses Docker `--format json` output. Depending on command and version this is a single
 * JSON array (older `compose ps`), a single object (`inspect`), or JSON Lines (`ps`, newer
 * `compose ps`, `events`). Always returns an array of records.
 */
export function parseJsonRecords(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      if (Array.isArray(value)) return value;
    } catch {
      // Fall through: could be JSON Lines where each line is an array.
    }
  }
  const records = [];
  for (const [index, rawLine] of trimmed.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new DockerCanvasError("parse_error", `Unexpected Docker output on line ${index + 1}`, {
        line: line.slice(0, 200),
      });
    }
    if (Array.isArray(value)) records.push(...value);
    else records.push(value);
  }
  return records;
}

/** Splits a byte stream into complete UTF-8 lines; chunks are not records. */
export class LineSplitter {
  constructor(onLine, { maxLineBytes = 64 * 1024 } = {}) {
    this.onLine = onLine;
    this.maxLineBytes = maxLineBytes;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.onLine(this.buffer.slice(0, this.maxLineBytes));
      this.buffer = "";
    }
  }

  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this.onLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
  }
}

/** Fixed-capacity buffer used for log tails and operation output. */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  toArray() {
    return this.items.slice();
  }
}
