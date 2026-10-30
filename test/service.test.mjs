import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerService } from "../src/docker-service.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));

function setup(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dc-svc-"));
  const logFile = join(dir, "argv.log");
  writeFileSync(logFile, "");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CANVAS_DOCKER_BIN: FAKE, FAKE_DOCKER_LOG: logFile, ...extraEnv };
  const service = new DockerService({ env });
  const calls = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, env, service, calls };
}

test("resolves the current context and pins it on every command", async (t) => {
  const { service, calls } = setup();
  t.after(() => service.shutdown());
  const target = await service.ensureTarget();
  assert.equal(target.context, "fake-ctx");
  await service.execute("list_containers", {});
  const ls = calls().find((c) => c.includes("ls"));
  assert.deepEqual(ls.slice(0, 2), ["--context", "fake-ctx"]);
});

test("rejects remote Docker endpoints", async () => {
  const { service } = setup({ FAKE_DOCKER_ENDPOINT: "tcp://10.1.2.3:2376" });
  await assert.rejects(service.ensureTarget(), { code: "remote_target_rejected" });
  const remoteHost = setup({ DOCKER_HOST: "ssh://user@host" });
  await assert.rejects(remoteHost.service.ensureTarget(), { code: "remote_target_rejected" });
});

test("list_containers maps compose labels", async (t) => {
  const { service } = setup();
  t.after(() => service.shutdown());
  const [c] = await service.execute("list_containers", {});
  assert.equal(c.name, "web");
  assert.equal(c.composeProject, "demo");
  assert.equal(c.composeService, "web");
});

test("inspect hides environment values", async (t) => {
  const { service } = setup();
  t.after(() => service.shutdown());
  const result = await service.execute("inspect_container", { container: "web" });
  assert.ok(!JSON.stringify(result).includes("hunter2"));
  assert.deepEqual(result.env.map((e) => e.key), ["SECRET", "PATH"]);
});

test("remove_container from the agent needs approval; only approve() executes it", async (t) => {
  const { service, calls } = setup();
  t.after(() => service.shutdown());
  const pending = await service.execute("remove_container", { container: "web" }, { origin: "agent" });
  assert.equal(pending.status, "pending_approval");
  assert.ok(!calls().some((c) => c.includes("rm")), "nothing removed before approval");
  assert.equal(service.getApproval(pending.approvalId).status, "pending");

  const result = await service.approve(pending.approvalId);
  assert.deepEqual(result, { removed: "web" });
  assert.ok(calls().some((c) => c.join(" ").endsWith("container rm -- web")));
  assert.equal(service.getApproval(pending.approvalId).status, "succeeded");
  await assert.rejects(service.approve(pending.approvalId), { code: "conflict" });
});

test("denied approvals never run", async (t) => {
  const { service, calls } = setup();
  t.after(() => service.shutdown());
  const pending = await service.execute("remove_container", { container: "web" });
  service.deny(pending.approvalId);
  await assert.rejects(service.approve(pending.approvalId), { code: "conflict" });
  assert.ok(!calls().some((c) => c.includes("rm")));
});

test("run_container without ports or mounts runs directly; with ports requires approval", async (t) => {
  const { service, calls } = setup();
  t.after(() => service.shutdown());
  const direct = await service.execute("run_container", { image: "alpine", command: ["sleep", "1"] });
  assert.equal(direct.id, "deadbeefcafe");
  const pending = await service.execute("run_container", { image: "nginx", ports: [{ hostPort: 8080, containerPort: 80 }] });
  assert.equal(pending.status, "pending_approval");
  assert.equal(calls().filter((c) => c.includes("run")).length, 1);
});

test("compose_up approval is invalidated when the config changes", async (t) => {
  const { dir, env, service } = setup();
  t.after(() => service.shutdown());
  const pending = await service.execute("compose_up", { projectDir: dir });
  assert.equal(pending.status, "pending_approval");
  assert.match(pending.summary, /demo/);
  env.FAKE_COMPOSE_CONFIG = JSON.stringify({ name: "demo", services: { web: { image: "nginx", privileged: true } } });
  service.cli.env.FAKE_COMPOSE_CONFIG = env.FAKE_COMPOSE_CONFIG;
  await assert.rejects(service.approve(pending.approvalId), { code: "approval_mismatch" });
  assert.equal(service.getApproval(pending.approvalId).status, "failed");
});

test("compose_up runs after approval with --wait", async (t) => {
  const { dir, service, calls } = setup();
  t.after(() => service.shutdown());
  const pending = await service.execute("compose_up", { projectDir: dir });
  await service.approve(pending.approvalId);
  const up = calls().find((c) => c.includes("up"));
  assert.ok(up.includes("--detach") && up.includes("--wait"));
  const op = service.operations.list().find((o) => o.title.startsWith("Compose up"));
  assert.equal(op.status, "succeeded");
});

test("approval is rejected when the Docker target changed", async (t) => {
  const { service } = setup();
  t.after(() => service.shutdown());
  const pending = await service.execute("remove_container", { container: "web" });
  service.baseCli.env.FAKE_DOCKER_ENDPOINT = "unix:///tmp/other.sock";
  await assert.rejects(service.approve(pending.approvalId), { code: "target_changed" });
});

test("unknown operations and invalid input are rejected", async (t) => {
  const { service } = setup();
  t.after(() => service.shutdown());
  await assert.rejects(service.execute("exec", {}), { code: "not_found" });
  await assert.rejects(service.execute("start_container", { container: "-x" }), { code: "invalid_input" });
  await assert.rejects(service.execute("start_container", []), { code: "invalid_input" });
});
