// Docker canvas panel. All data is rendered with textContent — never innerHTML — because
// container names, labels and logs are untrusted.

const $ = (sel) => document.querySelector(sel);
const state = {
  view: "containers",
  containers: [],
  images: [],
  stats: new Map(),
  approvals: new Map(),
  operations: new Map(),
  defaultDir: "",
  logSource: null,
  drawerTrigger: null,
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "title") el.title = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---- API ---------------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || `Request failed (${res.status})`);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

async function op(name, input = {}, { quiet = false } = {}) {
  try {
    const { result } = await api(`api/op/${name}`, input);
    if (result?.status === "pending_approval") {
      toast("Confirmation required — review it at the top of the panel.");
    } else if (!quiet) {
      toast("Done");
    }
    return result;
  } catch (error) {
    toast(error.message, true);
    throw error;
  }
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

// ---- views ---------------------------------------------------------------------------

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
  for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${view}`;
}

function stateBadge(stateName, status) {
  return h("span", { class: `state ${stateName}`, title: status }, stateName);
}

function renderContainers() {
  const showAll = $("#show-all").checked;
  const filter = $("#container-filter").value.trim().toLowerCase();
  const rows = state.containers
    .filter((c) => showAll || c.state === "running")
    .filter((c) => !filter || c.name.toLowerCase().includes(filter) || c.image.toLowerCase().includes(filter))
    .sort((a, b) => (a.composeProject ?? "").localeCompare(b.composeProject ?? "") || a.name.localeCompare(b.name));
  const body = $("#containers");
  body.replaceChildren(
    ...rows.map((c) => {
      const running = c.state === "running";
      const stats = state.stats.get(c.id) ?? state.stats.get(c.name);
      return h(
        "tr",
        {},
        h(
          "td",
          { class: "name-cell", "data-label": "Container" },
          h("div", { class: "name", title: c.name }, c.name),
          h("div", { class: "sub mono", title: c.image }, shortImage(c.image)),
          c.composeProject ? h("div", { class: "sub" }, `compose: ${c.composeProject} · ${c.composeService}`) : null,
        ),
        h("td", { "data-label": "State" }, stateBadge(c.state, c.status), h("div", { class: "sub" }, c.status)),
        h("td", { class: "mono ports", "data-label": "Ports" }, formatPorts(c.ports)),
        h("td", { class: "mono", "data-label": "CPU / Mem" }, running ? [h("div", {}, stats?.cpu ?? "…"), h("div", { class: "sub" }, stats?.memory?.split(" / ")[0] ?? "")] : ""),
        h(
          "td",
          { class: "actions", "data-label": "Actions" },
          h(
            "div",
            { class: "btns" },
          running
            ? [
                h("button", { class: "small", onclick: () => op("stop_container", { container: c.name }, { quiet: true }) }, "Stop"),
                h("button", { class: "small", onclick: () => op("restart_container", { container: c.name }, { quiet: true }) }, "Restart"),
              ]
            : h("button", { class: "small", onclick: () => op("start_container", { container: c.name }, { quiet: true }) }, "Start"),
          h("button", { class: "small", "aria-controls": "drawer", "aria-expanded": "false", onclick: (event) => openLogs(c, event.currentTarget) }, "Logs"),
          h("button", { class: "small", "aria-controls": "drawer", "aria-expanded": "false", onclick: (event) => openInspect(c, event.currentTarget) }, "Inspect"),
          h("button", { class: "small danger", onclick: () => op("remove_container", { container: c.name, force: running }) }, "Remove"),
          ),
        ),
      );
    }),
  );
  $("#containers-empty").hidden = rows.length > 0;
}

function shortImage(image) {
  return /^sha256:[a-f0-9]{64}$/.test(image) ? image.slice(0, 19) : image;
}

function formatPorts(ports) {
  if (!ports) return "";
  const unique = [...new Set(ports.split(", ").map((p) => p.replace(/^(0\.0\.0\.0|\[::\]|::):/, "*:")))];
  return unique.join("\n");
}

function renderImages() {
  const filter = $("#image-filter").value.trim().toLowerCase();
  const rows = state.images.filter((i) => !filter || i.reference.toLowerCase().includes(filter));
  $("#images").replaceChildren(
    ...rows.map((img) =>
      h(
        "tr",
        {},
        h("td", { class: "name-cell", "data-label": "Image" }, h("div", { class: "name mono", title: img.reference }, img.repository === "<none>" ? "<none>" : `${img.repository}:${img.tag}`), h("div", { class: "sub" }, img.createdSince)),
        h("td", { class: "mono", "data-label": "ID" }, String(img.id).replace(/^sha256:/, "").slice(0, 12)),
        h("td", { "data-label": "Size" }, img.size),
        h(
          "td",
          { class: "actions", "data-label": "Actions" },
          h(
            "button",
            {
              class: "small",
              onclick: () => {
                setView("containers");
                $("#run-form").hidden = false;
                $("#run-form").image.value = img.reference;
                $("#run-form").name.focus();
              },
            },
            "Run…",
          ),
        ),
      ),
    ),
  );
  $("#images-empty").hidden = rows.length > 0;
}

function riskList(risks) {
  if (!risks?.length) return null;
  return h("ul", { class: "risk-list" }, risks.map((r) => h("li", { class: r.level }, `${r.service ? `${r.service}: ` : ""}${r.message}`)));
}

function renderApprovals() {
  const pending = [...state.approvals.values()].filter((a) => a.status === "pending").sort((a, b) => a.createdAt - b.createdAt);
  $("#approvals").replaceChildren(
    ...pending.map((a) =>
      h(
        "div",
        { class: "approval" },
        h("div", {}, h("strong", {}, "Confirm: "), a.summary),
        riskList(a.risks),
        h("div", { class: "meta" }, `Requested by ${a.origin === "agent" ? "Copilot" : "you"} · expires ${new Date(a.expiresAt).toLocaleTimeString()}`),
        h(
          "div",
          { class: "row" },
          h("span", { class: "spacer" }),
          h("button", { onclick: (e) => decide(a.id, "deny", e.target) }, "Deny"),
          h("button", { class: "primary", onclick: (e) => decide(a.id, "approve", e.target) }, "Approve"),
        ),
      ),
    ),
  );
  const badge = $("#approval-badge");
  badge.hidden = pending.length === 0;
  badge.textContent = String(pending.length);

  const history = [...state.approvals.values()].filter((a) => a.status !== "pending").sort((a, b) => b.createdAt - a.createdAt);
  $("#approval-history").replaceChildren(
    ...(history.length
      ? history.map((a) =>
          h(
            "div",
            { class: "op" },
            h(
              "div",
              { class: "row history" },
              h("span", { class: `status-${a.status}` }, a.status),
              h("span", {}, a.summary),
              a.error ? h("span", { class: "status-failed" }, `— ${a.error.message}`) : null,
            ),
          ),
        )
      : [h("p", { class: "empty" }, "No decisions yet.")]),
  );
}

async function decide(id, decision, button) {
  button.disabled = true;
  try {
    const { approval } = await api(`api/approvals/${id}/${decision}`, {});
    state.approvals.set(approval.id, approval);
    renderApprovals();
    toast(decision === "approve" ? "Approved — running…" : "Denied");
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

function renderOperations() {
  const ops = [...state.operations.values()].sort((a, b) => b.startedAt - a.startedAt);
  $("#operations").replaceChildren(
    ...(ops.length
      ? ops.map((o) =>
          h(
            "details",
            { class: "op", open: o.status === "running" || o.status === "failed" },
            h(
              "summary",
              {},
              h("span", { class: `status-${o.status}` }, o.status),
              h("span", {}, o.title),
              h("span", { class: "muted" }, new Date(o.startedAt).toLocaleTimeString()),
            ),
            h("pre", {}, [...o.output, o.error ? `ERROR: ${o.error.message}` : ""].filter(Boolean).join("\n") || "(no output)"),
          ),
        )
      : [h("p", { class: "empty" }, "No operations yet.")]),
  );
}

// ---- drawer: logs & inspect -----------------------------------------------------------

function openDrawer(title, trigger) {
  state.drawerTrigger?.setAttribute("aria-expanded", "false");
  closeLogStream();
  state.drawerTrigger = trigger ?? document.activeElement;
  state.drawerTrigger?.setAttribute("aria-expanded", "true");
  $("#drawer-title").textContent = title;
  $("#drawer-body").replaceChildren();
  $("#drawer").hidden = false;
  $("#drawer").focus();
}

function closeLogStream() {
  state.logSource?.close();
  state.logSource = null;
}

function closeDrawer() {
  closeLogStream();
  $("#drawer").hidden = true;
  if (state.drawerTrigger?.isConnected) state.drawerTrigger.focus();
  state.drawerTrigger?.setAttribute("aria-expanded", "false");
  state.drawerTrigger = null;
}

function openLogs(container, trigger) {
  openDrawer(`Logs — ${container.name}`, trigger);
  $("#follow-wrap").hidden = false;
  const pre = $("#drawer-body");
  const source = new EventSource(`api/logs?container=${encodeURIComponent(container.name)}&tail=300`);
  state.logSource = source;
  let count = 0;
  source.addEventListener("log", (event) => {
    const { stream, line } = JSON.parse(event.data);
    pre.append(h("span", { class: stream }, `${line}\n`));
    if (++count > 3000) pre.firstChild?.remove();
    if ($("#drawer-follow").checked) pre.scrollTop = pre.scrollHeight;
  });
  source.addEventListener("end", () => {
    pre.append(h("span", { class: "muted" }, "— log stream ended —\n"));
    closeLogStream();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) closeLogStream();
  };
}

async function openInspect(container, trigger) {
  openDrawer(`Inspect — ${container.name}`, trigger);
  $("#follow-wrap").hidden = true;
  try {
    const result = await op("inspect_container", { container: container.name }, { quiet: true });
    $("#drawer-body").textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $("#drawer-body").textContent = error.message;
  }
}

// ---- forms ---------------------------------------------------------------------------

function parsePorts(text, hostIp) {
  return text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((part) => {
      const m = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(part);
      if (!m) throw new Error(`Invalid port mapping "${part}" — use host:container[/tcp|udp]`);
      return { hostIp, hostPort: m[1] ? Number(m[1]) : undefined, containerPort: Number(m[2]), protocol: m[3] ?? "tcp" };
    });
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid environment line "${line}" — use KEY=value`);
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function parseMounts(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      const readOnly = parts.at(-1) === "ro";
      if (readOnly) parts.pop();
      if (parts.length !== 2) throw new Error(`Invalid mount "${line}" — use /host/path:/container/path[:ro]`);
      return { source: parts[0], target: parts[1], readOnly };
    });
}

