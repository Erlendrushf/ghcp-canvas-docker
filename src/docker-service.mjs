import { EventEmitter } from "node:events";
import { ApprovalStore } from "./approvals.mjs";
import { DockerCli } from "./cli.mjs";
import { composeBaseArgs, composeRisks, loadComposeModel } from "./compose.mjs";
import { DockerCanvasError, toErrorPayload } from "./errors.mjs";
import { log } from "./log.mjs";
import { OperationTracker } from "./operations.mjs";
import { parseJsonRecords } from "./parse.mjs";
import { describeTarget, resolveTarget, revalidateTarget } from "./target.mjs";
import * as v from "./validate.mjs";

const SECRET_KEY = /(pass|secret|token|key|credential|auth|private|cert)/i;

function parseLabels(text) {
  const labels = {};
  if (typeof text !== "string" || text === "") return labels;
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
}

function mapContainer(raw) {
  const labels = parseLabels(raw.Labels);
  return {
    id: raw.ID,
    name: String(raw.Names ?? "").split(",")[0],
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    ports: raw.Ports || "",
    createdAt: raw.CreatedAt,
    runningFor: raw.RunningFor,
    command: raw.Command,
    composeProject: labels["com.docker.compose.project"] ?? null,
    composeService: labels["com.docker.compose.service"] ?? null,
    managed: labels[v.MANAGED_LABEL] === "true",
  };
}

function mapImage(raw) {
  return {
    id: raw.ID,
    repository: raw.Repository,
    tag: raw.Tag,
    digest: raw.Digest,
    size: raw.Size,
    createdSince: raw.CreatedSince,
    reference: raw.Repository && raw.Repository !== "<none>" ? `${raw.Repository}${raw.Tag && raw.Tag !== "<none>" ? `:${raw.Tag}` : ""}` : raw.ID,
  };
}

/** Environment values are never returned: they frequently contain credentials. */
function redactEnv(env) {
  return (env ?? []).map((entry) => {
    const eq = entry.indexOf("=");
    const key = eq === -1 ? entry : entry.slice(0, eq);
    return { key, value: SECRET_KEY.test(key) ? "<redacted>" : "<hidden>" };
  });
}

function mapInspect(raw) {
  return {
    id: raw.Id,
    name: String(raw.Name ?? "").replace(/^\//, ""),
    created: raw.Created,
    image: raw.Config?.Image,
    state: {
      status: raw.State?.Status,
      running: raw.State?.Running,
      exitCode: raw.State?.ExitCode,
      startedAt: raw.State?.StartedAt,
      finishedAt: raw.State?.FinishedAt,
      health: raw.State?.Health?.Status ?? null,
      error: raw.State?.Error || null,
    },
    command: raw.Config?.Cmd ?? [],
    entrypoint: raw.Config?.Entrypoint ?? [],
    workingDir: raw.Config?.WorkingDir ?? "",
    env: redactEnv(raw.Config?.Env),
    labels: raw.Config?.Labels ?? {},
    restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? null,
    privileged: Boolean(raw.HostConfig?.Privileged),
    networkMode: raw.HostConfig?.NetworkMode ?? null,
    autoRemove: Boolean(raw.HostConfig?.AutoRemove),
    ports: raw.NetworkSettings?.Ports ?? {},
    mounts: (raw.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, readWrite: m.RW })),
  };
}

function describeRun(spec) {
  const parts = [`Run ${spec.image}${spec.name ? ` as "${spec.name}"` : ""}`];
  const risks = [];
  for (const p of spec.ports) {
    const exposed = p.hostIp === "0.0.0.0";
    risks.push({
      level: exposed ? "medium" : "info",
      message: `publishes ${p.hostIp}:${p.hostPort ?? "(random)"} → ${p.containerPort}/${p.protocol}${exposed ? " on all interfaces" : ""}`,
    });
  }
  for (const m of spec.mounts) risks.push({ level: m.readOnly ? "info" : "medium", message: `bind-mounts ${m.source} → ${m.target}${m.readOnly ? " (read-only)" : " (read-write)"}` });
  for (const vol of spec.volumes) risks.push({ level: "info", message: `mounts volume ${vol.name} → ${vol.target}` });
  if (Object.keys(spec.env).length) risks.push({ level: "info", message: `sets env: ${Object.keys(spec.env).join(", ")}` });
  return { summary: parts.join(" "), risks };
}

