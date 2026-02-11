#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.DIAG_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.DIAG_PORT || "9321", 10);
const COMPOSE_FILE = process.env.DIAG_COMPOSE_FILE || path.join(REPO_ROOT, "docker-compose.yml");
const CONFIG_FILE = process.env.DIAG_CONFIG_FILE || path.join(REPO_ROOT, "config.yaml");
const DATA_DIR = process.env.DIAG_DATA_DIR || path.join(REPO_ROOT, "data");
const DEFAULT_SERVICE = process.env.DIAG_SERVICE || "api4llm";
const TARGET_CONTAINER = process.env.DIAG_CONTAINER || DEFAULT_SERVICE;
const DOCKER_MODE = String(process.env.DIAG_DOCKER_MODE || "auto").trim().toLowerCase();
const ALLOW_REMOTE = /^(1|true|yes|on)$/i.test(String(process.env.DIAG_ALLOW_REMOTE || ""));
const DEFAULT_PROXY_BASE = DOCKER_MODE === "container" ? "http://api4llm:8317" : "http://127.0.0.1:8317";
const PROXY_BASE = String(process.env.DIAG_PROXY_BASE || DEFAULT_PROXY_BASE).trim().replace(/\/+$/, "");
const PROXY_API_KEY = String(process.env.DIAG_API_KEY || "").trim();
const MODEL_FETCH_TIMEOUT_MS = Number.parseInt(process.env.DIAG_MODEL_TIMEOUT_MS || "10000", 10);

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const PROVIDER_LABELS = {
  "proxy-access": "Proxy Access",
  claude: "Claude",
  codex: "Codex/OpenAI",
  gemini: "Gemini",
  qwen: "Qwen",
  iflow: "iFlow",
  "openai-compat": "OpenAI-Compatible",
  unknown: "Unknown",
};

const PROVIDER_ORDER = ["proxy-access", "claude", "codex", "gemini", "qwen", "iflow", "openai-compat", "unknown"];

const FRESHNESS_SEVERITY = {
  missing: 0,
  configured: 1,
  fresh: 2,
  unknown: 3,
  warning: 4,
  stale: 5,
  expired: 6,
  error: 7,
};

function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sendJSON(res, code, body) {
  res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function splitJSONLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function runCommand(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : -1,
        signal: signal || null,
        timedOut,
        stdout,
        stderr,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        signal: null,
        timedOut,
        stdout: "",
        stderr: error.message,
      });
    });
  });
}

function normalizeProviderName(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return "unknown";
  }
  if (value.includes("proxy") || value === "api-keys" || value === "api_keys") {
    return "proxy-access";
  }
  if (value.includes("claude") || value.includes("anthropic")) {
    return "claude";
  }
  if (value.includes("codex") || value.includes("openai") || value === "gpt") {
    return "codex";
  }
  if (value.includes("gemini")) {
    return "gemini";
  }
  if (value.includes("qwen")) {
    return "qwen";
  }
  if (value.includes("iflow")) {
    return "iflow";
  }
  if (value.includes("compat") || value.includes("openrouter")) {
    return "openai-compat";
  }
  return value;
}

function deriveStateFromStatus(statusRaw) {
  const status = String(statusRaw || "").trim().toLowerCase();
  if (!status) {
    return "unknown";
  }
  if (status.startsWith("up") || status.startsWith("running")) {
    return "running";
  }
  if (status.startsWith("exited") || status.includes("dead")) {
    return "exited";
  }
  if (status.includes("restart")) {
    return "restarting";
  }
  if (status.includes("created")) {
    return "created";
  }
  return "unknown";
}

function normalizeComposeServiceState(service) {
  const status = String(service.Status || "");
  const inferred = deriveStateFromStatus(status);
  const composeState = String(service.State || "").toLowerCase();
  const state = composeState || inferred;
  const running = state === "running";
  const exited = state === "exited";

  return {
    service: service.Service || service.Name || DEFAULT_SERVICE,
    container: service.Name || service.Names || TARGET_CONTAINER,
    state: state || "unknown",
    status,
    image: service.Image || "",
    createdAt: service.CreatedAt || "",
    runningFor: service.RunningFor || "",
    exitCode: typeof service.ExitCode === "number" ? service.ExitCode : null,
    id: service.ID || "",
    running,
    exited,
  };
}

