# Repository instructions

## Build, test, and lint

This repository has no package manifest or npm dependencies. It uses Node.js built-ins and `.mjs` ES modules; there is no build or configured lint command.

- Run unit and fake-Docker tests: `node --test test/`
- Run one test file: `node --test test/unit.test.mjs` (or `test/service.test.mjs` / `test/server.test.mjs`)
- Run selected tests: `node --test --test-name-pattern="pattern" test/unit.test.mjs`
- Run real-Docker integration tests: `DOCKER_IT=1 node --test test/integration.test.mjs`. This requires a local Docker daemon and pulls `alpine:3.20`.
- Run the standalone UI during development: `node scripts/dev-server.mjs [projectDir]`. Restart it after editing `ui/`, since static assets are cached.

## Architecture

`extension.mjs` is the Copilot SDK entry point. It creates one `DockerService` and one `CanvasServer`, then registers the `docker` canvas declaration built in `src/canvas.mjs`. Canvas agent actions and panel requests both route through the same service and operation table in `src/docker-service.mjs`.

The service validates and prepares each operation before execution. Risky operations are recorded in `src/approvals.mjs` and can only be approved from the panel; approved operations re-check their Docker target, and Compose approvals are bound to a hash of the resolved configuration. `src/cli.mjs` runs Docker using argument arrays with `shell: false`; `src/target.mjs` pins the selected local context or endpoint. `src/validate.mjs` owns input and path constraints, while `src/compose.mjs` resolves Compose configuration into a secret-free summary.

`src/server.mjs` serves the plain HTML/CSS/JavaScript panel from `ui/` and streams updates to it. Each panel uses a random token in its loopback URL; closing it revokes that token and its streams. `src/operations.mjs` tracks long-running command progress, and the service broadcasts refreshes and state changes to connected panels.

## Repository-specific conventions

- Keep Docker execution in the shared service operation pipeline so UI and agent callers receive the same validation, approval, target checks, error mapping, and refresh behavior.
- Build Docker commands as argument arrays, never shell strings. Keep user-supplied positional references after `--`; preserve local-target validation and revalidation for mutations.
- Do not expose container environment values or full resolved Compose configuration. Keep Compose review summaries secret-free and bind approvals to the resolved configuration.
- Keep risky changes behind panel approval; the agent may request approval and poll its result, but cannot approve it.
- The test suite uses Node's built-in `node:test` and `node:assert/strict`. Unit and service tests use `test/fixtures/fake-docker.mjs`, selected through `DOCKER_CANVAS_DOCKER_BIN`; real-Docker tests are opt-in.
- The extension's stdout is reserved for JSON-RPC. Send extension logging to stderr through `src/log.mjs`.
