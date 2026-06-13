# Deploying OpenAlice on Unraid

OpenAlice runs cleanly on Unraid as a Docker container. This guide covers:

- [Quick install via docker-compose](#quick-install)
- [Adding Ollama for local AI](#adding-ollama)
- [Networking between containers](#networking)
- [GPU passthrough for local models](#gpu-passthrough)
- [Troubleshooting](#troubleshooting)

---

## Quick Install

### 1. Place files on your Unraid server

Copy `docker-compose.unraid.yml` (from the repo root) to your Unraid server,
e.g. `/mnt/user/appdata/openalice/docker-compose.yml`.

### 2. Create the appdata directory

```bash
mkdir -p /mnt/user/appdata/openalice
```

### 3. Find your PUID / PGID

```bash
id
# uid=0(root) gid=0(root) groups=0(root)
# On Unraid, nobody=99, users=100 is the standard.
```

Unraid Community Applications uses `nobody:users` (99:100) by default.

### 4. Start the container

```bash
docker compose -f /mnt/user/appdata/openalice/docker-compose.yml up -d
```

The web UI is available at `http://unraid-ip:47331`.

### 5. Authenticate the AI agent (first run)

OpenAlice uses Claude Code CLI for AI workspaces. Authenticate once:

```bash
docker exec -it openalice claude
# Follow the URL → paste the OAuth code back in the terminal
```

For OpenAI Codex workspaces:

```bash
docker exec -it openalice codex login
```

---

## Unraid Template (Community Applications)

If you prefer the CA GUI, use the built-in template:

1. In Unraid, go to **Apps** → search "OpenAlice"
2. Install — configure PUID, PGID, and port as prompted
3. Authenticate via the shell tab after first boot

Alternatively, use **Add Container** with these settings:

| Field | Value |
|---|---|
| Name | openalice |
| Repository | `ghcr.io/traderalice/openalice:latest` |
| Port | `47331:47331` |
| Path `/data` | `/mnt/user/appdata/openalice` |
| Variable `PUID` | `99` |
| Variable `PGID` | `100` |
| Variable `TZ` | Your timezone |

---

## Adding Ollama

### Option A — Ollama already runs on the Unraid host

If Ollama is installed via Community Applications and runs outside Docker:

```yaml
# docker-compose.unraid.yml
environment:
  LLM_PROVIDER: "ollama"
  OLLAMA_BASE_URL: "http://host.docker.internal:11434"
  MODEL_NAME: "llama3.2"
```

`host.docker.internal` resolves to the Unraid host from inside the container
(the `extra_hosts` mapping in the compose file handles this).

Pull the model before starting:

```bash
docker exec -it ollama ollama pull llama3.2
```

### Option B — Ollama in the same compose project

Add the Ollama service (uncomment the block in `docker-compose.unraid.yml`):

```yaml
services:
  openalice:
    # ... existing config ...
    environment:
      LLM_PROVIDER: "ollama"
      OLLAMA_BASE_URL: "http://ollama:11434"
      MODEL_NAME: "llama3.2"

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    volumes:
      - /mnt/user/appdata/ollama:/root/.ollama
    ports:
      - "11434:11434"
```

Start everything:

```bash
docker compose -f docker-compose.unraid.yml up -d
docker exec -it ollama ollama pull llama3.2
```

### Using the Ollama credential in a workspace

After restart, a credential named `env-local-llm` appears in
**Settings › AI Providers**. Create a workspace and select that credential;
choose `opencode` or `pi` as the agent (Ollama speaks `openai-chat`, which
`claude` and `codex` agents do not support).

---

## Other Local Providers

### LM Studio

Run LM Studio on your desktop/workstation with the local server enabled.

```yaml
environment:
  LLM_PROVIDER: "lmstudio"
  LMSTUDIO_BASE_URL: "http://host.docker.internal:1234"
  MODEL_NAME: "local-model"
```

### vLLM

```bash
docker run --gpus all -p 8000:8000 vllm/vllm-openai \
  --model meta-llama/Meta-Llama-3-8B-Instruct
```

```yaml
environment:
  LLM_PROVIDER: "vllm"
  VLLM_BASE_URL: "http://vllm:8000"
  MODEL_NAME: "meta-llama/Meta-Llama-3-8B-Instruct"
```

### LiteLLM Proxy (multiple providers, one endpoint)

LiteLLM proxies Ollama, Anthropic, OpenAI and 100+ others under a single
OpenAI-compatible API.

```yaml
environment:
  LLM_PROVIDER: "litellm"
  LITELLM_BASE_URL: "http://litellm:4000"
  OPENAI_API_KEY: "your-litellm-master-key"  # optional
  MODEL_NAME: "ollama/llama3.2"
```

### LocalAI

```yaml
environment:
  LLM_PROVIDER: "localai"
  LOCALAI_BASE_URL: "http://localai:8080"
  MODEL_NAME: "gpt-4"  # the filename/alias you configured in LocalAI
```

### OpenRouter (cloud + free models)

```yaml
environment:
  LLM_PROVIDER: "openrouter"
  OPENAI_API_KEY: "sk-or-..."
  MODEL_NAME: "meta-llama/llama-3.1-8b-instruct:free"
```

---

## Open WebUI + OpenAlice

Run Open WebUI alongside OpenAlice to give your family a ChatGPT-style
frontend while OpenAlice handles trading workspaces.

```yaml
services:
  openalice:
    # ... as above ...

  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    container_name: open-webui
    restart: unless-stopped
    ports:
      - "3000:8080"
    volumes:
      - /mnt/user/appdata/open-webui:/app/backend/data
    environment:
      OLLAMA_BASE_URL: "http://ollama:11434"

  ollama:
    image: ollama/ollama:latest
    # ... as above ...
```

---

## Networking

### Container-to-container (same compose project)

Use the service name as the hostname:

```
OLLAMA_BASE_URL=http://ollama:11434
LITELLM_BASE_URL=http://litellm:4000
```

### Container to Unraid host service

Use `host.docker.internal` — mapped via `extra_hosts` in the compose file:

```
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

### Custom bridge network

If OpenAlice and Ollama are in separate compose projects, connect them to a
shared network:

```yaml
# Both compose files
networks:
  ai-net:
    external: true
    name: ai-net
```

Create the network once:

```bash
docker network create ai-net
```

---

## GPU Passthrough

### Nvidia (requires Unraid Nvidia Driver plugin)

Install **Nvidia Driver** from Community Applications, then add to the Ollama service:

```yaml
ollama:
  image: ollama/ollama:latest
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
  environment:
    - NVIDIA_VISIBLE_DEVICES=all
```

Or using the legacy `--gpus` flag (Unraid's Docker Manager → Advanced):

```
Extra Parameters: --gpus all
```

### AMD (ROCm)

Use the ROCm-enabled Ollama image:

```yaml
ollama:
  image: ollama/ollama:rocm
  devices:
    - /dev/kfd
    - /dev/dri
```

Verify GPU detection:

```bash
docker exec -it ollama ollama run llama3.2 "Hello!"
# Should show GPU layer counts in the output
```

---

## Persistent Storage Layout

```
/mnt/user/appdata/openalice/          ← all persistent state
├── data/
│   ├── config/                       ← AI credentials, broker config, settings
│   │   ├── ai-provider.json          ← credential vault
│   │   ├── trading.json              ← broker accounts
│   │   └── _meta.json                ← migration journal
│   ├── sessions/                     ← workspace session files
│   ├── trading/                      ← trade state (git-like)
│   └── control/                      ← UTA restart flag
├── home/
│   ├── .claude/                      ← Claude Code auth tokens
│   └── .codex/                       ← Codex auth tokens
└── workspaces/                       ← workspace source trees
```

**Back up `/mnt/user/appdata/openalice/data/config/`** — it contains your
broker credentials and AI provider keys. The sealing key lives at
`~/.openalice/sealing.key` on the host (outside the appdata directory).

---

## Healthcheck

The container exposes a healthcheck at:

```
GET http://localhost:47331/api/version
```

Unraid's Docker panel shows the health status. You can also check manually:

```bash
docker inspect openalice --format='{{.State.Health.Status}}'
# healthy | starting | unhealthy
```

---

## Upgrading

```bash
docker compose -f docker-compose.unraid.yml pull
docker compose -f docker-compose.unraid.yml up -d
```

Migrations run automatically on startup. The migration journal at
`data/config/_meta.json` prevents double-runs.

---

## Troubleshooting

### Container exits immediately

Check logs:

```bash
docker logs openalice --tail 50
```

Common causes:
- **UTA failed to start**: check `OPENALICE_UTA_PORT` isn't occupied
- **Volume permissions**: ensure `PUID:PGID` match the appdata owner
- **Port conflict**: another service uses `47331` — change `WEB_PORT`

### Ollama not reachable from container

1. Verify Ollama is running on the host: `curl http://localhost:11434`
2. Check `extra_hosts` is in the compose file (`host.docker.internal:host-gateway`)
3. Try the IP directly: find it with `ip route | grep docker`

### "env-local-llm credential not appearing"

- Confirm `LLM_PROVIDER` (or `OLLAMA_BASE_URL` etc.) is set in the environment
- Restart the container: `docker restart openalice`
- Check logs for `[env-bootstrap]` lines

### Workspace agent can't use local model

Local LLM providers use the `openai-chat` wire shape. Only `opencode` and `pi`
agents support this shape. When creating a workspace, select **opencode** or
**pi** as the agent, not `claude` or `codex`.

### Permission denied on /data

```bash
chown -R 99:100 /mnt/user/appdata/openalice
docker restart openalice
```

### Port 47331 already in use

```yaml
ports:
  - "7331:47331"  # use host port 7331 instead
environment:
  # No change needed — OPENALICE_WEB_PORT is the container-internal port
```

---

## Environment Variable Reference

| Variable | Default | Description |
|---|---|---|
| `PUID` | `0` | UID to run as |
| `PGID` | `0` | GID to run as |
| `TZ` | `UTC` | Timezone |
| `OPENALICE_WEB_PORT` | `47331` | Web UI port |
| `OPENALICE_MCP_PORT` | `47332` | MCP server port |
| `OPENALICE_UTA_PORT` | `47333` | UTA service port |
| `LLM_PROVIDER` | _(none)_ | Auto-seed provider: `ollama`, `lmstudio`, `vllm`, `litellm`, `localai`, `openrouter` |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama host |
| `OPENAI_BASE_URL` | _(none)_ | Generic OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | _(none)_ | API key for OpenAI-compatible endpoints |
| `LMSTUDIO_BASE_URL` | `http://host.docker.internal:1234` | LM Studio host |
| `VLLM_BASE_URL` | `http://vllm:8000` | vLLM host |
| `LITELLM_BASE_URL` | `http://litellm:4000` | LiteLLM proxy host |
| `LOCALAI_BASE_URL` | `http://localai:8080` | LocalAI host |
| `MODEL_NAME` | _(none)_ | Model hint stored with credential |
| `FALLBACK_MODEL` | _(none)_ | Fallback model hint (logged only) |
