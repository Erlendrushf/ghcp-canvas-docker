import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DockerCanvasError } from "./errors.mjs";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_HISTORY = 50;

export function fingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Pending confirmations for risky operations. An approval is bound to the exact operation,
 * validated parameters, Docker target and any file hashes; it expires and can be used once.
 * Only the panel UI (authenticated per instance) can approve — agent callers can only create.
 */
export class ApprovalStore extends EventEmitter {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.now = now;
    this.records = new Map();
  }

  create({ op, params, summary, risks = [], binding = {}, origin }) {
    const id = randomBytes(12).toString("hex");
    const createdAt = this.now();
    const record = {
      id,
      op,
      params: structuredClone(params),
      summary,
      risks,
      binding,
      origin,
      fingerprint: fingerprint({ op, params, binding }),
      status: "pending",
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.records.set(id, record);
    this.prune();
    this.emit("change", this.publicView(record));
    return this.publicView(record);
  }

  get(id) {
    const record = this.records.get(id);
    if (!record) throw new DockerCanvasError("approval_not_found", "Approval not found");
    this.expireIfNeeded(record);
    return this.publicView(record);
  }

  /** Atomically moves a pending approval to `executing`; returns the internal record. */
  claim(id) {
    const record = this.records.get(id);
    if (!record) throw new DockerCanvasError("approval_not_found", "Approval not found");
    this.expireIfNeeded(record);
    if (record.status === "expired") throw new DockerCanvasError("approval_expired", "Approval has expired; request the operation again");
    if (record.status !== "pending") throw new DockerCanvasError("conflict", `Approval is already ${record.status}`);
    if (record.fingerprint !== fingerprint({ op: record.op, params: record.params, binding: record.binding })) {
      throw new DockerCanvasError("approval_mismatch", "Approval contents were modified");
    }
    record.status = "executing";
    record.decidedAt = this.now();
    this.emit("change", this.publicView(record));
    return record;
  }

  deny(id) {
    const record = this.records.get(id);
    if (!record) throw new DockerCanvasError("approval_not_found", "Approval not found");
    this.expireIfNeeded(record);
    if (record.status !== "pending") throw new DockerCanvasError("conflict", `Approval is already ${record.status}`);
    record.status = "denied";
    record.decidedAt = this.now();
    this.emit("change", this.publicView(record));
    return this.publicView(record);
  }

  complete(id, { result, error }) {
    const record = this.records.get(id);
    if (!record) return;
    record.status = error ? "failed" : "succeeded";
    record.completedAt = this.now();
    if (error) record.error = error;
    else record.result = result;
    this.emit("change", this.publicView(record));
  }

  list() {
    for (const record of this.records.values()) this.expireIfNeeded(record);
    return [...this.records.values()].map((r) => this.publicView(r)).sort((a, b) => b.createdAt - a.createdAt);
  }

  expireIfNeeded(record) {
    if (record.status === "pending" && this.now() > record.expiresAt) {
      record.status = "expired";
      this.emit("change", this.publicView(record));
    }
  }

  prune() {
    const done = [...this.records.values()].filter((r) => r.status !== "pending" && r.status !== "executing");
    const excess = done.length - MAX_HISTORY;
    if (excess > 0) {
      done.sort((a, b) => a.createdAt - b.createdAt);
      for (const record of done.slice(0, excess)) this.records.delete(record.id);
    }
  }

  publicView(record) {
    const { fingerprint: _f, binding: _b, ...rest } = record;
    return structuredClone(rest);
  }
}
