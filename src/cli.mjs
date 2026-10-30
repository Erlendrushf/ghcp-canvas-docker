import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { DockerCanvasError, classifyDockerFailure } from "./errors.mjs";
import { LineSplitter } from "./parse.mjs";

// GUI-launched processes often get a minimal PATH; include common Docker install locations
// so both `docker` and its credential helpers / compose plugin resolve.
const EXTRA_PATH_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
  "/usr/bin",
  "/bin",
];

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildSearchPath(envPath = process.env.PATH || "") {
  const parts = envPath.split(delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) if (!parts.includes(dir)) parts.push(dir);
  return parts;
}

export function resolveDockerBinary(env = process.env) {
  if (env.DOCKER_CANVAS_DOCKER_BIN) {
    if (isExecutable(env.DOCKER_CANVAS_DOCKER_BIN)) return env.DOCKER_CANVAS_DOCKER_BIN;
    throw new DockerCanvasError("docker_not_found", `DOCKER_CANVAS_DOCKER_BIN is not executable: ${env.DOCKER_CANVAS_DOCKER_BIN}`);
  }
  const names = process.platform === "win32" ? ["docker.exe"] : ["docker"];
  for (const dir of buildSearchPath(env.PATH)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new DockerCanvasError("docker_not_found", "Docker CLI was not found. Install Docker Desktop or add docker to PATH.");
}

/**
 * Executes the Docker CLI with a fixed argv (never through a shell). One instance is bound to
 * a resolved binary and a set of global target arguments (e.g. `--context desktop-linux`).
 */
export class DockerCli {
  constructor({ binary, env = process.env, globalArgs = [] } = {}) {
    this.binary = binary ?? resolveDockerBinary(env);
    this.globalArgs = globalArgs;
    const searchPath = buildSearchPath(env.PATH);
    if (!searchPath.includes(dirname(this.binary))) searchPath.unshift(dirname(this.binary));
    this.env = { ...env, PATH: searchPath.join(delimiter) };
  }

  withGlobalArgs(globalArgs, envOverrides = {}) {
    const next = new DockerCli({ binary: this.binary, env: this.env, globalArgs });
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete next.env[key];
      else next.env[key] = value;
    }
    return next;
  }

  /** Runs a finite command and resolves with its output, or rejects with a DockerCanvasError. */
  run(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, signal, allowFailure = false } = {}) {
    assertArgs(args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...this.globalArgs, ...args], {
        cwd,
        env: this.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let settled = false;
      let failure = null;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        fn();
      };
      const kill = (reason) => {
        failure = reason;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      };
      const onAbort = () => kill(new DockerCanvasError("cancelled", "Docker command was cancelled"));
      const timer = setTimeout(
        () => kill(new DockerCanvasError("timeout", `Docker command timed out after ${Math.round(timeoutMs / 1000)}s: docker ${args.slice(0, 3).join(" ")}`)),
        timeoutMs,
      );
      signal?.addEventListener?.("abort", onAbort, { once: true });

      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          if (!failure) kill(new DockerCanvasError("output_too_large", `Docker output exceeded ${maxBytes} bytes`));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", (error) =>
        finish(() =>
          reject(
            error.code === "ENOENT"
              ? new DockerCanvasError("docker_not_found", `Docker CLI not found at ${this.binary}`)
              : new DockerCanvasError("spawn_failed", error.message),
          ),
        ),
      );
      child.on("close", (code) =>
        finish(() => {
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          if (failure) return reject(failure);
          if (code !== 0 && !allowFailure) {
            const message = err.trim() || `docker exited with code ${code}`;
            return reject(new DockerCanvasError(classifyDockerFailure(err), message.slice(0, 2000), { exitCode: code }));
          }
          resolve({ stdout: out, stderr: err, exitCode: code });
        }),
      );
    });
  }

  /**
   * Starts a long-running command and delivers complete lines. Returns a handle with `stop()` and
   * a `done` promise that resolves with the exit code (or rejects for spawn errors).
   */
  stream(args, { cwd, onStdout, onStderr, timeoutMs } = {}) {
    assertArgs(args);
    const child = spawn(this.binary, [...this.globalArgs, ...args], {
      cwd,
      env: this.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = new LineSplitter((line) => onStdout?.(line));
    const err = new LineSplitter((line) => onStderr?.(line));
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    let stopped = false;
    let timer;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    };
    if (timeoutMs) timer = setTimeout(stop, timeoutMs);
    const done = new Promise((resolve, reject) => {
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          error.code === "ENOENT"
            ? new DockerCanvasError("docker_not_found", `Docker CLI not found at ${this.binary}`)
            : new DockerCanvasError("spawn_failed", error.message),
        );
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        out.end();
        err.end();
        resolve({ exitCode: code, signal: sig, stopped });
      });
    });
    return { stop, done, get pid() { return child.pid; } };
  }
}

function assertArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new DockerCanvasError("internal_error", "Docker arguments must be an array of strings");
  }
}