function splitCommand(text) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}

function wireForms() {
  const runForm = $("#run-form");
  $("#toggle-run").addEventListener("click", () => {
    runForm.hidden = !runForm.hidden;
    if (!runForm.hidden) runForm.image.focus();
  });
  runForm.querySelector("[data-close]").addEventListener("click", () => (runForm.hidden = true));
  runForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    let spec;
    try {
      spec = {
        image: runForm.image.value.trim(),
        ...(runForm.name.value.trim() ? { name: runForm.name.value.trim() } : {}),
        ports: parsePorts(runForm.ports.value, runForm.exposeAll.checked ? "0.0.0.0" : "127.0.0.1"),
        env: parseEnv(runForm.env.value),
        mounts: parseMounts(runForm.mounts.value),
        command: splitCommand(runForm.command.value),
        autoRemove: runForm.autoRemove.checked,
      };
    } catch (error) {
      return toast(error.message, true);
    }
    const result = await op("run_container", spec, { quiet: true }).catch(() => null);
    if (result) {
      runForm.reset();
      runForm.hidden = true;
      if (result.status !== "pending_approval") toast(`Started ${result.id?.slice(0, 12)}`);
    }
  });

  $("#pull-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.target.image;
    const image = input.value.trim();
    toast(`Pulling ${image}… (see Activity)`);
    const result = await op("pull_image", { image }, { quiet: true }).catch(() => null);
    if (result) {
      toast(`Pulled ${image}`);
      input.value = "";
    }
  });

  const composeForm = $("#compose-form");
  composeForm.projectDir.value = state.defaultDir;
  for (const button of composeForm.querySelectorAll("[data-compose]")) {
    button.addEventListener("click", async () => {
      if (!composeForm.reportValidity()) return;
      const name = button.dataset.compose;
      const selection = {
        projectDir: composeForm.projectDir.value.trim(),
        files: composeForm.files.value.split(",").map((f) => f.trim()).filter(Boolean),
        ...(composeForm.projectName.value.trim() ? { projectName: composeForm.projectName.value.trim() } : {}),
      };
      const extra =
        name === "compose_up"
          ? { build: composeForm.build.checked, wait: composeForm.wait.checked }
          : name === "compose_down"
            ? { removeVolumes: composeForm.removeVolumes.checked }
            : {};
      button.disabled = true;
      try {
        const result = await op(name, { ...selection, ...extra }, { quiet: true });
        renderComposeResult(name, result);
      } catch {
        // op() already reported the error.
      } finally {
        button.disabled = false;
      }
    });
  }
}

