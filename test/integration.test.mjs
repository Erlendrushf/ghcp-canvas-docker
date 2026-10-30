// Opt-in: DOCKER_IT=1 node --test test/integration.test.mjs
// Uses the real local Docker daemon. Creates and removes its own alpine containers and a
// temporary Compose project; never touches anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerService } from "../src/docker-service.mjs";
import { CanvasServer } from "../src/server.mjs";

const enabled = process.env.DOCKER_IT === "1";
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const name = `dc-it-${suffix}`;
const project = `dc-it-${suffix}`.toLowerCase();

test("real Docker end-to-end", { skip: !enabled && "set DOCKER_IT=1 to run", timeout: 300_000 }, async (t) => {
  const service = new DockerService();
  const server = new CanvasServer(service);
  const dir = mkdtempSync(join(tmpdir(), "dc-it-"));
  t.after(async () => {
    await service.cli?.run(["container", "rm", "--force", "--", name], { allowFailure: true });
    await service.cli?.run(["compose", "--project-directory", dir, "--project-name", project, "down", "--volumes"], { cwd: dir, allowFailure: true });
    rmSync(dir, { recursive: true, force: true });
    await server.stop();
    service.shutdown();
  });

  const status = await service.execute("status", {});
  assert.ok(status.daemonReachable, "daemon reachable");

  await t.test("pull + run + inspect + logs + stats", async () => {
    await service.execute("pull_image", { image: "alpine:3.20" });
    const run = await service.execute("run_container", {
      image: "alpine:3.20",
      name,
      env: { TOKEN: "s3cret" },
      command: ["sh", "-c", "echo hello-from-canvas; sleep 300"],
    });
    assert.match(run.id, /^[a-f0-9]{64}$/);
    const list = await service.execute("list_containers", {});
    const mine = list.find((c) => c.name === name);
    assert.equal(mine.state, "running");
    assert.equal(mine.managed, true);
    const inspect = await service.execute("inspect_container", { container: name });
    assert.ok(!JSON.stringify(inspect).includes("s3cret"));
    let logs;
    for (let i = 0; i < 20; i++) {
      logs = await service.execute("get_logs", { container: name, tail: 10 });
      if (logs.lines.some((l) => l.line.includes("hello-from-canvas"))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(logs.lines.some((l) => l.line.includes("hello-from-canvas")));
    const stats = await service.execute("get_stats", { container: name });
    assert.equal(stats.length, 1);
  });

  await t.test("lifecycle and approved removal", async () => {
    await service.execute("stop_container", { container: name, timeout: 1 });
    assert.equal((await service.execute("list_containers", {})).find((c) => c.name === name).state, "exited");
    await service.execute("start_container", { container: name });
    const pending = await service.execute("remove_container", { container: name, force: true }, { origin: "agent" });
    assert.equal(pending.status, "pending_approval");
    assert.ok((await service.execute("list_containers", {})).some((c) => c.name === name), "still present before approval");
    await service.approve(pending.approvalId);
    assert.ok(!(await service.execute("list_containers", {})).some((c) => c.name === name));
  });

  await t.test("compose config → up (approved) → ps → down (approved)", async () => {
    writeFileSync(
      join(dir, "compose.yaml"),
      `name: ${project}\nservices:\n  sleeper:\n    image: alpine:3.20\n    command: ["sleep", "300"]\n`,
    );
    const config = await service.execute("compose_config", { projectDir: dir });
    assert.equal(config.projectName, project);
    assert.deepEqual(config.services.map((s) => s.name), ["sleeper"]);
    const up = await service.execute("compose_up", { projectDir: dir, waitTimeout: 60 });
    await service.approve(up.approvalId);
    const ps = await service.execute("compose_ps", { projectDir: dir });
    assert.equal(ps.length, 1);
    assert.equal(ps[0].state, "running");
    const down = await service.execute("compose_down", { projectDir: dir });
    await service.approve(down.approvalId);
    assert.equal((await service.execute("compose_ps", { projectDir: dir })).length, 0);
  });

  await t.test("HTTP event stream delivers a container snapshot", async () => {
    await server.start();
    const base = server.registerInstance("it-panel", { defaultDir: dir });
    const controller = new AbortController();
    const res = await fetch(`${base}api/events`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (!buffer.includes("event: containers") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    controller.abort();
    assert.ok(buffer.includes("event: status"));
    assert.ok(buffer.includes("event: containers"));
  });
});
