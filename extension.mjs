import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { buildCanvasDeclaration } from "./src/canvas.mjs";
import { DockerService } from "./src/docker-service.mjs";
import { log } from "./src/log.mjs";
import { CanvasServer } from "./src/server.mjs";

const service = new DockerService();
const server = new CanvasServer(service);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  service.shutdown();
  await server.stop().catch(() => undefined);
}
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.stdin.on("end", () => shutdown().finally(() => process.exit(0)));

await joinSession({
  canvases: [createCanvas(buildCanvasDeclaration({ service, server, CanvasError }))],
});
log("info", "Docker canvas extension ready");
