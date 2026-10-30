// Runs the canvas UI outside Copilot for local development: node scripts/dev-server.mjs [projectDir]
import { DockerService } from "../src/docker-service.mjs";
import { CanvasServer } from "../src/server.mjs";

const service = new DockerService();
const server = new CanvasServer(service);
await server.start();
const url = server.registerInstance("dev", { defaultDir: process.argv[2] ?? process.cwd() });
process.stderr.write(`Docker canvas UI: ${url}\n`);
const stop = async () => {
  await server.stop();
  service.shutdown();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