/**
 * Operation table. Every caller — panel UI or agent action — goes through the same
 * validate → (approval) → revalidate target → execute → refresh pipeline.
 */
const OPS = {
  status: {
    prepare: () => ({ params: {} }),
    run: (s) => s.status(),
  },
  list_containers: {
    prepare: (s, input) => ({ params: { all: v.optionalBoolean(input.all, "all", true) } }),
    run: (s, p) => s.listContainers(p),
  },
  inspect_container: {
    prepare: (s, input) => ({ params: { container: v.containerRef(input.container) } }),
    run: async (s, p) => {
      const { stdout } = await s.cli.run(["container", "inspect", "--", p.container]);
      const [raw] = parseJsonRecords(stdout);
      if (!raw) throw new DockerCanvasError("not_found", `No such container: ${p.container}`);
      return mapInspect(raw);
    },
  },
  get_logs: {
    prepare: (s, input) => ({
      params: {
        container: v.containerRef(input.container),
        tail: v.boundedInt(input.tail, "tail", { min: 1, max: 2000, fallback: 200 }),
      },
    }),
    run: (s, p) => s.readLogs(p),
  },
  get_stats: {
    prepare: (s, input) => ({ params: { container: input.container === undefined ? null : v.containerRef(input.container) } }),
    run: (s, p) => s.readStats(p),
  },
  start_container: lifecycle("start"),
  stop_container: lifecycle("stop"),
  restart_container: lifecycle("restart"),
  remove_container: {
    mutating: true,
    prepare: async (s, input) => {
      const params = { container: v.containerRef(input.container), force: v.optionalBoolean(input.force, "force", false) };
      return {
        params,
        approval: {
          summary: `Remove container ${params.container}${params.force ? " (force — stops it if running)" : ""}`,
          risks: [{ level: "medium", message: "The container and its writable layer are deleted. Named volumes are kept." }],
        },
      };
    },
    run: async (s, p) => {
      await s.cli.run(["container", "rm", ...(p.force ? ["--force"] : []), "--", p.container]);
      return { removed: p.container };
    },
  },
  list_images: {
    prepare: () => ({ params: {} }),
    run: (s) => s.listImages(),
  },
  pull_image: {
    mutating: true,
    long: true,
    prepare: (s, input) => ({ params: { image: v.imageRef(input.image) } }),
    run: (s, p) =>
      s.tracked("pull_image", `Pull ${p.image}`, (op) => s.streamToOperation(["image", "pull", "--", p.image], op, { timeoutMs: 15 * 60_000 }), () => ({ image: p.image })),
  },
  run_container: {
    mutating: true,
    long: true,
    prepare: (s, input) => {
      const spec = v.runSpec(input);
      const needsApproval = spec.ports.length > 0 || spec.mounts.length > 0 || spec.volumes.length > 0;
      return { params: spec, approval: needsApproval ? describeRun(spec) : undefined };
    },
    run: (s, spec) =>
      s.tracked("run_container", `Run ${spec.image}`, async (op) => {
        const { stdout } = await s.cli.run(v.runArgs(spec), { timeoutMs: 10 * 60_000 });
        const id = stdout.trim().split(/\r?\n/).pop();
        op.line(`Started container ${id}`);
        return { id, name: spec.name ?? null, image: spec.image };
      }),
  },
  compose_config: {
    prepare: (s, input, ctx) => ({ params: v.composeSelection(input, { defaultDir: ctx.defaultDir }) }),
    run: async (s, sel) => {
      const { summary } = await loadComposeModel(s.cli, sel);
      return { ...summary, projectDir: sel.projectDir, risks: composeRisks(summary) };
    },
  },
  compose_ps: {
    prepare: (s, input, ctx) => ({ params: v.composeSelection(input, { defaultDir: ctx.defaultDir }) }),
    run: async (s, sel) => {
      const { stdout } = await s.cli.run([...composeBaseArgs(sel), "ps", "--all", "--format", "json"], { cwd: sel.projectDir });
      return parseJsonRecords(stdout).map((c) => ({
        id: c.ID,
        name: c.Name,
        service: c.Service,
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: c.Health || null,
        project: c.Project,
        publishers: (c.Publishers ?? []).filter((p) => p.PublishedPort).map((p) => `${p.URL}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`),
      }));
    },
  },
  compose_up: {
    mutating: true,
    long: true,
    prepare: async (s, input, ctx) => {
      const sel = v.composeSelection(input, { defaultDir: ctx.defaultDir });
      const params = {
        ...sel,
        wait: v.optionalBoolean(input.wait, "wait", true),
        waitTimeout: v.boundedInt(input.waitTimeout, "waitTimeout", { min: 5, max: 1800, fallback: 180 }),
        build: v.optionalBoolean(input.build, "build", false),
      };
      const { configHash, summary } = await loadComposeModel(s.cli, sel);
      return {
        params,
        approval: {
          summary: `Start Compose project "${summary.projectName}" (${summary.services.map((x) => x.name).join(", ") || "no services"}) from ${sel.projectDir}`,
          risks: composeRisks(summary),
          binding: { configHash },
        },
      };
    },
    verify: async (s, record) => {
      const { configHash } = await loadComposeModel(s.cli, record.params);
      if (configHash !== record.binding.configHash) {
        throw new DockerCanvasError("approval_mismatch", "The Compose configuration changed after approval was requested. Request it again.");
      }
    },
    run: (s, p) =>
      s.tracked("compose_up", `Compose up ${p.projectDir}`, async (op) => {
        const args = [...composeBaseArgs(p), "up", "--detach"];
        if (p.build) args.push("--build");
        if (p.wait) args.push("--wait", "--wait-timeout", String(p.waitTimeout));
        await s.streamToOperation(args, op, { cwd: p.projectDir, timeoutMs: (p.waitTimeout + 900) * 1000 });
        return { projectDir: p.projectDir };
      }),
  },
  compose_down: {
    mutating: true,
    long: true,
    prepare: async (s, input, ctx) => {
      const sel = v.composeSelection(input, { defaultDir: ctx.defaultDir });
      const params = { ...sel, removeVolumes: v.optionalBoolean(input.removeVolumes, "removeVolumes", false) };
      const { configHash, summary } = await loadComposeModel(s.cli, sel);
      return {
        params,
        approval: {
          summary: `Stop and remove Compose project "${summary.projectName}" from ${sel.projectDir}`,
          risks: [
            { level: "medium", message: "Containers and project networks are removed." },
            params.removeVolumes
              ? { level: "high", message: "Named volumes declared by the project are DELETED (data loss)." }
              : { level: "info", message: "Volumes are kept." },
          ],
          binding: { configHash },
        },
      };
    },
    run: (s, p) =>
      s.tracked("compose_down", `Compose down ${p.projectDir}`, async (op) => {
        const args = [...composeBaseArgs(p), "down"];
        if (p.removeVolumes) args.push("--volumes");
        await s.streamToOperation(args, op, { cwd: p.projectDir, timeoutMs: 10 * 60_000 });
        return { projectDir: p.projectDir };
      }),
  },
};