async function inspectContainerState(containerName) {
  const safeName = String(containerName || "").trim();
  if (!safeName) {
    return null;
  }
  const result = await runCommand("docker", ["inspect", safeName, "--format", "{{json .State}}"], 10000);
  if (result.code !== 0) {
    return null;
  }
  const payload = (result.stdout || "").trim();
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return {
      status: String(parsed.Status || "").toLowerCase(),
      running: Boolean(parsed.Running),
      exitCode: Number.isInteger(parsed.ExitCode) ? parsed.ExitCode : null,
      startedAt: parseTimestamp(parsed.StartedAt),
      finishedAt: parseTimestamp(parsed.FinishedAt),
    };
  } catch {
    return null;
  }
}

function normalizeContainerState(row, inspectState) {
  const status = String(row.Status || "");
  const inferred = deriveStateFromStatus(status);
  const inspectStatus = inspectState?.status || "";
  const state = inspectStatus || inferred;
  const running = inspectState?.running ?? state === "running";
  const exited = state === "exited";

  return {
    service: DEFAULT_SERVICE,
    container: row.Names || TARGET_CONTAINER,
    state: state || "unknown",
    status,
    image: row.Image || "",
    createdAt: row.CreatedAt || "",
    runningFor: row.RunningFor || "",
    exitCode: inspectState?.exitCode ?? null,
    id: row.ID || "",
    running,
    exited,
  };
}

async function getComposeServiceSummary() {
  const composeResult = await runCommand("docker", ["compose", "-f", COMPOSE_FILE, "ps", "--all", "--format", "json"]);
  const dockerOk = composeResult.code === 0;
  const services = dockerOk ? splitJSONLines(composeResult.stdout).map(normalizeComposeServiceState) : [];

  if (services.length === 0 && dockerOk) {
    services.push({
      service: DEFAULT_SERVICE,
      container: TARGET_CONTAINER,
      state: "not-created",
      status: "Container not created yet",
      image: "",
      createdAt: "",
      runningFor: "",
      exitCode: null,
      id: "",
      running: false,
      exited: false,
    });
  }

  const primary = services.find((svc) => svc.service === DEFAULT_SERVICE) || services[0] || null;
  const overallState = !primary ? "unknown" : primary.running ? "running" : primary.state;

  return {
    generatedAt: new Date().toISOString(),
    backend: "compose",
    dockerMode: DOCKER_MODE,
    dockerAvailable: dockerOk,
    composeFile: COMPOSE_FILE,
    defaultService: DEFAULT_SERVICE,
    defaultContainer: TARGET_CONTAINER,
    overallState,
    services,
    commandError: dockerOk ? "" : (composeResult.stderr || composeResult.stdout || "docker compose command failed").trim(),
  };
}

async function getContainerServiceSummary() {
  const result = await runCommand("docker", ["ps", "-a", "--filter", `name=^/${TARGET_CONTAINER}$`, "--format", "{{json .}}"]);
  const dockerOk = result.code === 0;

  if (!dockerOk) {
    return {
      generatedAt: new Date().toISOString(),
      backend: "container",
      dockerMode: DOCKER_MODE,
      dockerAvailable: false,
      composeFile: COMPOSE_FILE,
      defaultService: DEFAULT_SERVICE,
      defaultContainer: TARGET_CONTAINER,
      overallState: "unknown",
      services: [],
      commandError: (result.stderr || result.stdout || "docker ps command failed").trim(),
    };
  }

  const rows = splitJSONLines(result.stdout);
  if (rows.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      backend: "container",
      dockerMode: DOCKER_MODE,
      dockerAvailable: true,
      composeFile: COMPOSE_FILE,
      defaultService: DEFAULT_SERVICE,
      defaultContainer: TARGET_CONTAINER,
      overallState: "not-created",
      services: [
        {
          service: DEFAULT_SERVICE,
          container: TARGET_CONTAINER,
          state: "not-created",
          status: "Container not created yet",
          image: "",
          createdAt: "",
          runningFor: "",
          exitCode: null,
          id: "",
          running: false,
          exited: false,
        },
      ],
      commandError: "",
    };
  }

  const row = rows[0];
  const inspect = await inspectContainerState(row.Names || TARGET_CONTAINER);
  const primary = normalizeContainerState(row, inspect);

  return {
    generatedAt: new Date().toISOString(),
    backend: "container",
    dockerMode: DOCKER_MODE,
    dockerAvailable: true,
    composeFile: COMPOSE_FILE,
    defaultService: DEFAULT_SERVICE,
    defaultContainer: TARGET_CONTAINER,
    overallState: primary.running ? "running" : primary.state,
    services: [primary],
    commandError: "",
  };
}