function renderComposeResult(name, result) {
  const out = $("#compose-output");
  if (result?.status === "pending_approval") {
    out.replaceChildren(h("p", { class: "muted" }, "Waiting for your confirmation above."));
    return;
  }
  if (name === "compose_config") {
    out.replaceChildren(
      h(
        "div",
        { class: "card" },
        h("h3", {}, `Project "${result.projectName}"`),
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Service"), h("th", {}, "Image"), h("th", {}, "Ports"))),
          h(
            "tbody",
            {},
            result.services.map((s) =>
              h(
                "tr",
                {},
                h("td", {}, s.name),
                h("td", { class: "mono" }, s.image ?? (s.build ? "(build)" : "")),
                h("td", { class: "mono" }, s.ports.map((p) => p.raw ?? `${p.hostIp}:${p.published ?? "?"}→${p.target}`).join(", ")),
              ),
            ),
          ),
        ),
        h("h3", {}, "Review"),
        riskList(result.risks) ?? h("p", { class: "muted" }, "Nothing notable."),
      ),
    );
  } else if (name === "compose_ps") {
    out.replaceChildren(
      result.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "Service"), h("th", {}, "Container"), h("th", {}, "State"), h("th", {}, "Ports"))),
            h(
              "tbody",
              {},
              result.map((c) =>
                h(
                  "tr",
                  {},
                  h("td", {}, c.service),
                  h("td", { class: "mono" }, c.name),
                  h("td", {}, stateBadge(c.state, c.status), c.health ? h("div", { class: "sub" }, c.health) : null),
                  h("td", { class: "mono" }, c.publishers.join("\n")),
                ),
              ),
            ),
          )
        : h("p", { class: "empty" }, "No containers for this project."),
    );
  }
}