function lifecycle(verb) {
  return {
    mutating: true,
    prepare: (s, input) => ({
      params: {
        container: v.containerRef(input.container),
        ...(verb === "start" ? {} : { timeout: v.boundedInt(input.timeout, "timeout", { min: 0, max: 300, fallback: 10 }) }),
      },
    }),
    run: async (s, p) => {
      const args = ["container", verb];
      if (p.timeout !== undefined) args.push("--time", String(p.timeout));
      await s.cli.run([...args, "--", p.container], { timeoutMs: ((p.timeout ?? 10) + 60) * 1000 });
      return { container: p.container, action: verb };
    },
  };
}

export const OPERATION_NAMES = Object.keys(OPS);

export class DockerService extends EventEmitter {
  constructor({ cli, env = process.env, approvals, operations } = {}) {
    super();
    this.env = env;
    this.baseCli = cli ?? null;
    this.cli = null;
    this.target = null;
    this.approvals = approvals ?? new ApprovalStore();
    this.operations = operations ?? new OperationTracker();
    this.approvals.on("change", (a) => this.emit("approval", a));
    this.operations.on("change", (o) => this.emit("operation", o));
    this.subscribers = 0;
    this.watchers = null;
    this.refreshTimer = null;
  }

  async ensureTarget() {
    if (this.target) return this.target;
    if (!this.targetPromise) {
      this.targetPromise = (async () => {
        this.baseCli ??= new DockerCli({ env: this.env });
        const target = await resolveTarget(this.baseCli, this.env);
        this.cli = this.baseCli.withGlobalArgs([...target.globalArgs], target.envOverrides);
        this.target = target;
        log("info", "Docker target resolved", describeTarget(target));
        return target;
      })().finally(() => {
        this.targetPromise = null;
      });
    }
    return this.targetPromise;
  }

