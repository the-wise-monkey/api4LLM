const state = {
  summary: null,
  auth: null,
  providerModels: null,
  lastModelSyncAt: 0,
  eventSource: null,
  resolutionBlocked: false,
  autoScroll: true,
  currentContainer: "api4llm",
  maxLogLines: 1200,
  logLineCount: 0,
};

const MIN_VIEWPORT_WIDTH = 1366;
const MIN_VIEWPORT_HEIGHT = 768;

const el = {
  lastUpdated: document.getElementById("lastUpdated"),
  serviceName: document.getElementById("serviceName"),
  serviceState: document.getElementById("serviceState"),
  containerName: document.getElementById("containerName"),
  containerStatus: document.getElementById("containerStatus"),
  imageName: document.getElementById("imageName"),
  runningFor: document.getElementById("runningFor"),
  dockerHealth: document.getElementById("dockerHealth"),
  composeFilePath: document.getElementById("composeFilePath"),
  mechanismCards: document.getElementById("mechanismCards"),
  providerCards: document.getElementById("providerCards"),
  oauthRows: document.getElementById("oauthRows"),
  authMeta: document.getElementById("authMeta"),
  providerMeta: document.getElementById("providerMeta"),
  modelMeta: document.getElementById("modelMeta"),
  modelCards: document.getElementById("modelCards"),
  logsOutput: document.getElementById("logsOutput"),
  logsState: document.getElementById("logsState"),
  autoScroll: document.getElementById("autoScroll"),
  clearLogs: document.getElementById("clearLogs"),
  refreshNow: document.getElementById("refreshNow"),
  resolutionGate: document.getElementById("resolutionGate"),
  resolutionCurrent: document.getElementById("resolutionCurrent"),
};

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function formatCount(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function formatAuthMode(mode) {
  switch (mode) {
    case "oauth":
      return "OAuth";
    case "api-keys":
      return "API keys";
    case "mixed":
      return "Mixed";
    default:
      return "None";
  }
}

function normalizeStatusLabel(value) {
  const raw = String(value || "unknown").trim();
  if (!raw) {
    return "unknown";
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function truncateText(value, max = 72) {
  const text = String(value || "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function chipClassForState(stateValue) {
  const normalized = String(stateValue || "").toLowerCase();
  if (normalized === "running") {
    return "chip ok";
  }
  if (normalized.includes("exited") || normalized === "dead" || normalized === "error") {
    return "chip bad";
  }
  return "chip";
}

function chipClassForHealth(statusValue) {
  const normalized = String(statusValue || "").toLowerCase();
  if (normalized === "fresh") {
    return "chip ok";
  }
  if (normalized === "configured") {
    return "chip configured";
  }
  if (normalized === "warning") {
    return "chip warn";
  }
  if (normalized === "stale") {
    return "chip stale";
  }
  if (normalized === "expired" || normalized === "error") {
    return "chip bad";
  }
  if (normalized === "unknown") {
    return "chip unknown";
  }
  return "chip";
}

function escapeHTML(raw) {
  return String(raw || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function gateMessage() {
  return `Paused: minimum viewport is ${MIN_VIEWPORT_WIDTH}x${MIN_VIEWPORT_HEIGHT}`;
}

function applyResolutionGate() {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const blocked = width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT;

  if (el.resolutionCurrent) {
    el.resolutionCurrent.textContent = `Current viewport: ${width}x${height}`;
  }

  if (blocked === state.resolutionBlocked) {
    return false;
  }

  state.resolutionBlocked = blocked;
  document.body.classList.toggle("resolution-blocked", blocked);
  if (el.resolutionGate) {
    el.resolutionGate.hidden = !blocked;
  }

  if (blocked) {
    disconnectLogs();
    el.logsState.textContent = gateMessage();
  }
  return true;
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error || data.details || response.statusText;
    throw new Error(message);
  }
  return data;
}

function findPrimaryService(summary) {
  return summary.services?.find((item) => item.service === summary.defaultService) || summary.services?.[0] || null;
}

function updateSummary(summary) {
  state.summary = summary;
  const primary = findPrimaryService(summary);

  el.lastUpdated.textContent = `Last refresh: ${formatDate(summary.generatedAt)}`;
  el.serviceName.textContent = primary?.service || summary.defaultService || "-";
  el.serviceState.textContent = primary?.state || summary.overallState || "unknown";
  el.serviceState.className = chipClassForState(primary?.state || summary.overallState);

  el.containerName.textContent = primary?.container || summary.defaultContainer || "-";
  el.containerStatus.textContent = primary?.status || summary.commandError || "-";
  el.imageName.textContent = primary?.image || "-";
  el.runningFor.textContent = primary?.runningFor || "-";

  const backend = summary.backend ? ` (${summary.backend})` : "";
  el.dockerHealth.textContent = `${summary.dockerAvailable ? "Available" : "Unavailable"}${backend}`;
  el.dockerHealth.className = summary.dockerAvailable ? "chip ok" : "chip bad";
  el.composeFilePath.textContent = summary.composeFile || "-";

  return primary?.container || summary.defaultContainer || state.currentContainer;
}

function renderMechanisms(auth) {
  const cards = auth.mechanisms || [];
  if (cards.length === 0) {
    el.mechanismCards.innerHTML = `<p class="muted">No auth mechanisms found.</p>`;
    return;
  }

  const rows = cards
    .map((item) => {
      const configuredLabel = item.configured ? "Configured" : "Missing";
      const chipClass = item.configured ? "chip ok" : "chip bad";
      return `
        <tr>
          <td>${escapeHTML(item.label)}</td>
          <td><span class="${chipClass}">${configuredLabel}</span></td>
          <td>${formatCount(item.count)}</td>
          <td class="cell-muted">${escapeHTML(item.source || "-")}</td>
        </tr>
      `;
    })
    .join("");

  el.mechanismCards.innerHTML = `
    <div class="table-wrap">
      <table class="dense-table">
        <thead>
          <tr>
            <th>Mechanism</th>
            <th>Status</th>
            <th>Count</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderProviderCards(auth) {
  const providers = auth.providerHealth || [];
  if (providers.length === 0) {
    el.providerCards.innerHTML = `<p class="muted">No provider health data available.</p>`;
    return;
  }

  const rows = providers
    .map((provider) => {
      const statusClass = chipClassForHealth(provider.status);
      return `
        <tr>
          <td>${escapeHTML(provider.label)}</td>
          <td><span class="${statusClass}">${escapeHTML(normalizeStatusLabel(provider.status))}</span></td>
          <td>${escapeHTML(formatAuthMode(provider.authMode))}</td>
          <td>${formatCount(provider.oauthCount)}</td>
          <td>${formatCount(provider.staticKeyCount)}</td>
          <td>${formatCount(provider.expiringSoonCount)}</td>
          <td>${formatCount(provider.expiredCount)}</td>
          <td class="cell-muted" title="${escapeHTML(provider.statusMessage || "-")}">${escapeHTML(truncateText(provider.statusMessage || "-", 96))}</td>
        </tr>
      `;
    })
    .join("");

  el.providerCards.innerHTML = `
    <div class="table-wrap">
      <table class="dense-table provider-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>Mode</th>
            <th>OAuth</th>
            <th>Static</th>
            <th>Expiring &lt;24h</th>
            <th>Expired</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderOAuthRows(auth) {
  const files = auth.oauthFiles || [];
  if (files.length === 0) {
    el.oauthRows.innerHTML = `<tr><td colspan="5" class="muted">No OAuth files in ${escapeHTML(auth.dataDir || "data/")}.</td></tr>`;
    return;
  }

  el.oauthRows.innerHTML = files
    .map((file) => {
      const expiresLabel = file.expiresAt ? formatDate(file.expiresAt) : "-";
      const email = file.email || "(not set)";
      const provider = file.provider || "unknown";
      const parseSuffix = file.parseError ? ` (parse error: ${file.parseError})` : "";
      return `
        <tr>
          <td>${escapeHTML(provider)}</td>
          <td>${escapeHTML(email)}</td>
          <td>${escapeHTML(file.file)}${escapeHTML(parseSuffix)}</td>
          <td>${escapeHTML(expiresLabel)}</td>
          <td>${escapeHTML(formatDate(file.modifiedAt))}</td>
        </tr>
      `;
    })
    .join("");
}

function updateAuth(auth) {
  state.auth = auth;
  const providers = Object.entries(auth.oauthSummary || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(" | ");
  const cfgStatus = auth.configReadable ? "config loaded" : "config unreadable";
  const configuredCount = (auth.mechanisms || []).filter((item) => item.configured).length;
  el.authMeta.textContent = `${cfgStatus} | ${configuredCount}/${formatCount((auth.mechanisms || []).length)} configured${providers ? ` | OAuth: ${providers}` : ""}`;

  const unhealthyCount = (auth.providerHealth || []).filter((item) => ["error", "expired", "stale", "warning"].includes(item.status)).length;
  el.providerMeta.textContent = `${formatCount((auth.providerHealth || []).length)} providers | ${formatCount(unhealthyCount)} attention needed`;

  renderMechanisms(auth);
  renderProviderCards(auth);
  renderOAuthRows(auth);
}

function renderProviderModelCards(payload) {
  const groups = payload?.providerModels || [];
  if (groups.length === 0) {
    el.modelCards.innerHTML = `<p class="muted">No runtime models discovered.</p>`;
    return;
  }

  const rows = groups
    .map((group) => {
      const models = group.models || [];
      const preview = models.map((model) => model.id).join(", ");
      const sources = [...new Set(models.flatMap((model) => model.sources || []))].join(", ");

      return `
        <tr>
          <td>${escapeHTML(group.label || group.provider || "unknown")}</td>
          <td>${formatCount(group.count)}</td>
          <td class="cell-wrap" title="${escapeHTML(preview || "-")}">${escapeHTML(preview || "-")}</td>
          <td class="cell-muted">${escapeHTML(sources || "-")}</td>
        </tr>
      `;
    })
    .join("");

  el.modelCards.innerHTML = `
    <div class="table-wrap">
      <table class="dense-table model-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model Count</th>
            <th>Model IDs (sample)</th>
            <th>Source API</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function updateProviderModels(payload) {
  state.providerModels = payload;
  state.lastModelSyncAt = Date.now();

  const endpointStatus = payload?.endpointStatus || {};
  const statusText = Object.entries(endpointStatus)
    .map(([endpoint, status]) => {
      if (status?.ok) {
        return `${endpoint}: ok (${formatCount(status.count)})`;
      }
      if (status?.status) {
        const err = status.error ? ` ${status.error}` : "";
        return `${endpoint}: ${status.status}${err}`;
      }
      return `${endpoint}: unavailable`;
    })
    .join(" | ");

  const authHint = payload?.authorization?.provided ? "auth header set" : "no auth header";
  el.modelMeta.textContent = `${formatCount(payload?.totalModels)} models | ${statusText || "no endpoint data"} | ${authHint}`;
  renderProviderModelCards(payload);
}

function trimLogs() {
  const lines = el.logsOutput.textContent.split("\n");
  if (lines.length <= state.maxLogLines) {
    return;
  }
  const trimmed = lines.slice(lines.length - state.maxLogLines).join("\n");
  el.logsOutput.textContent = trimmed;
  state.logLineCount = state.maxLogLines;
}

function appendLogLine(text, kind = "log") {
  const span = document.createElement("span");
  if (kind === "error") {
    span.className = "log-error";
  }
  if (kind === "status") {
    span.className = "log-status";
  }
  span.textContent = `${text}\n`;
  el.logsOutput.append(span);
  state.logLineCount += 1;

  if (state.logLineCount > state.maxLogLines + 80) {
    trimLogs();
  }

  if (state.autoScroll) {
    el.logsOutput.scrollTop = el.logsOutput.scrollHeight;
  }
}

function disconnectLogs() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function connectLogs() {
  if (state.resolutionBlocked) {
    return;
  }
  disconnectLogs();
  const targetContainer = state.currentContainer || "api4llm";
  const target = encodeURIComponent(targetContainer);
  const source = new EventSource(`/api/logs/stream?container=${target}`);
  state.eventSource = source;
  el.logsState.textContent = `Streaming ${targetContainer}...`;

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      appendLogLine(payload.line, payload.kind);
    } catch {
      appendLogLine(event.data, "log");
    }
  };

  source.onerror = () => {
    el.logsState.textContent = "Disconnected. Reconnecting...";
    disconnectLogs();
    window.setTimeout(connectLogs, 1800);
  };
}

async function refreshData(forceModelRefresh = false) {
  if (state.resolutionBlocked) {
    return;
  }
  try {
    const [summary, auth] = await Promise.all([fetchJSON("/api/summary"), fetchJSON("/api/auth-mechanisms")]);
    const previousContainer = state.currentContainer;
    const nextContainer = updateSummary(summary);
    updateAuth(auth);

    if (nextContainer) {
      state.currentContainer = nextContainer;
    }

    if (!state.eventSource || (nextContainer && nextContainer !== previousContainer)) {
      connectLogs();
    }

    const needsModelsRefresh =
      forceModelRefresh || !state.providerModels || Date.now() - state.lastModelSyncAt >= 60 * 1000;

    if (needsModelsRefresh) {
      try {
        const providerModels = await fetchJSON("/api/provider-models");
        updateProviderModels(providerModels);
      } catch (modelError) {
        el.modelMeta.textContent = `Model sync failed: ${modelError.message}`;
        if (!state.providerModels) {
          el.modelCards.innerHTML = `<p class="muted">Unable to load models right now.</p>`;
        }
      }
    }
  } catch (error) {
    el.lastUpdated.textContent = `Refresh failed: ${error.message}`;
  }
}

async function runAction(action) {
  if (state.resolutionBlocked) {
    return;
  }
  try {
    const result = await fetchJSON(`/api/container/${action}`, { method: "POST" });
    const details = result.stdout || result.stderr || "ok";
    appendLogLine(`[action:${action}] (${result.backend || "auto"}) ${details}`, "status");
    await refreshData();
  } catch (error) {
    appendLogLine(`[action:${action}] ${error.message}`, "error");
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => runAction(button.getAttribute("data-action")));
});

el.autoScroll.addEventListener("change", () => {
  state.autoScroll = el.autoScroll.checked;
});

el.clearLogs.addEventListener("click", () => {
  el.logsOutput.textContent = "";
  state.logLineCount = 0;
});

el.refreshNow.addEventListener("click", () => {
  refreshData(true);
});

window.addEventListener("resize", () => {
  const changed = applyResolutionGate();
  if (!state.resolutionBlocked && changed) {
    refreshData(true);
  }
});

window.addEventListener("orientationchange", () => {
  const changed = applyResolutionGate();
  if (!state.resolutionBlocked && changed) {
    refreshData(true);
  }
});

window.addEventListener("beforeunload", () => {
  disconnectLogs();
});

applyResolutionGate();
if (!state.resolutionBlocked) {
  refreshData(true);
}
window.setInterval(() => refreshData(false), 8000);