async function getServiceSummary() {
  if (DOCKER_MODE === "compose") {
    return getComposeServiceSummary();
  }
  if (DOCKER_MODE === "container") {
    return getContainerServiceSummary();
  }

  const compose = await getComposeServiceSummary();
  if (compose.dockerAvailable) {
    return compose;
  }
  const container = await getContainerServiceSummary();
  if (container.dockerAvailable) {
    if (!container.commandError && compose.commandError) {
      container.commandError = compose.commandError;
    }
    return container;
  }
  return compose;
}

function getYamlSectionLines(text, key) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      continue;
    }
    const match = line.match(/^(\s*)([^:#][^:]*):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    const thisKey = match[2].trim();
    if (thisKey !== key) {
      continue;
    }
    const inlineValue = match[3].trim();
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === "" || /^\s*#/.test(next)) {
        block.push(next);
        continue;
      }
      const nextIndent = (next.match(/^\s*/) || [""])[0].length;
      if (nextIndent <= indent) {
        break;
      }
      block.push(next);
    }
    return { inlineValue, block };
  }
  return { inlineValue: "", block: [] };
}

function parseInlineList(value) {
  const cleaned = value.split("#")[0].trim();
  if (cleaned === "" || cleaned === "[]") {
    return [];
  }
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    return cleaned
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return [cleaned.replace(/^['"]|['"]$/g, "")].filter(Boolean);
}

function countYamlListEntries(text, key) {
  const section = getYamlSectionLines(text, key);
  if (section.inlineValue) {
    return parseInlineList(section.inlineValue).length;
  }
  let listIndent = -1;
  let count = 0;
  for (const line of section.block) {
    const match = line.match(/^(\s*)-\s*/);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    if (listIndent === -1) {
      listIndent = indent;
      count += 1;
      continue;
    }
    if (indent === listIndent) {
      count += 1;
    }
  }
  return count;
}

function parseTimestamp(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
    const date = rawValue > 1_000_000_000_000 ? new Date(rawValue) : new Date(rawValue * 1000);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(numeric) && String(numeric) === trimmed) {
    return parseTimestamp(numeric);
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function inferProviderFromFileName(fileName) {
  return normalizeProviderName(fileName);
}

function humanizeDurationMs(ms) {
  const abs = Math.abs(ms);
  const totalMinutes = Math.round(abs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  const seconds = Math.max(1, Math.round(abs / 1000));
  return `${seconds}s`;
}

function evaluateOAuthFileFreshness(file, nowMs) {
  if (file.parseError) {
    return {
      level: "error",
      message: "Token file cannot be parsed",
      expiresInMs: null,
    };
  }

  const expiryMs = file.expiresAt ? Date.parse(file.expiresAt) : Number.NaN;
  if (Number.isFinite(expiryMs)) {
    const delta = expiryMs - nowMs;
    if (delta <= 0) {
      return {
        level: "expired",
        message: `Expired ${humanizeDurationMs(delta)} ago`,
        expiresInMs: delta,
      };
    }
    if (delta <= 24 * 60 * 60 * 1000) {
      return {
        level: "warning",
        message: `Expires in ${humanizeDurationMs(delta)}`,
        expiresInMs: delta,
      };
    }
    return {
      level: "fresh",
      message: `Valid for ${humanizeDurationMs(delta)}`,
      expiresInMs: delta,
    };
  }

  const refreshMs = file.lastRefresh ? Date.parse(file.lastRefresh) : Number.NaN;
  if (Number.isFinite(refreshMs)) {
    const age = nowMs - refreshMs;
    if (age <= 7 * 24 * 60 * 60 * 1000) {
      return {
        level: "fresh",
        message: `Refreshed ${humanizeDurationMs(age)} ago`,
        expiresInMs: null,
      };
    }
    if (age <= 30 * 24 * 60 * 60 * 1000) {
      return {
        level: "warning",
        message: `Refresh is ${humanizeDurationMs(age)} old`,
        expiresInMs: null,
      };
    }
    return {
      level: "stale",
      message: `Refresh is stale (${humanizeDurationMs(age)} old)`,
      expiresInMs: null,
    };
  }

  const modifiedMs = file.modifiedAt ? Date.parse(file.modifiedAt) : Number.NaN;
  if (Number.isFinite(modifiedMs)) {
    const age = nowMs - modifiedMs;
    if (age <= 30 * 24 * 60 * 60 * 1000) {
      return {
        level: "unknown",
        message: `No expiry metadata, file updated ${humanizeDurationMs(age)} ago`,
        expiresInMs: null,
      };
    }
    return {
      level: "stale",
      message: `No expiry metadata and file is old (${humanizeDurationMs(age)})`,
      expiresInMs: null,
    };
  }

  return {
    level: "unknown",
    message: "No expiry metadata",
    expiresInMs: null,
  };
}

function formatProviderLabel(provider) {
  return PROVIDER_LABELS[provider] || provider.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeModelID(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("models/")) {
    return trimmed.slice("models/".length);
  }
  return trimmed;
}

function inferProviderFromModel(modelID, ownedBy) {
  const owner = normalizeProviderName(ownedBy || "");
  if (owner !== "unknown" && owner !== "proxy-access" && owner !== "openai-compat") {
    return owner;
  }

  const id = String(modelID || "").trim().toLowerCase();
  if (!id) {
    return "unknown";
  }
  if (id.includes("claude")) {
    return "claude";
  }
  if (id.includes("gemini")) {
    return "gemini";
  }
  if (id.includes("qwen")) {
    return "qwen";
  }
  if (id.includes("iflow")) {
    return "iflow";
  }
  if (
    id.includes("gpt") ||
    id.includes("o1") ||
    id.includes("o3") ||
    id.includes("o4") ||
    id.includes("codex") ||
    id.includes("chatgpt")
  ) {
    return "codex";
  }
  return owner !== "unknown" ? owner : "unknown";
}

async function fetchProxyJSON(endpointPath) {
  const url = `${PROXY_BASE}${endpointPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, MODEL_FETCH_TIMEOUT_MS || 10000));

  try {
    const headers = { Accept: "application/json" };
    if (PROXY_API_KEY) {
      headers.Authorization = `Bearer ${PROXY_API_KEY}`;
      headers["X-API-Key"] = PROXY_API_KEY;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errMessage =
        (payload && (payload.error?.message || payload.error || payload.message)) ||
        text ||
        `upstream returned ${response.status}`;
      return {
        ok: false,
        status: response.status,
        error: String(errMessage).trim(),
        data: payload,
      };
    }

    return {
      ok: true,
      status: response.status,
      error: "",
      data: payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "request failed",
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sortProviders(a, b) {
  const idxA = PROVIDER_ORDER.indexOf(a);
  const idxB = PROVIDER_ORDER.indexOf(b);
  if (idxA >= 0 && idxB >= 0) {
    return idxA - idxB;
  }
  if (idxA >= 0) {
    return -1;
  }
  if (idxB >= 0) {
    return 1;
  }
  return a.localeCompare(b);
}

async function getProviderModels() {
  const [openaiModelsResp, geminiModelsResp] = await Promise.all([
    fetchProxyJSON("/v1/models"),
    fetchProxyJSON("/v1beta/models"),
  ]);

  const entries = new Map();
  const collect = (provider, modelID, displayName, source, ownedBy) => {
    const normalizedID = normalizeModelID(modelID);
    if (!normalizedID) {
      return;
    }
    const key = `${provider}::${normalizedID}`;
    const existing = entries.get(key);
    if (existing) {
      existing.sources.add(source);
      if (!existing.displayName && displayName) {
        existing.displayName = displayName;
      }
      return;
    }
    entries.set(key, {
      provider,
      id: normalizedID,
      displayName: String(displayName || "").trim(),
      ownedBy: String(ownedBy || "").trim(),
      sources: new Set([source]),
    });
  };

  if (openaiModelsResp.ok && openaiModelsResp.data && Array.isArray(openaiModelsResp.data.data)) {
    for (const model of openaiModelsResp.data.data) {
      const id = model?.id;
      const ownedBy = model?.owned_by || "";
      const provider = inferProviderFromModel(id, ownedBy);
      collect(provider, id, model?.display_name || "", "openai", ownedBy);
    }
  }

  if (geminiModelsResp.ok && geminiModelsResp.data && Array.isArray(geminiModelsResp.data.models)) {
    for (const model of geminiModelsResp.data.models) {
      const id = model?.name || model?.id;
      const provider = inferProviderFromModel(id, model?.owned_by || "");
      collect(provider, id, model?.displayName || model?.display_name || "", "gemini", model?.owned_by || "");
    }
  }

  const byProvider = new Map();
  for (const item of entries.values()) {
    const list = byProvider.get(item.provider) || [];
    list.push({
      id: item.id,
      displayName: item.displayName,
      ownedBy: item.ownedBy,
      sources: [...item.sources].sort(),
    });
    byProvider.set(item.provider, list);
  }

  const providerModels = [...byProvider.keys()]
    .sort(sortProviders)
    .map((provider) => {
      const models = (byProvider.get(provider) || []).sort((a, b) => a.id.localeCompare(b.id));
      return {
        provider,
        label: formatProviderLabel(provider),
        count: models.length,
        models,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    proxyBase: PROXY_BASE,
    authorization: {
      provided: PROXY_API_KEY !== "",
      mode: PROXY_API_KEY !== "" ? "bearer+x-api-key" : "none",
    },
    endpointStatus: {
      openai: {
        ok: openaiModelsResp.ok,
        status: openaiModelsResp.status,
        count:
          openaiModelsResp.ok && openaiModelsResp.data && Array.isArray(openaiModelsResp.data.data)
            ? openaiModelsResp.data.data.length
            : 0,
        error: openaiModelsResp.error,
      },
      gemini: {
        ok: geminiModelsResp.ok,
        status: geminiModelsResp.status,
        count:
          geminiModelsResp.ok && geminiModelsResp.data && Array.isArray(geminiModelsResp.data.models)
            ? geminiModelsResp.data.models.length
            : 0,
        error: geminiModelsResp.error,
      },
    },
    totalModels: providerModels.reduce((sum, item) => sum + item.count, 0),
    providerModels,
  };
}

function buildProviderHealth(oauthFiles, staticCounts) {
  const nowMs = Date.now();
  const grouped = new Map();
  for (const file of oauthFiles) {
    const provider = normalizeProviderName(file.provider || "unknown");
    const items = grouped.get(provider) || [];
    items.push(file);
    grouped.set(provider, items);
  }

  const providers = new Set([...PROVIDER_ORDER, ...Object.keys(staticCounts), ...grouped.keys()]);

  const orderedProviders = [...providers].sort((a, b) => {
    const idxA = PROVIDER_ORDER.indexOf(a);
    const idxB = PROVIDER_ORDER.indexOf(b);
    if (idxA >= 0 && idxB >= 0) {
      return idxA - idxB;
    }
    if (idxA >= 0) {
      return -1;
    }
    if (idxB >= 0) {
      return 1;
    }
    return a.localeCompare(b);
  });

  const output = [];

  for (const provider of orderedProviders) {
    const oauthEntries = grouped.get(provider) || [];
    const staticKeyCount = Number(staticCounts[provider] || 0);
    const evaluations = oauthEntries.map((entry) => evaluateOAuthFileFreshness(entry, nowMs));

    let status = "missing";
    let statusMessage = "No credentials configured";

    if (oauthEntries.length > 0) {
      let worst = evaluations[0] || { level: "unknown", message: "No health data", expiresInMs: null };
      for (const candidate of evaluations) {
        if ((FRESHNESS_SEVERITY[candidate.level] || 0) > (FRESHNESS_SEVERITY[worst.level] || 0)) {
          worst = candidate;
        }
      }
      status = worst.level;
      statusMessage = worst.message;
    } else if (staticKeyCount > 0) {
      status = "configured";
      statusMessage = `${staticKeyCount} static API key(s) configured`;
    }

    const expiryValues = oauthEntries
      .map((entry) => Date.parse(entry.expiresAt || ""))
      .filter((ts) => Number.isFinite(ts));

    let soonestExpiry = "";
    if (expiryValues.length > 0) {
      const minTs = Math.min(...expiryValues);
      if (Number.isFinite(minTs)) {
        soonestExpiry = new Date(minTs).toISOString();
      }
    }

    const refreshValues = oauthEntries
      .map((entry) => Date.parse(entry.lastRefresh || entry.modifiedAt || ""))
      .filter((ts) => Number.isFinite(ts));

    let latestRefresh = "";
    if (refreshValues.length > 0) {
      const maxTs = Math.max(...refreshValues);
      if (Number.isFinite(maxTs)) {
        latestRefresh = new Date(maxTs).toISOString();
      }
    }

    const expiredCount = expiryValues.filter((ts) => ts <= nowMs).length;
    const expiringSoonCount = expiryValues.filter((ts) => ts > nowMs && ts <= nowMs + 24 * 60 * 60 * 1000).length;
    const parseErrors = oauthEntries.filter((entry) => entry.parseError).length;

    let authMode = "none";
    if (oauthEntries.length > 0 && staticKeyCount > 0) {
      authMode = "mixed";
    } else if (oauthEntries.length > 0) {
      authMode = "oauth";
    } else if (staticKeyCount > 0) {
      authMode = "api-keys";
    }

    output.push({
      provider,
      label: formatProviderLabel(provider),
      status,
      statusMessage,
      authMode,
      oauthCount: oauthEntries.length,
      staticKeyCount,
      expiredCount,
      expiringSoonCount,
      parseErrors,
      soonestExpiry,
      latestRefresh,
    });
  }

  return output;
}

async function readAuthFiles() {
  const result = [];
  try {
    const entries = await readdir(DATA_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(DATA_DIR, entry.name);
      let fileSize = 0;
      let modifiedAt = "";
      try {
        const fileStat = await stat(fullPath);
        fileSize = fileStat.size;
        modifiedAt = fileStat.mtime.toISOString();
      } catch {
        // Ignore stat failures for this entry.
      }

      try {
        const raw = await readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        const provider = normalizeProviderName(parsed.type || parsed.provider || inferProviderFromFileName(entry.name));
        const email = String(parsed.email || parsed.account_email || parsed.account || "").trim();
        const expiresAt =
          parseTimestamp(parsed.expires_at) ||
          parseTimestamp(parsed.expiresAt) ||
          parseTimestamp(parsed.expire) ||
          parseTimestamp(parsed.expired);
        const lastRefresh =
          parseTimestamp(parsed.last_refresh) ||
          parseTimestamp(parsed.lastRefresh) ||
          parseTimestamp(parsed.last_refreshed_at) ||
          parseTimestamp(parsed.lastRefreshedAt);

        result.push({
          file: entry.name,
          provider,
          email,
          expiresAt,
          lastRefresh,
          modifiedAt,
          size: fileSize,
          parseError: "",
        });
      } catch (error) {
        result.push({
          file: entry.name,
          provider: inferProviderFromFileName(entry.name),
          email: "",
          expiresAt: "",
          lastRefresh: "",
          modifiedAt,
          size: fileSize,
          parseError: error instanceof Error ? error.message : "failed to parse JSON",
        });
      }
    }
  } catch {
    return [];
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

async function getAuthMechanisms() {
  let configText = "";
  let configReadable = false;
  try {
    configText = await readFile(CONFIG_FILE, "utf8");
    configReadable = true;
  } catch {
    configText = "";
  }

  const apiKeys = configReadable ? countYamlListEntries(configText, "api-keys") : 0;
  const geminiApiKeys = configReadable ? countYamlListEntries(configText, "gemini-api-key") : 0;
  const glApiKeys = configReadable ? countYamlListEntries(configText, "generative-language-api-key") : 0;
  const claudeApiKeys = configReadable ? countYamlListEntries(configText, "claude-api-key") : 0;
  const codexApiKeys = configReadable ? countYamlListEntries(configText, "codex-api-key") : 0;
  const openAICompat = configReadable ? countYamlListEntries(configText, "openai-compatibility") : 0;

  const oauthFiles = await readAuthFiles();
  const oauthByProvider = oauthFiles.reduce((acc, item) => {
    const key = normalizeProviderName(item.provider || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const mechanisms = [
    {
      id: "proxy-access-keys",
      label: "Proxy access API keys",
      count: apiKeys,
      configured: apiKeys > 0,
      source: "config.yaml",
      description: "Client keys required to call the proxy endpoints.",
    },
    {
      id: "gemini-api-keys",
      label: "Gemini API keys",
      count: geminiApiKeys + glApiKeys,
      configured: geminiApiKeys + glApiKeys > 0,
      source: "config.yaml",
      description: "Direct Gemini / Generative Language key entries.",
    },
    {
      id: "claude-api-keys",
      label: "Claude API keys",
      count: claudeApiKeys,
      configured: claudeApiKeys > 0,
      source: "config.yaml",
      description: "Static Anthropic key entries.",
    },
    {
      id: "codex-api-keys",
      label: "Codex/OpenAI API keys",
      count: codexApiKeys,
      configured: codexApiKeys > 0,
      source: "config.yaml",
      description: "Static Codex/OpenAI key entries.",
    },
    {
      id: "openai-compatibility",
      label: "OpenAI-compatible upstreams",
      count: openAICompat,
      configured: openAICompat > 0,
      source: "config.yaml",
      description: "External OpenAI-compatible providers defined in config.",
    },
    {
      id: "oauth-auth-files",
      label: "OAuth auth files",
      count: oauthFiles.length,
      configured: oauthFiles.length > 0,
      source: "data/",
      description: "Runtime OAuth credentials discovered from token files.",
    },
  ];

  const providerHealth = buildProviderHealth(oauthFiles, {
    "proxy-access": apiKeys,
    gemini: geminiApiKeys + glApiKeys,
    claude: claudeApiKeys,
    codex: codexApiKeys,
    "openai-compat": openAICompat,
    qwen: 0,
    iflow: 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    configPath: CONFIG_FILE,
    configReadable,
    dataDir: DATA_DIR,
    mechanisms,
    oauthSummary: oauthByProvider,
    oauthFiles,
    providerHealth,
  };
}

async function runComposeAction(action) {
  const actions = {
    start: ["compose", "-f", COMPOSE_FILE, "up", "-d", DEFAULT_SERVICE],
    stop: ["compose", "-f", COMPOSE_FILE, "stop", DEFAULT_SERVICE],
    restart: ["compose", "-f", COMPOSE_FILE, "restart", DEFAULT_SERVICE],
  };
  const args = actions[action];
  if (!args) {
    return { ok: false, error: "unsupported action", backend: "compose" };
  }
  const result = await runCommand("docker", args, 120000);
  return {
    ok: result.code === 0,
    backend: "compose",
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function runDirectContainerAction(action) {
  const actions = {
    start: ["start", TARGET_CONTAINER],
    stop: ["stop", TARGET_CONTAINER],
    restart: ["restart", TARGET_CONTAINER],
  };
  const args = actions[action];
  if (!args) {
    return { ok: false, error: "unsupported action", backend: "container" };
  }
  const result = await runCommand("docker", args, 120000);
  return {
    ok: result.code === 0,
    backend: "container",
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function runContainerAction(action) {
  if (DOCKER_MODE === "compose") {
    return runComposeAction(action);
  }
  if (DOCKER_MODE === "container") {
    return runDirectContainerAction(action);
  }

  const compose = await runComposeAction(action);
  if (compose.ok) {
    return compose;
  }

  const direct = await runDirectContainerAction(action);
  if (direct.ok) {
    return {
      ...direct,
      fallbackFrom: "compose",
      fallbackError: compose.stderr || compose.stdout || "compose action failed",
    };
  }

  return {
    ...compose,
    fallbackTried: "container",
    fallbackError: direct.stderr || direct.stdout || "container action failed",
  };
}

function streamLogs(req, res, containerName) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const safeContainer = (containerName || TARGET_CONTAINER).replace(/[^a-zA-Z0-9_.-]/g, "");
  const child = spawn("docker", ["logs", "--timestamps", "--tail", "200", "--follow", safeContainer], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  const writeLine = (line, kind = "log") => {
    const payload = JSON.stringify({ kind, line, ts: new Date().toISOString() });
    res.write(`data: ${payload}\n\n`);
  };

  const flushChunk = (chunk, kind) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
      if (!line) {
        continue;
      }
      writeLine(line, kind);
    }
  };

  child.stdout.on("data", (chunk) => flushChunk(chunk, "log"));
  child.stderr.on("data", (chunk) => flushChunk(chunk, "error"));

  child.on("close", (code) => {
    if (buffer.trim()) {
      writeLine(buffer.trim(), "log");
      buffer = "";
    }
    writeLine(`log stream ended (exit code ${code ?? "unknown"})`, "status");
    res.end();
  });

  child.on("error", (error) => {
    writeLine(`failed to start docker logs stream: ${error.message}`, "error");
    res.end();
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
}

async function serveStatic(res, urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, normalized);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    await access(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    createReadStream(fullPath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const requestURL = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestURL.pathname;

  if (pathname.startsWith("/api/") && !ALLOW_REMOTE && !isLocalRequest(req)) {
    sendJSON(res, 403, { error: "Local access only", details: "Diagnostics API is bound to localhost." });
    return;
  }

  if (method === "GET" && pathname === "/api/summary") {
    const summary = await getServiceSummary();
    sendJSON(res, 200, summary);
    return;
  }

  if (method === "GET" && pathname === "/api/auth-mechanisms") {
    const auth = await getAuthMechanisms();
    sendJSON(res, 200, auth);
    return;
  }

  if (method === "GET" && pathname === "/api/provider-models") {
    const models = await getProviderModels();
    sendJSON(res, 200, models);
    return;
  }

  if (method === "GET" && pathname === "/api/logs/stream") {
    const container = requestURL.searchParams.get("container") || TARGET_CONTAINER;
    streamLogs(req, res, container);
    return;
  }

  if (method === "POST" && pathname.startsWith("/api/container/")) {
    const action = pathname.replace("/api/container/", "").trim().toLowerCase();
    const result = await runContainerAction(action);
    sendJSON(res, result.ok ? 200 : 500, result);
    return;
  }

  if (method === "GET" && pathname === "/api/healthz") {
    sendJSON(res, 200, { ok: true, timestamp: new Date().toISOString() });
    return;
  }

  await serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Diagnostics dashboard listening on http://${HOST}:${PORT}`);
  console.log(`Docker mode: ${DOCKER_MODE}`);
  console.log(`Default service: ${DEFAULT_SERVICE}`);
  console.log(`Target container: ${TARGET_CONTAINER}`);
  console.log(`Watching compose file: ${COMPOSE_FILE}`);
  console.log(`Inspecting config file: ${CONFIG_FILE}`);
  if (ALLOW_REMOTE) {
    console.log("Remote diagnostics API access is enabled");
  }
});
