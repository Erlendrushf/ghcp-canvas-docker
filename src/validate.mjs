import { statSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { DockerCanvasError } from "./errors.mjs";

const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ALLOWED_HOST_IPS = new Set(["127.0.0.1", "0.0.0.0", "::1"]);

// Host paths that would give a container control over the host or the Docker daemon.
const BLOCKED_MOUNT_SOURCES = [
  "/",
  "/var/run",
  "/run",
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/private/etc",
  "/private/var/run",
];
const BLOCKED_HOME_DIRS = [".ssh", ".docker", ".aws", ".azure", ".kube", ".gnupg", ".config/gh", ".copilot"];

function invalid(message) {
  return new DockerCanvasError("invalid_input", message);
}

export function containerRef(value, field = "container") {
  if (typeof value !== "string" || !CONTAINER_REF.test(value)) throw invalid(`${field} must be a container ID or name`);
  return value;
}

export function imageRef(value, field = "image") {
  if (typeof value !== "string" || !IMAGE_REF.test(value) || value.includes("..")) {
    throw invalid(`${field} must be an image reference such as nginx:alpine`);
  }
  return value;
}

export function optionalBoolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}

export function boundedInt(value, field, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function port(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw invalid(`${field} must be a port between 1 and 65535`);
  return value;
}

export function isDockerSocketPath(path) {
  return /(^|\/)docker\.sock$/.test(path) || /(^|\/)\.docker\/run(\/|$)/.test(path);
}

export function mountSource(value, field = "source") {
  if (typeof value !== "string" || !isAbsolute(value)) throw invalid(`${field} must be an absolute host path`);
  if (value.includes(",") || value.includes("\n")) throw invalid(`${field} must not contain commas or newlines`);
  const normalized = normalize(value).replace(/\/+$/, "") || "/";
  const blocked =
    normalized === "/" ||
    isDockerSocketPath(normalized) ||
    BLOCKED_MOUNT_SOURCES.some((p) => p !== "/" && (normalized === p || normalized.startsWith(`${p}/`)));
  if (blocked) {
    throw new DockerCanvasError("forbidden", `Mounting ${normalized} is not allowed`);
  }
  const home = process.env.HOME;
  if (home && normalized === home) throw new DockerCanvasError("forbidden", "Mounting your entire home directory is not allowed");
  if (home && BLOCKED_HOME_DIRS.some((d) => normalized === `${home}/${d}` || normalized.startsWith(`${home}/${d}/`))) {
    throw new DockerCanvasError("forbidden", `Mounting ${normalized} is not allowed (credentials directory)`);
  }
  return normalized;
}

function containerPath(value, field) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes(",") || value.includes("\n")) {
    throw invalid(`${field} must be an absolute container path without commas`);
  }
  return value;
}

