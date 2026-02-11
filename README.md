# api4LLM

Self-hosted Docker wrapper for [CLIProxyAPI](https://github.com/edlsh/ai-cli-proxy-api) so you can use Claude/Codex-style logins through a local OpenAI-compatible proxy.

## What You Get

When you run this repo, Docker Compose starts two services:

- `api4llm`: proxy API server (OpenAI-compatible)
- `diagnostics`: operational dashboard (status, auth diagnostics, live logs)

## Prerequisites

- Docker + Docker Compose
- Git

## Quick Start (New Dev)

1. Clone with submodules:
   ```bash
   git clone --recurse-submodules https://github.com/the-wise-monkey/api4LLM.git
   cd api4LLM
   ```

2. Start everything:
   ```bash
   docker compose up -d --build
   ```

3. Login to Claude (first time only):
   ```bash
   docker exec -it api4llm ./CLIProxyAPI --claude-login
   ```

4. Use endpoints:
   - API: `http://localhost:8317`
   - Dashboard: `http://127.0.0.1:9321`

If you already cloned without submodules:
```bash
git submodule update --init --recursive
```

## Daily Commands

| Purpose | Command |
|---|---|
| Start/rebuild all services | `docker compose up -d --build` |
| Stop all services | `docker compose down` |
| Restart all services | `docker compose restart` |
| Follow all logs | `docker compose logs -f` |
| Follow only API logs | `docker compose logs -f api4llm` |
| Follow only dashboard logs | `docker compose logs -f diagnostics` |

NPM shortcuts:

- `npm start` -> `docker compose up -d --build`
- `npm run stop` -> `docker compose down`
- `npm run logs` -> `docker compose logs -f`
- `npm run restart` -> `docker compose restart`

## Project Layout

- `config.yaml`: runtime API config
- `data/`: persisted auth/token files
- `CLIProxyAPI/`: upstream proxy code (submodule)
- `diagnostics/`: wrapper-owned diagnostics webapp

## Ports

| Port | Service | Notes |
|---|---|---|
| `8317` | `api4llm` | OpenAI-compatible API endpoint |
| `54545` | `api4llm` | Claude OAuth callback |
| `9321` | `diagnostics` | Dashboard (bound to localhost in Compose) |

## Configuration

Minimum `config.yaml` example:

```yaml
port: 8317
auth-dir: "/CLIProxyAPI/data"
api-keys: []
debug: false
```

## Diagnostics Dashboard

The dashboard provides:

- Container/process status
- Auth mechanisms from `config.yaml`
- Provider health cards (Claude/Codex/Gemini/Qwen/iFlow/etc.)
- Provider model catalog grouped by provider (from `/v1/models` and `/v1beta/models`)
- Token freshness indicators (fresh/warning/stale/expired)
- OAuth auth files discovered in `./data`
- Live `docker logs` stream for the API container
- Resolution gate requiring minimum viewport `1366x768`

Compose mode is the default and recommended mode.

Standalone environment overrides:

- `DIAG_ALLOW_REMOTE` (default `false`)
- `DIAG_API_KEY` (optional; used when model endpoints require proxy auth)
- `DIAG_COMPOSE_FILE` (default `./docker-compose.yml`)
- `DIAG_CONFIG_FILE` (default `./config.yaml`)
- `DIAG_CONTAINER` (default `api4llm`)
- `DIAG_DATA_DIR` (default `./data`)
- `DIAG_DOCKER_MODE` (`auto`, `compose`, `container`; default `auto`)
- `DIAG_HOST` (default `127.0.0.1`)
- `DIAG_MODEL_TIMEOUT_MS` (default `10000`)
- `DIAG_PORT` (default `9321`)
- `DIAG_PROXY_BASE` (default `http://127.0.0.1:8317` in host mode, `http://api4llm:8317` in container mode)
- `DIAG_SERVICE` (default `api4llm`)

## Updating Upstream Submodule

```bash
git submodule update --remote
docker compose up -d --build
```

## Troubleshooting

- Dashboard not loading on `9321`:
  - `docker compose ps`
  - `docker compose logs -f diagnostics`

- API not reachable on `8317`:
  - `docker compose logs -f api4llm`
  - verify `config.yaml` is valid and mounted

- Auth not detected in dashboard:
  - confirm token files exist in `./data`
  - check `auth-dir` in `config.yaml` is `/CLIProxyAPI/data`

- Model catalog is empty or unauthorized:
  - verify API is reachable at `DIAG_PROXY_BASE`
  - if `api-keys` are enabled, set `DIAG_API_KEY` for the diagnostics service
