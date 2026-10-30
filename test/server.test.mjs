import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerService } from "../src/docker-service.mjs";
import { CanvasServer } from "../src/server.mjs";
import { buildCanvasDeclaration, ACTIONS } from "../src/canvas.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "dc-srv-"));
  const logFile = join(dir, "argv.log");
  writeFileSync(logFile, "");
  return new DockerService({ env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CANVAS_DOCKER_BIN: FAKE, FAKE_DOCKER_LOG: logFile } });
}

function send(url, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Host: u.host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (url, payload, headers = {}) =>
  send(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(url).origin, ...headers }, body: JSON.stringify(payload) });

async function setup(t) {
  const service = makeService();
  const server = new CanvasServer(service);
  await server.start();
  await service.ensureTarget();
  const base = server.registerInstance("panel-1", { defaultDir: "/tmp" });
  t.after(async () => {
    await server.stop();
    service.shutdown();
  });
  return { service, server, base };
}

test("serves the UI with security headers on the tokenized path only", async (t) => {
  const { base, server } = await setup(t);
  const page = await send(base);
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'none'.*script-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.match(page.text, /<title>/);
  assert.equal((await send(`${server.origin}/p/${"A".repeat(43)}/`)).status, 401);
  assert.equal((await send(`${server.origin}/`)).status, 401);
});

test("rejects a forged Host header (DNS rebinding)", async (t) => {
  const { base } = await setup(t);
  const res = await send(base, { headers: { Host: "evil.example:80" } });
  assert.equal(res.status, 403);
});

test("POST requires same origin and JSON content type", async (t) => {
  const { base } = await setup(t);
  assert.equal((await post(`${base}api/op/status`, {}, { Origin: "http://evil.example" })).status, 403);
  const form = await send(`${base}api/op/status`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" });
  assert.equal(form.status, 415);
  const badJson = await send(`${base}api/op/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(badJson.status, 400);
  const big = await post(`${base}api/op/status`, { pad: "x".repeat(70 * 1024) });
  assert.equal(big.status, 413);
});

test("operations run through the shared service", async (t) => {
  const { base } = await setup(t);
  const res = await post(`${base}api/op/list_containers`, {});
  assert.equal(res.status, 200);
  assert.equal(res.json.result[0].name, "web");
  const unknown = await post(`${base}api/op/exec`, {});
  assert.equal(unknown.status, 404);
});

test("panel approves an agent-requested removal", async (t) => {
  const { base, service } = await setup(t);
  const pending = await service.execute("remove_container", { container: "web" }, { origin: "agent" });
  const res = await post(`${base}api/approvals/${pending.approvalId}/approve`, {});
  assert.equal(res.status, 202);
  for (let i = 0; i < 50 && service.getApproval(pending.approvalId).status !== "succeeded"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(service.getApproval(pending.approvalId).status, "succeeded");
  assert.equal((await post(`${base}api/approvals/${pending.approvalId}/approve`, {})).status, 409);
});

test("closing the panel revokes its token", async (t) => {
  const { base, server } = await setup(t);
  server.revokeInstance("panel-1");
  assert.equal((await send(`${base}api/bootstrap`)).status, 401);
});

test("canvas declaration: open is idempotent, actions route to the service, errors become CanvasError", async (t) => {
  const service = makeService();
  const server = new CanvasServer(service);
  t.after(async () => {
    await server.stop();
    service.shutdown();
  });
  class CanvasError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const decl = buildCanvasDeclaration({ service, server, CanvasError });
  assert.equal(decl.id, "docker");
  assert.equal(decl.actions.length, ACTIONS.length);

  const ctx = { instanceId: "inst-1", input: { view: "images" }, session: { workingDirectory: "/tmp" } };
  const first = await decl.open(ctx);
  const again = await decl.open({ ...ctx, reason: "rehydrate" });
  assert.equal(first.url, again.url);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[A-Za-z0-9_-]{43}\/$/);
  assert.equal(first.status, "context: fake-ctx");

  const action = (name) => decl.actions.find((a) => a.name === name);
  const list = await action("list_containers").handler({ instanceId: "inst-1", input: {} });
  assert.equal(list[0].name, "web");

  const pending = await action("remove_container").handler({ instanceId: "inst-1", input: { container: "web" } });
  assert.equal(pending.status, "pending_approval");
  assert.equal(service.getApproval(pending.approvalId).origin, "agent");
  const status = await action("get_approval").handler({ instanceId: "inst-1", input: { approvalId: pending.approvalId } });
  assert.equal(status.status, "pending");
  assert.ok(!decl.actions.some((a) => /approve/.test(a.name)), "agent has no approve action");

  await assert.rejects(action("start_container").handler({ instanceId: "inst-1", input: { container: "--rm" } }), (error) => {
    assert.ok(error instanceof CanvasError);
    assert.equal(error.code, "invalid_input");
    return true;
  });

  await decl.onClose({ instanceId: "inst-1" });
  assert.equal(server.instanceDefaults("inst-1"), null);
});

test("action schemas are well-formed", () => {
  for (const action of ACTIONS) {
    assert.match(action.name, /^[a-z_]+$/);
    assert.equal(action.inputSchema.type, "object");
    assert.ok(action.description.length > 10);
  }
});