  /** Entry point for both UI and agent callers. */
  async execute(op, input = {}, ctx = {}) {
    const def = OPS[op];
    if (!def) throw new DockerCanvasError("not_found", `Unknown operation: ${op}`);
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new DockerCanvasError("invalid_input", "Input must be an object");
    await this.ensureTarget();
    const prepared = await def.prepare(this, input, ctx);
    if (prepared.approval) {
      const approval = this.approvals.create({
        op,
        params: prepared.params,
        summary: prepared.approval.summary,
        risks: prepared.approval.risks,
        binding: { ...(prepared.approval.binding ?? {}), endpoint: this.target.endpoint },
        origin: ctx.origin ?? "unknown",
      });
      return {
        status: "pending_approval",
        approvalId: approval.id,
        summary: approval.summary,
        risks: approval.risks,
        expiresAt: new Date(approval.expiresAt).toISOString(),
        message: "This operation needs the user's confirmation in the Docker canvas panel. Ask the user to approve it there, then call get_approval to see the outcome.",
      };
    }
    return this.runOp(op, def, prepared.params, ctx);
  }

  async runOp(op, def, params, ctx) {
    if (def.mutating) await revalidateTarget(this.baseCli, this.target);
    try {
      return await def.run(this, params, ctx);
    } finally {
      if (def.mutating) this.scheduleRefresh({ images: op === "pull_image" || op === "run_container" || op.startsWith("compose_") });
    }
  }

  /** Called only from the authenticated panel UI. Resolves when the approved operation finishes. */
  async approve(approvalId) {
    const record = this.approvals.claim(approvalId);
    try {
      await this.ensureTarget();
      if (record.binding.endpoint !== this.target.endpoint) {
        throw new DockerCanvasError("target_changed", "The Docker target changed after approval was requested");
      }
      const def = OPS[record.op];
      if (def.verify) await def.verify(this, record);
      const result = await this.runOp(record.op, def, record.params, {});
      this.approvals.complete(approvalId, { result });
      return result;
    } catch (error) {
      this.approvals.complete(approvalId, { error: toErrorPayload(error) });
      throw error;
    }
  }

  deny(approvalId) {
    return this.approvals.deny(approvalId);
  }

  getApproval(approvalId) {
    if (typeof approvalId !== "string" || !/^[a-f0-9]{24}$/.test(approvalId)) {
      throw new DockerCanvasError("invalid_input", "approvalId is required");
    }
    return this.approvals.get(approvalId);
  }

  async status() {
    const target = await this.ensureTarget();
    const { stdout } = await this.cli.run(["version", "--format", "json"], { timeoutMs: 10_000, allowFailure: true });
    let version = {};
    try {
      version = JSON.parse(stdout);
    } catch {
      // Older CLIs print partial output when the daemon is down.
    }
    return {
      target: describeTarget(target),
      client: version.Client?.Version ?? null,
      server: version.Server?.Version ?? null,
      daemonReachable: Boolean(version.Server?.Version),
    };
  }

  async listContainers({ all = true } = {}) {
    await this.ensureTarget();
    const { stdout } = await this.cli.run(["container", "ls", ...(all ? ["--all"] : []), "--no-trunc", "--format", "json"]);
    return parseJsonRecords(stdout).map(mapContainer);
  }

  async listImages() {
    await this.ensureTarget();
    const { stdout } = await this.cli.run(["image", "ls", "--format", "json"]);
    return parseJsonRecords(stdout).map(mapImage);
  }

  async readLogs({ container, tail }) {
    const lines = [];
    const handle = this.cli.stream(["container", "logs", "--timestamps", "--tail", String(tail), "--", container], {
      onStdout: (line) => lines.push({ stream: "stdout", line }),
      onStderr: (line) => lines.push({ stream: "stderr", line }),
      timeoutMs: 20_000,
    });
    const { exitCode } = await handle.done;
    if (exitCode !== 0) {
      const message = lines.filter((l) => l.stream === "stderr").map((l) => l.line).join("\n") || "docker logs failed";
      throw new DockerCanvasError(/No such container/i.test(message) ? "not_found" : "docker_failed", message.slice(0, 1000));
    }
    return { container, lines: lines.slice(-tail) };
  }

