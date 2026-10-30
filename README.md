# Docker canvas for GitHub Copilot

A GitHub Copilot app canvas extension for managing **local** Docker containers without leaving Copilot. The panel and the agent share one Docker service, and anything risky waits for confirmation in the panel.

- **Containers:** list, filter, start, stop, restart, remove, live logs, inspect, CPU and memory.
- **Images:** list and pull. Run a container with ports, env, bind mounts, a command, and auto-remove.
- **Compose:** inspect the config, check status, `up` (optional `--build`; waits for healthy by default) and `down` (optional `-v`).
- **Activity:** recent operations and approval history.

It has no npm dependencies. The extension wraps the `docker` CLI, and the UI is plain HTML/CSS/JS.

## Install

Requirements: a GitHub Copilot app version with canvas extension support, Node 20 or later (provided by the host), and Docker Desktop or another local Docker engine with the `docker` CLI.

```bash
scripts/install-dev.sh        # symlinks this repo into ~/.copilot/extensions/docker-canvas
```

Start a new Copilot session, or restart the app, so the extension is loaded. Then ask Copilot to open the **Docker** canvas (canvas id `docker`).

## Agent actions

| Action | Notes |
|---|---|
| `status`, `list_containers`, `list_images`, `inspect_container`, `get_logs`, `get_stats` | Read-only. `inspect_container` hides env values. |
| `start_container`, `stop_container`, `restart_container`, `pull_image` | Run immediately. |
| `run_container` | Runs immediately unless ports, mounts, or volumes are set; then it needs approval. |
| `remove_container`, `compose_up`, `compose_down` | Always need approval. |
| `compose_config`, `compose_ps` | Read-only. |
| `get_approval` | Poll the outcome of a pending approval. |

When approval is needed, the action returns `pending_approval` with an `approvalId`. The user clicks **Approve** or **Deny** in the panel. The agent cannot approve anything.

## Security model

- **Local only.** The Docker context is pinned on every call (`--context`). If the endpoint is not a local socket or named pipe (for example `tcp://`, `ssh://`, or a remote `DOCKER_HOST`), operations are refused. Mutating operations re-check the target, and approvals are tied to the endpoint they were created for.
- **Panel server.** It binds to `127.0.0.1` on a random port, under an unguessable token path. Requests are checked for Host and Origin, writes must be JSON, and bodies are size-limited. A strict CSP is set (no inline script or style). The token is revoked when the panel closes.
- **Approvals.** Approvals are single-use, expire after 10 minutes, and are protected against tampering. A Compose approval is invalidated if the resolved config changes before approval.
- **Safer defaults.** Ports bind to `127.0.0.1` unless you choose "all interfaces". Sensitive host paths (`/`, `/etc`, `/proc`, the Docker socket, your home root, and credential directories such as `~/.ssh`, `~/.docker`, `~/.aws`, `~/.kube`) cannot be mounted. Compose review flags privileged services, socket mounts, host networking, and exposed ports. Image/container refs are validated and positional args come after `--`.
- **Labels.** Containers started from the panel get the label `com.github.copilot.docker-canvas=true`.

## Development

```bash
node scripts/dev-server.mjs [projectDir]   # runs the UI standalone; prints the URL to stderr
node --test test/                          # unit + fake-docker tests
DOCKER_IT=1 node --test test/integration.test.mjs   # real Docker (pulls alpine:3.20)
```

The extension's stdout carries JSON-RPC, so all logging goes to stderr. The server caches UI files, so restart the dev server after editing `ui/`.

## Known limitations

- `--env` values appear in the `docker run` process arguments on the host.
- The agent can see the `open` result URL, which contains the panel token (loopback only).
- Pulling an image does not need approval.
- No build-only, exec/shell, volume, or network management yet.
- If the `docker` binary is not found on the app's PATH, the extension also looks in `/usr/local/bin`, `/opt/homebrew/bin`, and the Docker.app bundle.