// ---- live events ---------------------------------------------------------------------

function connectEvents() {
  const source = new EventSource("api/events");
  const on = (name, fn) => source.addEventListener(name, (event) => fn(JSON.parse(event.data)));
  on("status", (status) => {
    const target = $("#target");
    target.textContent = `${status.target.context ?? status.target.endpoint}${status.server ? ` · Engine ${status.server}` : ""}`;
    target.title = status.target.endpoint;
    target.className = `pill ${status.daemonReachable ? "ok" : "err"}`;
    $("#banner").hidden = status.daemonReachable;
    if (!status.daemonReachable) $("#banner").textContent = "Docker daemon is not reachable. Start Docker Desktop and the panel will reconnect.";
  });
  on("containers", (list) => {
    state.containers = list;
    $("#banner").hidden = true;
    renderContainers();
  });
  on("images", (list) => {
    state.images = list;
    renderImages();
  });
  on("stats", (list) => {
    state.stats = new Map(list.flatMap((s) => [[s.id, s], [s.name, s]]));
    if (state.view === "containers") renderContainers();
  });
  on("approval", (approval) => {
    state.approvals.set(approval.id, approval);
    renderApprovals();
    if (approval.status === "failed") toast(`Failed: ${approval.error?.message ?? approval.summary}`, true);
  });
  on("operation", (operation) => {
    state.operations.set(operation.id, operation);
    renderOperations();
  });
  on("daemon-error", (error) => {
    const banner = $("#banner");
    banner.textContent = error.message;
    banner.hidden = false;
    $("#target").className = "pill err";
  });
}

async function main() {
  for (const tab of document.querySelectorAll(".tabs button")) tab.addEventListener("click", () => setView(tab.dataset.view));
  $("#show-all").addEventListener("change", renderContainers);
  $("#container-filter").addEventListener("input", renderContainers);
  $("#image-filter").addEventListener("input", renderImages);
  $("#drawer-close").addEventListener("click", closeDrawer);

  try {
    const boot = await api("api/bootstrap");
    state.defaultDir = boot.instance.defaultDir ?? "";
    for (const a of boot.approvals) state.approvals.set(a.id, a);
    for (const o of boot.operations) state.operations.set(o.id, o);
    setView(boot.instance.view || "containers");
  } catch (error) {
    $("#banner").textContent = error.message;
    $("#banner").hidden = false;
    setView("containers");
  }
  wireForms();
  renderApprovals();
  renderOperations();
  connectEvents();
}

main();
