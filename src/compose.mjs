import { createHash } from "node:crypto";
import { DockerCanvasError } from "./errors.mjs";
import { isDockerSocketPath } from "./validate.mjs";

export function composeBaseArgs(selection) {
  const args = ["compose", "--project-directory", selection.projectDir];
  for (const file of selection.files) args.push("--file", file);
  if (selection.projectName) args.push("--project-name", selection.projectName);
  for (const profile of selection.profiles) args.push("--profile", profile);
  return args;
}

/**
 * Loads the effective Compose model via Compose itself (includes, extends, env interpolation)
 * and reduces it to a secret-free summary plus a hash that binds approvals to this exact model.
 * The full resolved config can contain secrets, so it is never returned or logged.
 */
export async function loadComposeModel(cli, selection) {
  const { stdout } = await cli.run([...composeBaseArgs(selection), "config", "--format", "json"], {
    cwd: selection.projectDir,
    timeoutMs: 30_000,
  });
  let config;
  try {
    config = JSON.parse(stdout);
  } catch {
    throw new DockerCanvasError("parse_error", "docker compose config did not return JSON");
  }
  return {
    configHash: createHash("sha256").update(stdout).digest("hex"),
    summary: summarizeCompose(config),
  };
}

export function summarizeCompose(config) {
  const services = Object.entries(config?.services ?? {}).map(([name, svc]) => {
    const ports = (svc.ports ?? []).map((p) =>
      typeof p === "object"
        ? { hostIp: p.host_ip || "0.0.0.0", published: p.published ? String(p.published) : null, target: p.target, protocol: p.protocol || "tcp" }
        : { raw: String(p) },
    );
    const binds = (svc.volumes ?? [])
      .filter((v) => typeof v === "object" && v.type === "bind")
      .map((v) => ({ source: v.source, target: v.target, readOnly: Boolean(v.read_only) }));
    return {
      name,
      image: svc.image ?? null,
      build: Boolean(svc.build),
      containerName: svc.container_name ?? null,
      ports,
      binds,
      privileged: Boolean(svc.privileged),
      networkMode: svc.network_mode ?? null,
      pid: svc.pid ?? null,
      capAdd: svc.cap_add ?? [],
      profiles: svc.profiles ?? [],
    };
  });
  const external = (section) =>
    Object.entries(config?.[section] ?? {})
      .filter(([, v]) => v?.external)
      .map(([k, v]) => v?.name || k);
  return {
    projectName: config?.name ?? null,
    services,
    externalVolumes: external("volumes"),
    externalNetworks: external("networks"),
  };
}

export function composeRisks(summary) {
  const risks = [];
  for (const svc of summary.services) {
    if (svc.privileged) risks.push({ level: "high", service: svc.name, message: "runs privileged" });
    if (svc.networkMode === "host") risks.push({ level: "high", service: svc.name, message: "uses host networking" });
    if (svc.pid === "host") risks.push({ level: "high", service: svc.name, message: "shares the host PID namespace" });
    if (svc.capAdd.length) risks.push({ level: "medium", service: svc.name, message: `adds capabilities: ${svc.capAdd.join(", ")}` });
    for (const bind of svc.binds) {
      if (isDockerSocketPath(bind.source)) risks.push({ level: "high", service: svc.name, message: `mounts the Docker socket (${bind.source})` });
      else risks.push({ level: "info", service: svc.name, message: `bind-mounts ${bind.source} → ${bind.target}${bind.readOnly ? " (ro)" : ""}` });
    }
    for (const p of svc.ports) {
      if (p.raw) risks.push({ level: "info", service: svc.name, message: `publishes ${p.raw}` });
      else if (p.published) {
        const exposed = p.hostIp === "0.0.0.0" || p.hostIp === "::";
        risks.push({
          level: exposed ? "medium" : "info",
          service: svc.name,
          message: `publishes ${p.hostIp}:${p.published} → ${p.target}/${p.protocol}${exposed ? " (all interfaces)" : ""}`,
        });
      }
    }
    if (svc.containerName) risks.push({ level: "info", service: svc.name, message: `fixed container_name "${svc.containerName}" may collide with other stacks` });
    if (svc.build) risks.push({ level: "info", service: svc.name, message: "builds an image from local sources" });
  }
  for (const v of summary.externalVolumes) risks.push({ level: "info", message: `uses external volume ${v}` });
  for (const n of summary.externalNetworks) risks.push({ level: "info", message: `uses external network ${n}` });
  return risks;
}