  async readStats({ container }) {
    const { stdout } = await this.cli.run(["container", "stats", "--no-stream", "--no-trunc", "--format", "json", ...(container ? ["--", container] : [])], {
      timeoutMs: 20_000,
    });
    return parseJsonRecords(stdout).map((s) => ({
      id: s.ID,
      name: s.Name,
      cpu: s.CPUPerc,
      memory: s.MemUsage,
      memoryPercent: s.MemPerc,
      netIO: s.NetIO,
      blockIO: s.BlockIO,
      pids: s.PIDs,
    }));
  }

  /** Follows container logs; returns a handle whose stop() must be called on disconnect. */
  followLogs(container, tail, onLine) {
    v.containerRef(container);
    return this.cli.stream(["container", "logs", "--follow", "--timestamps", "--tail", String(tail), "--", container], {
      onStdout: (line) => onLine({ stream: "stdout", line }),
      onStderr: (line) => onLine({ stream: "stderr", line }),
    });
  }

  async tracked(op, title, work, mapResult) {
    const handle = this.operations.start(op, title);
    try {
      const value = await work(handle);
      const result = mapResult ? mapResult(value) : value;
      handle.succeed(result);
      return { operationId: handle.id, ...result };
    } catch (error) {
      handle.fail(toErrorPayload(error));
      throw error;
    }
  }

  async streamToOperation(args, op, { cwd, timeoutMs }) {
    const stderr = [];
    const stream = this.cli.stream(args, {
      cwd,
      timeoutMs,
      onStdout: (line) => op.line(line),
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > 50) stderr.shift();
        op.line(line);
      },
    });
    const { exitCode, stopped } = await stream.done;
    if (stopped) throw new DockerCanvasError("timeout", "Operation timed out");
    if (exitCode !== 0) {
      const message = stderr.join("\n").trim() || `docker exited with code ${exitCode}`;
      throw new DockerCanvasError("docker_failed", message.slice(-2000), { exitCode });
    }
  }

  // ---- live updates for panels -------------------------------------------------------

  subscribe() {
    this.subscribers += 1;
    if (this.subscribers === 1) this.startWatchers();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers -= 1;
      if (this.subscribers === 0) this.stopWatchers();
    };
  }

  scheduleRefresh({ images = false } = {}) {
    this.pendingImages ||= images;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      const withImages = this.pendingImages;
      this.pendingImages = false;
      try {
        this.emit("containers", await this.listContainers());
        if (withImages) this.emit("images", await this.listImages());
      } catch (error) {
        this.emit("daemon-error", toErrorPayload(error));
      }
    }, 300);
    this.refreshTimer.unref?.();
  }

  startWatchers() {
    const state = { stopped: false, events: null, statsTimer: null, backoff: 1000 };
    this.watchers = state;
    const startEvents = async () => {
      if (state.stopped) return;
      try {
        await this.ensureTarget();
      } catch (error) {
        this.emit("daemon-error", toErrorPayload(error));
        setTimeout(startEvents, state.backoff).unref?.();
        state.backoff = Math.min(state.backoff * 2, 30_000);
        return;
      }
      state.events = this.cli.stream(["system", "events", "--format", "json", "--filter", "type=container", "--filter", "type=image"], {
        onStdout: (line) => {
          state.backoff = 1000;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (["exec_create", "exec_start", "exec_die", "top"].some((a) => String(event.Action).startsWith(a))) return;
          this.scheduleRefresh({ images: event.Type === "image" });
        },
      });
      // The daemon replays only a bounded event window, so a fresh snapshot follows every (re)connect.
      this.scheduleRefresh({ images: true });
      state.events.done
        .catch(() => undefined)
        .then(() => {
          if (state.stopped) return;
          this.emit("daemon-error", { code: "events_disconnected", message: "Lost Docker event stream; reconnecting…" });
          setTimeout(startEvents, state.backoff).unref?.();
          state.backoff = Math.min(state.backoff * 2, 30_000);
        });
    };
    startEvents();
    const pollStats = async () => {
      if (state.stopped) return;
      try {
        if (this.cli) this.emit("stats", await this.readStats({ container: null }));
      } catch {
        // Stats are best-effort; container listing reports daemon errors.
      }
      if (!state.stopped) state.statsTimer = setTimeout(pollStats, 5000);
    };
    state.statsTimer = setTimeout(pollStats, 1500);
  }

  stopWatchers() {
    const state = this.watchers;
    if (!state) return;
    state.stopped = true;
    state.events?.stop();
    clearTimeout(state.statsTimer);
    this.watchers = null;
  }

  shutdown() {
    this.stopWatchers();
    clearTimeout(this.refreshTimer);
  }
}
