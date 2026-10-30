#!/usr/bin/env node
// Minimal stand-in for the docker CLI used by unit tests. Appends each argv to FAKE_DOCKER_LOG
// and answers a handful of commands. FAKE_DOCKER_ENDPOINT controls the context endpoint and
// FAKE_COMPOSE_CONFIG (JSON) controls `compose config` output.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);

const args = [...argv];
while (args[0] === "--context" || args[0] === "-H") args.splice(0, 2);
const cmd = args.slice(0, 2).join(" ");
const out = (text) => process.stdout.write(text);

if (cmd === "context show") out(`${process.env.FAKE_DOCKER_CONTEXT ?? "fake-ctx"}\n`);
else if (cmd.startsWith("context inspect")) out(`${JSON.stringify(process.env.FAKE_DOCKER_ENDPOINT ?? "unix:///tmp/fake.sock")}\n`);
else if (cmd === "version --format") out(JSON.stringify({ Client: { Version: "1.0" }, Server: { Version: "2.0" } }));
else if (cmd === "container ls") {
  out(`${JSON.stringify({ ID: "abc123", Names: "web", Image: "nginx", State: "running", Status: "Up", Ports: "", Labels: "com.docker.compose.project=demo,com.docker.compose.service=web" })}\n`);
} else if (cmd === "container inspect") {
  out(JSON.stringify([{ Id: "abc123", Name: "/web", Config: { Image: "nginx", Env: ["SECRET=hunter2", "PATH=/bin"] }, State: { Status: "running" } }]));
} else if (cmd === "container rm" || cmd === "container stop" || cmd === "container start" || cmd === "container restart") out("ok\n");
else if (args[0] === "compose" && args.includes("config")) out(process.env.FAKE_COMPOSE_CONFIG ?? JSON.stringify({ name: "demo", services: { web: { image: "nginx" } } }));
else if (args[0] === "compose") out("done\n");
else if (args[0] === "run") out("deadbeefcafe\n");
else if (cmd === "image pull") out("pulled\n");
else if (args[0] === "fail") {
  process.stderr.write("Error response from daemon: No such container: nope\n");
  process.exit(1);
} else {
  process.stderr.write(`fake-docker: unsupported ${argv.join(" ")}\n`);
  process.exit(2);
}
