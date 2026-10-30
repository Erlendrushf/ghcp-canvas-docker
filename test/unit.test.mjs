import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonRecords, LineSplitter, RingBuffer } from "../src/parse.mjs";
import * as v from "../src/validate.mjs";
import { ApprovalStore } from "../src/approvals.mjs";
import { classifyDockerFailure } from "../src/errors.mjs";
import { summarizeCompose, composeRisks, composeBaseArgs } from "../src/compose.mjs";
import { isLocalEndpoint } from "../src/target.mjs";

test("parseJsonRecords handles arrays, objects and JSON Lines", () => {
  assert.deepEqual(parseJsonRecords(""), []);
  assert.deepEqual(parseJsonRecords('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonRecords('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseJsonRecords('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parseJsonRecords("{oops"), { code: "parse_error" });
});

test("LineSplitter reassembles lines across chunks and multibyte boundaries", () => {
  const lines = [];
  const splitter = new LineSplitter((l) => lines.push(l));
  const bytes = Buffer.from("héllo\r\nwor");
  splitter.push(bytes.subarray(0, 2));
  splitter.push(bytes.subarray(2));
  splitter.push("ld\npartial");
  splitter.end();
  assert.deepEqual(lines, ["héllo", "world", "partial"]);
});

test("RingBuffer keeps only the newest items", () => {
  const ring = new RingBuffer(2);
  for (const n of [1, 2, 3]) ring.push(n);
  assert.deepEqual(ring.toArray(), [2, 3]);
});

test("refs reject flag injection and junk", () => {
  assert.equal(v.containerRef("web_1"), "web_1");
  assert.throws(() => v.containerRef("--privileged"), { code: "invalid_input" });
  assert.throws(() => v.imageRef("-it"), { code: "invalid_input" });
  assert.equal(v.imageRef("ghcr.io/org/app:1.2@sha256:abc"), "ghcr.io/org/app:1.2@sha256:abc");
});

test("mountSource blocks sensitive host paths", () => {
  for (const bad of ["/", "/etc", "/etc/passwd", "/var/run/docker.sock", "/Users/x/.docker/run/docker.sock", "/proc/1"]) {
    assert.throws(() => v.mountSource(bad), { code: "forbidden" }, bad);
  }
  assert.throws(() => v.mountSource(process.env.HOME), { code: "forbidden" });
  for (const d of [".ssh", ".ssh/id_ed25519", ".docker", ".aws", ".kube/config"]) {
    assert.throws(() => v.mountSource(`${process.env.HOME}/${d}`), { code: "forbidden" }, d);
  }
  assert.equal(v.mountSource(`${process.env.HOME}/.sshfoo`), `${process.env.HOME}/.sshfoo`);
  assert.throws(() => v.mountSource("relative/path"), { code: "invalid_input" });
  assert.throws(() => v.mountSource("/tmp/a,b"), { code: "invalid_input" });
  assert.equal(v.mountSource("/tmp/project/"), "/tmp/project");
});

test("runSpec defaults ports to loopback and builds safe argv", () => {
  const spec = v.runSpec({
    image: "nginx:alpine",
    name: "web",
    ports: [{ hostPort: 8080, containerPort: 80 }],
    env: { A: "1" },
    mounts: [{ source: "/tmp/x", target: "/data", readOnly: true }],
    command: ["--help"],
  });
  assert.equal(spec.ports[0].hostIp, "127.0.0.1");
  const args = v.runArgs(spec);
  assert.ok(args.includes("127.0.0.1:8080:80/tcp"));
  assert.ok(args.includes("type=bind,source=/tmp/x,target=/data,readonly"));
  assert.ok(args.includes(`${v.MANAGED_LABEL}=true`));
  const dashdash = args.indexOf("--");
  assert.deepEqual(args.slice(dashdash), ["--", "nginx:alpine", "--help"]);
});

test("runSpec rejects unknown options and bad values", () => {
  assert.throws(() => v.runSpec({ image: "nginx", privileged: true }), /Unsupported run option: privileged/);
  assert.throws(() => v.runSpec({ image: "nginx", ports: [{ hostIp: "10.0.0.1", containerPort: 80 }] }), { code: "invalid_input" });
  assert.throws(() => v.runSpec({ image: "nginx", env: { "BAD-KEY": "x" } }), { code: "invalid_input" });
  assert.throws(() => v.runSpec({ image: "nginx", ports: [{ containerPort: 70000 }] }), { code: "invalid_input" });
});

test("composeSelection confines files to the project directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "dc-sel-"));
  writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
  mkdirSync(join(dir, "sub"));
  const sel = v.composeSelection({ projectDir: dir, files: ["compose.yaml"], projectName: "demo" });
  assert.deepEqual(sel.files, [join(dir, "compose.yaml")]);
  assert.throws(() => v.composeSelection({ projectDir: dir, files: ["../x.yaml"] }), { code: "invalid_input" });
  assert.throws(() => v.composeSelection({ projectDir: dir, files: ["/etc/hosts"] }), { code: "invalid_input" });
  assert.throws(() => v.composeSelection({ projectDir: dir, files: ["missing.yaml"] }), { code: "not_found" });
  assert.throws(() => v.composeSelection({ projectDir: dir, projectName: "Bad Name" }), { code: "invalid_input" });
  assert.throws(() => v.composeSelection({}), { code: "invalid_input" });
  assert.equal(v.composeSelection({}, { defaultDir: dir }).projectDir, dir);
  assert.deepEqual(composeBaseArgs({ ...sel, profiles: ["dev"] }), [
    "compose", "--project-directory", dir, "--file", join(dir, "compose.yaml"), "--project-name", "demo", "--profile", "dev",
  ]);
});

test("composeRisks flags privileged services, sockets and exposed ports", () => {
  const summary = summarizeCompose({
    name: "demo",
    services: {
      app: {
        image: "x",
        privileged: true,
        ports: [{ target: 80, published: "8080", host_ip: "" }],
        volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
      },
    },
  });
  const messages = composeRisks(summary).map((r) => `${r.level}:${r.message}`);
  assert.ok(messages.some((m) => m.startsWith("high:runs privileged")));
  assert.ok(messages.some((m) => m.startsWith("high:mounts the Docker socket")));
  assert.ok(messages.some((m) => m.startsWith("medium:") && m.includes("8080")));
});

test("ApprovalStore lifecycle: claim once, deny, expiry", () => {
  let now = 1_000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => now });
  const a = store.create({ op: "remove_container", params: { container: "x" }, summary: "s", origin: "agent" });
  assert.equal(a.fingerprint, undefined);
  assert.equal(a.binding, undefined);
  assert.match(a.id, /^[a-f0-9]{24}$/);
  store.claim(a.id);
  assert.throws(() => store.claim(a.id), { code: "conflict" });

  const b = store.create({ op: "x", params: {}, summary: "s" });
  assert.equal(store.deny(b.id).status, "denied");

  const c = store.create({ op: "x", params: {}, summary: "s" });
  now += 101;
  assert.throws(() => store.claim(c.id), { code: "approval_expired" });
  assert.throws(() => store.get("ffffffffffffffffffffffff"), { code: "approval_not_found" });
});

test("ApprovalStore detects tampering with stored params", () => {
  const store = new ApprovalStore();
  const a = store.create({ op: "x", params: { container: "a" }, summary: "s" });
  store.records.get(a.id).params.container = "b";
  assert.throws(() => store.claim(a.id), { code: "approval_mismatch" });
});

test("classifyDockerFailure and isLocalEndpoint", () => {
  assert.equal(classifyDockerFailure("Cannot connect to the Docker daemon at unix:///x"), "daemon_unavailable");
  assert.equal(classifyDockerFailure("Error: No such container: x"), "not_found");
  assert.equal(classifyDockerFailure("weird"), "docker_failed");
  assert.ok(isLocalEndpoint("unix:///var/run/docker.sock"));
  assert.ok(isLocalEndpoint("npipe:////./pipe/docker_engine"));
  assert.ok(!isLocalEndpoint("tcp://10.0.0.1:2376"));
  assert.ok(!isLocalEndpoint("ssh://host"));
});
