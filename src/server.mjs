import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerCanvasError, HTTP_STATUS, toErrorPayload } from "./errors.mjs";
import { log } from "./log.mjs";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const STATIC = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  "app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * One loopback server for the extension. Each canvas panel gets an unguessable capability token
 * embedded in its URL path (`/p/<token>/`); closing the panel revokes the token and its streams.
 */
export class CanvasServer {
  constructor(service, { host = "127.0.0.1" } = {}) {
    this.service = service;
    this.host = host;
    this.instances = new Map(); // token -> { instanceId, defaultDir, view, connections:Set }
    this.byInstanceId = new Map(); // instanceId -> token
    this.server = null;
    this.port = null;
    this.staticCache = new Map();
  }

  async start() {
    if (this.server) return;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        log("error", "Unhandled request error", { message: error?.message });
        if (!res.headersSent) this.sendJson(res, 500, { error: { code: "internal_error", message: "Internal error" } });
        else res.end();
      });
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 0; // SSE connections are long-lived.
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = server.address().port;
    log("info", `Canvas server listening on ${this.host}:${this.port}`);
  }

  get origin() {
    return `http://${this.host}:${this.port}`;
  }

  /** Idempotent per instanceId so reopen/rehydrate keeps the same URL. */
  registerInstance(instanceId, { defaultDir = null, view = "containers" } = {}) {
    let token = this.byInstanceId.get(instanceId);
    if (token) {
      const entry = this.instances.get(token);
      if (defaultDir) entry.defaultDir = defaultDir;
      if (view) entry.view = view;
    } else {
      token = randomBytes(32).toString("base64url");
      this.instances.set(token, { instanceId, defaultDir, view, connections: new Set() });
      this.byInstanceId.set(instanceId, token);
    }
    return `${this.origin}/p/${token}/`;
  }

  revokeInstance(instanceId) {
    const token = this.byInstanceId.get(instanceId);
    if (!token) return;
    const entry = this.instances.get(token);
    this.byInstanceId.delete(instanceId);
    this.instances.delete(token);
    for (const close of entry.connections) close();
  }

  instanceDefaults(instanceId) {
    const token = this.byInstanceId.get(instanceId);
    return token ? this.instances.get(token) : null;
  }

  async stop() {
    for (const instanceId of [...this.byInstanceId.keys()]) this.revokeInstance(instanceId);
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server.closeAllConnections?.();
      this.server = null;
    }
  }

  async handle(req, res) {
    // DNS-rebinding defence: only accept requests addressed to our exact loopback origin.
    if (req.headers.host !== `${this.host}:${this.port}`) return this.sendError(res, new DockerCanvasError("forbidden", "Invalid Host header"));

    const url = new URL(req.url, this.origin);
    const match = /^\/p\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match || !TOKEN_PATTERN.test(match[1]) || !this.instances.has(match[1])) {
      return this.sendError(res, new DockerCanvasError("unauthorized", "Unknown or closed canvas session"));
    }
    const instance = this.instances.get(match[1]);
    const route = match[2];

    if (req.method === "GET") {
      if (route in STATIC) return this.sendStatic(res, STATIC[route]);
      if (route === "api/bootstrap") return this.sendJson(res, 200, this.bootstrap(instance));
      if (route === "api/events") return this.openEventStream(req, res, instance);
      if (route === "api/logs") return this.openLogStream(req, res, instance, url);
      return this.sendError(res, new DockerCanvasError("not_found", "Not found"));
    }

    if (req.method !== "POST") return this.sendError(res, new DockerCanvasError("invalid_input", "Method not allowed"), 405);
    // CSRF defence: require same-origin JSON requests (cross-site forms cannot send application/json).
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.origin) return this.sendError(res, new DockerCanvasError("forbidden", "Cross-origin request rejected"));
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      return this.sendError(res, new DockerCanvasError("invalid_input", "Content-Type must be application/json"), 415);
    }
    let body;
    try {
      body = await this.readJson(req);
    } catch (error) {
      return this.sendError(res, error);
    }

    const opMatch = /^api\/op\/([a-z_]+)$/.exec(route);
    if (opMatch) {
      try {
        const result = await this.service.execute(opMatch[1], body, { origin: "ui", defaultDir: instance.defaultDir });
        return this.sendJson(res, 200, { result });
      } catch (error) {
        return this.sendError(res, error);
      }
    }
    const approvalMatch = /^api\/approvals\/([a-f0-9]{24})\/(approve|deny)$/.exec(route);
    if (approvalMatch) {
      const [, id, decision] = approvalMatch;
      try {
        if (decision === "deny") return this.sendJson(res, 200, { approval: this.service.deny(id) });
        const current = this.service.getApproval(id);
        if (current.status !== "pending") throw new DockerCanvasError("conflict", `Approval is already ${current.status}`);
        // Runs in the background; progress and outcome are pushed over the event stream.
        this.service.approve(id).catch((error) => log("warn", "Approved operation failed", toErrorPayload(error)));
        return this.sendJson(res, 202, { approval: this.service.getApproval(id) });
      } catch (error) {
        return this.sendError(res, error);
      }
    }
    return this.sendError(res, new DockerCanvasError("not_found", "Not found"));
  }

  bootstrap(instance) {
    return {
      instance: { defaultDir: instance.defaultDir, view: instance.view },
      approvals: this.service.approvals.list(),
      operations: this.service.operations.list(),
    };
  }

  openEventStream(req, res, instance) {
    this.startSse(res);
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const listeners = {
      containers: (d) => send("containers", d),
      images: (d) => send("images", d),
      stats: (d) => send("stats", d),
      approval: (d) => send("approval", d),
      operation: (d) => send("operation", d),
      "daemon-error": (d) => send("daemon-error", d),
    };
    for (const [event, fn] of Object.entries(listeners)) this.service.on(event, fn);
    const unsubscribe = this.service.subscribe();
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    this.service
      .status()
      .then((status) => send("status", status))
      .catch((error) => send("daemon-error", toErrorPayload(error)));
    this.service.scheduleRefresh({ images: true });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const [event, fn] of Object.entries(listeners)) this.service.off(event, fn);
      unsubscribe();
      instance.connections.delete(close);
      res.end();
    };
    instance.connections.add(close);
    req.on("close", close);
  }

  openLogStream(req, res, instance, url) {
    const container = url.searchParams.get("container") || "";
    const tail = Math.min(Math.max(Number.parseInt(url.searchParams.get("tail") || "200", 10) || 200, 1), 2000);
    let handle;
    try {
      if (!this.service.cli) throw new DockerCanvasError("daemon_unavailable", "Docker target not resolved yet");
      handle = this.service.followLogs(container, tail, (entry) => res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`));
    } catch (error) {
      return this.sendError(res, error);
    }
    this.startSse(res);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      handle.stop();
      instance.connections.delete(close);
      res.end();
    };
    handle.done
      .then(({ exitCode, stopped }) => {
        if (!stopped && !closed) res.write(`event: end\ndata: ${JSON.stringify({ exitCode })}\n\n`);
      })
      .catch((error) => !closed && res.write(`event: end\ndata: ${JSON.stringify(toErrorPayload(error))}\n\n`))
      .finally(close);
    instance.connections.add(close);
    req.on("close", close);
  }

  startSse(res) {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
    res.write(": connected\n\n");
  }

  readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          reject(new DockerCanvasError("payload_too_large", "Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text === "") return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new DockerCanvasError("invalid_input", "Body must be valid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  sendStatic(res, { file, type }) {
    let content = this.staticCache.get(file);
    if (!content) {
      content = readFileSync(join(UI_DIR, file));
      this.staticCache.set(file, content);
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
    res.end(content);
  }

  sendJson(res, status, payload) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  sendError(res, error, statusOverride) {
    const payload = toErrorPayload(error);
    const status = statusOverride ?? HTTP_STATUS[payload.code] ?? (payload.code === "internal_error" ? 500 : 502);
    if (status >= 500) log("warn", "Request failed", payload);
    this.sendJson(res, status, { error: payload });
  }
}
