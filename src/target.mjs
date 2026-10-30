import { DockerCanvasError } from "./errors.mjs";

const LOCAL_SCHEMES = ["unix://", "npipe://"];

export function isLocalEndpoint(endpoint) {
  return typeof endpoint === "string" && LOCAL_SCHEMES.some((scheme) => endpoint.startsWith(scheme));
}

/**
 * Resolves which Docker daemon the canvas talks to, without mutating global CLI state
 * (never `docker context use`). The result is frozen and its global args are passed on
 * every subsequent command so a later context switch elsewhere cannot redirect operations.
 */
export async function resolveTarget(cli, env = process.env) {
  if (env.DOCKER_HOST) {
    const endpoint = env.DOCKER_HOST;
    assertLocal(endpoint, "DOCKER_HOST");
    return Object.freeze({
      source: "DOCKER_HOST",
      context: null,
      endpoint,
      globalArgs: Object.freeze(["-H", endpoint]),
      envOverrides: Object.freeze({ DOCKER_CONTEXT: undefined }),
    });
  }
  const context = env.DOCKER_CONTEXT || (await cli.run(["context", "show"], { timeoutMs: 10_000 })).stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(context)) {
    throw new DockerCanvasError("invalid_input", `Unexpected Docker context name: ${context}`);
  }
  const endpoint = await contextEndpoint(cli, context);
  assertLocal(endpoint, `context "${context}"`);
  return Object.freeze({
    source: env.DOCKER_CONTEXT ? "DOCKER_CONTEXT" : "current-context",
    context,
    endpoint,
    globalArgs: Object.freeze(["--context", context]),
    envOverrides: Object.freeze({ DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined }),
  });
}

async function contextEndpoint(cli, context) {
  const { stdout } = await cli.run(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], {
    timeoutMs: 10_000,
  });
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new DockerCanvasError("parse_error", `Could not read endpoint for Docker context ${context}`);
  }
}

function assertLocal(endpoint, label) {
  if (!isLocalEndpoint(endpoint)) {
    throw new DockerCanvasError(
      "remote_target_rejected",
      `Docker ${label} points to ${endpoint}. Docker Canvas only manages local daemons (unix:// or npipe://).`,
    );
  }
}

/** Re-checks that a named context still resolves to the approved endpoint before mutations. */
export async function revalidateTarget(cli, target) {
  if (!target.context) return target;
  const endpoint = await contextEndpoint(cli, target.context);
  if (endpoint !== target.endpoint) {
    throw new DockerCanvasError(
      "target_changed",
      `Docker context "${target.context}" now points to ${endpoint} (was ${target.endpoint}). Reopen the canvas to approve the new target.`,
    );
  }
  return target;
}

export function describeTarget(target) {
  return { source: target.source, context: target.context, endpoint: target.endpoint, local: isLocalEndpoint(target.endpoint) };
}
