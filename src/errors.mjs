export class DockerCanvasError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DockerCanvasError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const HTTP_STATUS = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  approval_not_found: 404,
  conflict: 409,
  approval_expired: 410,
  approval_mismatch: 409,
  payload_too_large: 413,
  daemon_unavailable: 503,
  docker_not_found: 503,
  remote_target_rejected: 403,
  target_changed: 409,
  permission_denied: 403,
  timeout: 504,
};

const STDERR_PATTERNS = [
  [/Cannot connect to the Docker daemon|error during connect|Is the docker daemon running|failed to connect to the docker API/i, "daemon_unavailable"],
  [/No such (container|image|object)|not found: manifest unknown|pull access denied|repository does not exist/i, "not_found"],
  [/permission denied/i, "permission_denied"],
  [/Conflict\.|is already in use|is not running|cannot remove a running container|already exists/i, "conflict"],
  [/unknown flag|invalid reference format|invalid argument|is not a valid/i, "invalid_input"],
];

export function classifyDockerFailure(stderr) {
  for (const [pattern, code] of STDERR_PATTERNS) {
    if (pattern.test(stderr)) return code;
  }
  return "docker_failed";
}

export function toErrorPayload(error) {
  if (error instanceof DockerCanvasError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "internal_error", message: error?.message || String(error) };
}
