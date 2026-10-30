import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { RingBuffer } from "./parse.mjs";

const MAX_OPERATIONS = 30;

/** Tracks long-running operations (pull, run, compose up/down) so every panel can follow them. */
export class OperationTracker extends EventEmitter {
  constructor() {
    super();
    this.operations = new Map();
  }

  start(op, title) {
    const id = randomBytes(8).toString("hex");
    const record = { id, op, title, status: "running", startedAt: Date.now(), output: new RingBuffer(200) };
    this.operations.set(id, record);
    this.prune();
    this.emit("change", this.view(record));
    let pending = false;
    const handle = {
      id,
      line: (text) => {
        if (!text) return;
        record.output.push(text);
        // Coalesce bursts of progress lines into one update per tick.
        if (!pending) {
          pending = true;
          setTimeout(() => {
            pending = false;
            this.emit("change", this.view(record));
          }, 250).unref?.();
        }
      },
      succeed: (result) => this.finish(record, "succeeded", { result }),
      fail: (error) => this.finish(record, "failed", { error }),
    };
    return handle;
  }

  finish(record, status, extra) {
    record.status = status;
    record.endedAt = Date.now();
    Object.assign(record, extra);
    this.emit("change", this.view(record));
  }

  list() {
    return [...this.operations.values()].map((r) => this.view(r)).sort((a, b) => b.startedAt - a.startedAt);
  }

  prune() {
    const records = [...this.operations.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (records.length > MAX_OPERATIONS) {
      const oldest = records.shift();
      if (oldest.status === "running") continue;
      this.operations.delete(oldest.id);
    }
  }

  view(record) {
    return { ...record, output: record.output.toArray() };
  }
}