/** Validates the `run_container` spec. Unsupported keys are rejected so nothing is silently ignored. */
export function runSpec(input) {
  if (!input || typeof input !== "object") throw invalid("run spec must be an object");
  const allowed = new Set(["image", "name", "ports", "env", "mounts", "volumes", "command", "autoRemove", "pull"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unsupported run option: ${key}`);

  const spec = { image: imageRef(input.image) };
  if (input.name !== undefined && input.name !== "") {
    if (typeof input.name !== "string" || !CONTAINER_NAME.test(input.name)) throw invalid("name must match [A-Za-z0-9][A-Za-z0-9_.-]*");
    spec.name = input.name;
  }
  spec.ports = arrayOf(input.ports, "ports", 32).map((p, i) => {
    if (!p || typeof p !== "object") throw invalid(`ports[${i}] must be an object`);
    const hostIp = p.hostIp ?? "127.0.0.1";
    if (!ALLOWED_HOST_IPS.has(hostIp)) throw invalid(`ports[${i}].hostIp must be 127.0.0.1, ::1 or 0.0.0.0`);
    const protocol = p.protocol ?? "tcp";
    if (protocol !== "tcp" && protocol !== "udp") throw invalid(`ports[${i}].protocol must be tcp or udp`);
    return {
      hostIp,
      hostPort: p.hostPort === undefined || p.hostPort === null ? null : port(p.hostPort, `ports[${i}].hostPort`),
      containerPort: port(p.containerPort, `ports[${i}].containerPort`),
      protocol,
    };
  });
  spec.env = {};
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== "object" || Array.isArray(input.env)) throw invalid("env must be an object of strings");
    const entries = Object.entries(input.env);
    if (entries.length > 64) throw invalid("env supports at most 64 variables");
    for (const [key, value] of entries) {
      if (!ENV_KEY.test(key)) throw invalid(`Invalid environment variable name: ${key}`);
      if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw invalid(`env.${key} must be a string`);
      spec.env[key] = value;
    }
  }
  spec.mounts = arrayOf(input.mounts, "mounts", 16).map((m, i) => ({
    source: mountSource(m?.source, `mounts[${i}].source`),
    target: containerPath(m?.target, `mounts[${i}].target`),
    readOnly: optionalBoolean(m?.readOnly, `mounts[${i}].readOnly`, false),
  }));
  spec.volumes = arrayOf(input.volumes, "volumes", 16).map((v, i) => {
    if (typeof v?.name !== "string" || !VOLUME_NAME.test(v.name)) throw invalid(`volumes[${i}].name must be a volume name`);
    return {
      name: v.name,
      target: containerPath(v?.target, `volumes[${i}].target`),
      readOnly: optionalBoolean(v?.readOnly, `volumes[${i}].readOnly`, false),
    };
  });
  spec.command = arrayOf(input.command, "command", 64).map((part, i) => {
    if (typeof part !== "string" || part.length > 4096 || part.includes("\0")) throw invalid(`command[${i}] must be a string`);
    return part;
  });
  spec.autoRemove = optionalBoolean(input.autoRemove, "autoRemove", false);
  if (input.pull !== undefined && !["missing", "always", "never"].includes(input.pull)) throw invalid("pull must be missing, always or never");
  spec.pull = input.pull ?? "missing";
  return spec;
}

function arrayOf(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  if (value.length > max) throw invalid(`${field} supports at most ${max} entries`);
  return value;
}

export const MANAGED_LABEL = "com.github.copilot.docker-canvas";

export function runArgs(spec) {
  const args = ["run", "--detach", "--label", `${MANAGED_LABEL}=true`, `--pull=${spec.pull}`];
  if (spec.name) args.push("--name", spec.name);
  if (spec.autoRemove) args.push("--rm");
  for (const p of spec.ports) {
    const host = p.hostIp.includes(":") ? `[${p.hostIp}]` : p.hostIp;
    args.push("--publish", `${host}:${p.hostPort ?? ""}:${p.containerPort}/${p.protocol}`);
  }
  for (const [key, value] of Object.entries(spec.env)) args.push("--env", `${key}=${value}`);
  for (const m of spec.mounts) {
    args.push("--mount", `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ",readonly" : ""}`);
  }
  for (const v of spec.volumes) {
    args.push("--mount", `type=volume,source=${v.name},target=${v.target}${v.readOnly ? ",readonly" : ""}`);
  }
  // `--` keeps image and command from ever being interpreted as docker flags.
  args.push("--", spec.image, ...spec.command);
  return args;
}

/** Validates a Compose project selection: an existing directory plus optional files inside it. */
export function composeSelection(input, { defaultDir } = {}) {
  if (input !== undefined && (input === null || typeof input !== "object")) throw invalid("compose input must be an object");
  const raw = input?.projectDir ?? defaultDir;
  if (typeof raw !== "string" || !isAbsolute(raw)) throw invalid("projectDir must be an absolute path");
  const projectDir = resolve(raw);
  let stats;
  try {
    stats = statSync(projectDir);
  } catch {
    throw new DockerCanvasError("not_found", `Directory does not exist: ${projectDir}`);
  }
  if (!stats.isDirectory()) throw invalid(`projectDir is not a directory: ${projectDir}`);

  const files = arrayOf(input?.files, "files", 8).map((file, i) => {
    if (typeof file !== "string" || file === "" || isAbsolute(file)) throw invalid(`files[${i}] must be a relative path`);
    const full = resolve(projectDir, file);
    if (!full.startsWith(projectDir + sep)) throw invalid(`files[${i}] must stay inside projectDir`);
    try {
      if (!statSync(full).isFile()) throw new Error();
    } catch {
      throw new DockerCanvasError("not_found", `Compose file not found: ${full}`);
    }
    return full;
  });
  let projectName = null;
  if (input?.projectName !== undefined && input.projectName !== "") {
    if (typeof input.projectName !== "string" || !COMPOSE_PROJECT.test(input.projectName)) {
      throw invalid("projectName must be lowercase letters, digits, '-' or '_'");
    }
    projectName = input.projectName;
  }
  const profiles = arrayOf(input?.profiles, "profiles", 16).map((p, i) => {
    if (typeof p !== "string" || !PROFILE.test(p)) throw invalid(`profiles[${i}] is not a valid profile name`);
    return p;
  });
  return { projectDir, files, projectName, profiles };
}
