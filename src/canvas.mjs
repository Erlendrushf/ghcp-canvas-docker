import { toErrorPayload } from "./errors.mjs";

const container = { type: "string", description: "Container ID or name (from list_containers)." };
const composeSelection = {
  projectDir: { type: "string", description: "Absolute path of the Compose project directory. Defaults to the session working directory." },
  files: { type: "array", items: { type: "string" }, description: "Compose files relative to projectDir. Defaults to Compose's standard file lookup." },
  projectName: { type: "string", description: "Compose project name override (lowercase)." },
  profiles: { type: "array", items: { type: "string" } },
};
const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const PENDING_NOTE = " Returns status 'pending_approval' with an approvalId; the user must confirm it in the Docker panel. Use get_approval to check the outcome.";

export const ACTIONS = [
  { name: "status", op: "status", description: "Show the resolved local Docker target and daemon/CLI versions.", inputSchema: obj() },
  { name: "list_containers", op: "list_containers", description: "List containers (all by default).", inputSchema: obj({ all: { type: "boolean" } }) },
  { name: "inspect_container", op: "inspect_container", description: "Inspect one container. Environment values are hidden.", inputSchema: obj({ container }, ["container"]) },
  {
    name: "get_logs",
    op: "get_logs",
    description: "Return the last N log lines (default 200, max 2000) of a container.",
    inputSchema: obj({ container, tail: { type: "integer", minimum: 1, maximum: 2000 } }, ["container"]),
  },
  { name: "get_stats", op: "get_stats", description: "One-shot CPU/memory/IO stats for running containers, or one container.", inputSchema: obj({ container }) },
  { name: "start_container", op: "start_container", description: "Start a stopped container.", inputSchema: obj({ container }, ["container"]) },
  {
    name: "stop_container",
    op: "stop_container",
    description: "Stop a running container.",
    inputSchema: obj({ container, timeout: { type: "integer", minimum: 0, maximum: 300 } }, ["container"]),
  },
  {
    name: "restart_container",
    op: "restart_container",
    description: "Restart a container.",
    inputSchema: obj({ container, timeout: { type: "integer", minimum: 0, maximum: 300 } }, ["container"]),
  },
  {
    name: "remove_container",
    op: "remove_container",
    description: "Remove a container (requires user approval)." + PENDING_NOTE,
    inputSchema: obj({ container, force: { type: "boolean" } }, ["container"]),
  },
  { name: "list_images", op: "list_images", description: "List local images.", inputSchema: obj() },
  { name: "pull_image", op: "pull_image", description: "Pull an image (e.g. nginx:alpine). Progress is shown in the panel.", inputSchema: obj({ image: { type: "string" } }, ["image"]) },
  {
    name: "run_container",
    op: "run_container",
    description:
      "Run a new detached container. Ports default to 127.0.0.1. Privileged mode, host networking and Docker-socket or system-path mounts are not supported. Requests with ports, bind mounts or volumes need user approval." +
      PENDING_NOTE,
    inputSchema: obj(
      {
        image: { type: "string" },
        name: { type: "string" },
        ports: {
          type: "array",
          items: obj(
            {
              containerPort: { type: "integer" },
              hostPort: { type: "integer" },
              hostIp: { type: "string", enum: ["127.0.0.1", "::1", "0.0.0.0"] },
              protocol: { type: "string", enum: ["tcp", "udp"] },
            },
            ["containerPort"],
          ),
        },
        env: { type: "object", additionalProperties: { type: "string" } },
        mounts: {
          type: "array",
          items: obj({ source: { type: "string" }, target: { type: "string" }, readOnly: { type: "boolean" } }, ["source", "target"]),
        },
        volumes: {
          type: "array",
          items: obj({ name: { type: "string" }, target: { type: "string" }, readOnly: { type: "boolean" } }, ["name", "target"]),
        },
        command: { type: "array", items: { type: "string" } },
        autoRemove: { type: "boolean" },
        pull: { type: "string", enum: ["missing", "always", "never"] },
      },
      ["image"],
    ),
  },
  { name: "compose_config", op: "compose_config", description: "Summarize a Compose project's services, ports, mounts and risks (no secrets).", inputSchema: obj(composeSelection) },
  { name: "compose_ps", op: "compose_ps", description: "List containers of a Compose project.", inputSchema: obj(composeSelection) },
  {
    name: "compose_up",
    op: "compose_up",
    description: "Start a Compose project detached (docker compose up -d, waits for health by default). Always requires user approval." + PENDING_NOTE,
    inputSchema: obj({
      ...composeSelection,
      wait: { type: "boolean" },
      waitTimeout: { type: "integer", minimum: 5, maximum: 1800 },
      build: { type: "boolean" },
    }),
  },
  {
    name: "compose_down",
    op: "compose_down",
    description: "Stop and remove a Compose project. Requires user approval." + PENDING_NOTE,
    inputSchema: obj({ ...composeSelection, removeVolumes: { type: "boolean" } }),
  },
  {
    name: "get_approval",
    description: "Get the status and result of an approval returned by a previous action.",
    inputSchema: obj({ approvalId: { type: "string" } }, ["approvalId"]),
  },
];

/**
 * Builds the createCanvas() declaration. Kept free of SDK imports so it can be unit tested;
 * extension.mjs injects CanvasError.
 */
export function buildCanvasDeclaration({ service, server, CanvasError }) {
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      const { code, message } = toErrorPayload(error);
      throw new CanvasError(code, message);
    }
  };

  return {
    id: "docker",
    displayName: "Docker",
    description: "Manage local Docker containers, images and Compose projects: status, logs, stats, start/stop, pull, run, compose up/down.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["containers", "images", "compose", "activity"], description: "Initial tab." },
        projectDir: { type: "string", description: "Absolute Compose project directory to preselect." },
      },
      additionalProperties: false,
    },
    actions: ACTIONS.map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
      handler: (ctx) =>
        wrap(async () => {
          if (action.name === "get_approval") return service.getApproval(ctx.input?.approvalId);
          const defaultDir = server.instanceDefaults(ctx.instanceId)?.defaultDir ?? ctx.session?.workingDirectory ?? null;
          return service.execute(action.op, ctx.input ?? {}, { origin: "agent", defaultDir });
        }),
    })),
    open: (ctx) =>
      wrap(async () => {
        await server.start();
        const url = server.registerInstance(ctx.instanceId, {
          defaultDir: ctx.input?.projectDir ?? ctx.session?.workingDirectory ?? null,
          view: ctx.input?.view ?? "containers",
        });
        // Resolve the target early so the panel shows a clear error if Docker is unavailable.
        let status = "Docker";
        try {
          const target = await service.ensureTarget();
          status = target.context ? `context: ${target.context}` : target.endpoint;
        } catch (error) {
          status = toErrorPayload(error).message.slice(0, 80);
        }
        return { url, title: "Docker", status };
      }),
    onClose: async (ctx) => {
      // Only panel resources are released; containers keep running.
      server.revokeInstance(ctx.instanceId);
    },
  };
}
