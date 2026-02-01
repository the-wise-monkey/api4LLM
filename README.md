# api4LLM

Self-hosted Docker wrapper for [CLIProxyAPI](https://github.com/edlsh/ai-cli-proxy-api) that enables Claude/Codex subscription logins to be used through a local OpenAI-compatible API proxy — no official API keys required.

## Prerequisites

- [Docker](https://www.docker.com/) with Docker Compose
- [Git](https://git-scm.com/)

## Quick Start

1. **Clone with submodules**
   ```bash
   git clone --recurse-submodules https://github.com/the-wise-monkey/api4LLM.git
   cd api4LLM
   ```

2. **Start the container**
   ```bash
   docker compose up -d --build
   ```

3. **Login to Claude** (first time only)
   ```bash
   docker exec -it api4llm ./CLIProxyAPI --claude-login
   ```

4. **Use the API** at `http://localhost:8317`

## Commands

| Command | Description |
|---------|-------------|
| `docker compose up -d --build` | Build and start container (detached) |
| `docker compose down` | Stop the container |
| `docker compose logs -f` | Follow container logs |
| `docker compose restart` | Restart the container |

## Auto-start

The container is configured with `restart: unless-stopped`, so it will automatically start when Docker starts.

## Configuration

Edit `config.yaml` to customize settings:

```yaml
# Server port
port: 8317

# Authentication directory
auth-dir: "/CLIProxyAPI/data"

# API keys for authentication (leave empty for no auth)
api-keys: []

# Enable debug logging
debug: false
```

## Ports

| Port | Description |
|------|-------------|
| 8317 | API endpoint (OpenAI-compatible) |
| 54545 | Claude OAuth callback (used during login) |

## Updating

To update the upstream CLIProxyAPI:

```bash
git submodule update --remote
docker compose up -d --build
```
