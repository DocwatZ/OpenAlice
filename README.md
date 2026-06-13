<p align="center">
  <img src="docs/images/alice-full.png" alt="OpenAlice" width="140">
</p>

<h1 align="center">OpenAlice</h1>

<p align="center">
  <strong>Your one-person Wall Street.</strong><br>
  An AI trading agent covering equities, crypto, commodities, forex, and macro — from research through position entry, ongoing management, to exit.
</p>

<p align="center">
  <a href="https://openalice.ai"><img src="https://img.shields.io/badge/Website-blue" alt="Website"></a> · <a href="https://openalice.ai/docs"><img src="https://img.shields.io/badge/Docs-green" alt="Docs"></a>
</p>

<p align="center">
  <img src="docs/images/preview.png" alt="OpenAlice Preview" width="720">
</p>

- **Full-spectrum** — analyze and trade across asset classes. Multiple brokers combine into one unified workspace so you're never stuck with "I can see it but can't trade it."
- **Full-lifecycle** — not just entry signals. Research, position sizing, ongoing monitoring, risk management, and exit decisions — Alice covers the entire trading lifecycle, 24/7.
- **Full-control** — every trade goes through version history and safety checks, and requires your explicit approval before execution. You see every step, you can stop every step.

Alice runs on your own machine, because trading involves private keys and real money — that trust can't be outsourced.

> [!CAUTION]
> **OpenAlice is experimental software in active development.** Many features and interfaces are incomplete and subject to breaking changes. Do not use this software for live trading with real funds unless you understand the risks and are comfortable debugging issues yourself.

## Features

### Trading

- **Unified Trading Account (UTA)** — multiple brokers (CCXT, Alpaca, Interactive Brokers) combine into unified workspaces. AI interacts with UTAs, never with brokers directly
- **Trading-as-Git** — stage orders, commit with a message, push to execute. Full history reviewable with commit hashes
- **Guard pipeline** — pre-execution safety checks (max position size, cooldown, symbol whitelist) per account
- **Account snapshots** — periodic and event-driven state capture with equity curve visualization

### Research & Analysis

- **Market data** — equity, crypto, commodity, currency, and macro data, **zero API keys out of the box**: low-frequency boards and datasets are served by the hosted **TraderHub** (https://traderhub.ai) while direct providers can be configured as fallbacks
- **Fundamental research** — company profiles, financial statements, ratios, analyst estimates, earnings calendar, insider trading, and market movers. Currently deepest for equities, expanding to other asset classes
- **News** — background RSS collection with archive search

### Automation

Automation has two layers in OpenAlice. They're worth separating because each evolves on its own track:

**Scheduling — *what* fires an AI call.** A typed append-only event log + cron engine that emits events on a schedule. Stable, reusable across both old and new execution models.

- **Cron scheduling** — cron expressions, intervals, or one-shot timestamps
- **Webhooks** — inbound event triggers from external systems (planned)

**Execution — *how* the trigger lands.** A fired schedule runs a **headless Workspace** — the same Workspace substrate, spawned non-interactively against the agent and prompt the job names. The model works inside the workspace, can use MCP tools, and reports back through the Inbox.

### Interface

- **Web UI** — workspace chat, the Inbox, a portfolio dashboard with equity curve, and full config management
- **Workspace** — a per-task directory + git repo + persistent terminal session running your chosen agent CLI (`claude` / `codex` / `opencode` / `pi` / `shell`) with OpenAlice's MCP tools plumbed in
- **Inbox** — workspace-to-user push channel. Agents call `inbox_push` from inside a workspace to surface a document (rendered live) plus a markdown comment in a dedicated tab; click the reply button to jump back into the originating workspace
- **MCP server** — tool exposure for external agents

### And More!

- **Multi-provider AI** — the model runs in the native agent CLI; bring any provider via the credential vault (Anthropic, OpenAI, Google, GLM, MiniMax, Kimi, DeepSeek, local/self-hosted OpenAI-compatible backends, …) or your CLI's own subscription login
- **Evolution mode** — permission escalation that gives Alice full project access including Bash, enabling self-modification


## Architecture

OpenAlice splits into **two long-lived processes** managed by a thin
supervisor:

```mermaid
graph TB
  subgraph Surfaces["Surfaces — where users interact"]
    WEB[Web UI]
    INB[Inbox tab]
    MCPS[MCP Server]
  end

  subgraph Workspace["Workspace — agent's home<br/>(dir + git + native CLI)"]
    WCLI[claude / codex / opencode<br/>pi / shell session]
  end

  subgraph Alice["Alice process — agent runtime + research"]
    subgraph Core["Core — orchestration"]
      TC[ToolCenter<br/>+ Workspace ToolCenter]
      IS[InboxStore]
      CV[Credential vault<br/>injected into workspaces]
    end
    subgraph AliceDomain["Domain — Alice-side"]
      MD[Market Data]
      AN[Analysis]
      NC[News]
    end
    SDK[UTA SDK<br/>HTTP client]
  end

  subgraph UTA["UTA service — broker carrier"]
    TG2[Trading Git]
    GD[Guards]
    BK[Brokers]
    FX[FX + Snapshots]
  end

  subgraph Sched["Scheduling — what fires"]
    CRON[Cron / Webhook]
  end

  CRON -.spawns headless run.-> Workspace

  WEB --> Workspace
  WEB --> INB
  SDK -.HTTP.-> UTA

  Workspace -->|.mcp.json| MCPS
  MCPS --> TC
  TC --> AliceDomain
  TC --> SDK
  Workspace -.inbox_push.-> IS
  IS --> INB
```

**Alice process** holds the agent runtime, research domain (market data,
analysis, news), workspace launcher, and all user-facing surfaces. Alice
**does not** hold broker credentials and does not talk to exchanges
directly. It owns the *deciding* — what to research, when to act, what
to say.

**UTA service** owns the broker connections, the git-like trading state
machine, guards, FX, and snapshot scheduling. AI tools and the
frontend reach it through a thin HTTP SDK — `ctx.utaManager.placeOrder()`
on the Alice side becomes a typed request to the UTA process. UTA owns
the *doing* — order construction, execution, state.

Today the two run on the same host (Docker container or `pnpm dev` on
your laptop) under a Guardian supervisor; tomorrow the UTA service is
designed to detach: run UTA on a phone, a home-network always-on box,
or any device you actually trust with your broker keys, while Alice
sits on a VPS, your desktop, or wherever's convenient. Same wire
protocol either way. The shape echoes a hardware wallet — the
credential-holding half is small, isolated, and stays put; the rich
client half can live wherever you want.

**Surfaces** — Web UI (workspace chat, the Inbox tab, portfolio
dashboards) and the MCP Server for external agents. Where users see
and steer Alice.

**Workspace** — A per-task directory + git repo + persistent terminal
session running a native agent CLI. The recommended substrate for
non-trivial AI work. Wired to OpenAlice via two MCP servers in
`.mcp.json`: a global one (full tool catalog) and a per-workspace one
(workspace-scoped tools like `inbox_push`, with the wsId carried in the
URL path so the agent never traffics its own identity).

**Core (Alice)** — ToolCenter is the shared registry for global tools;
WorkspaceToolCenter holds per-workspace tool factories. The central
credential vault (api-key credentials, injected into workspaces by
template) lives here too. InboxStore is an append-only JSONL behind the
Inbox tab — the single push surface back to the user. There is no
in-process model loop: the model runs inside the native workspace CLI,
and scheduled runs spawn a headless Workspace.

**Alice-side Domain** — Market Data, Analysis, and News. Each module is
exposed to AI through tool registrations and never touches broker code.

**UTA service (carrier)** — Owns the IBroker implementations (CCXT,
Alpaca, Interactive Brokers, Longbridge, MockBroker), the
Trading-as-Git state machine, guards, FxService, the snapshot scheduler,
and the broker catalog refresh loop. Binds `127.0.0.1` only — only the
co-located Alice process talks to it. v1 ships co-located; subsequent
versions support running UTA on a separate host or device entirely.

**Guardian** — The supervisor that brings the two processes up in
order, gates Alice's boot on UTA's `/__uta/health`, and respawns UTA
when broker config changes (it watches a control flag the UI writes
through Alice's BFF, so config updates don't require restarting Alice).
Same module is used by `pnpm dev` (orchestrator with Vite) and the
Docker entrypoint (with `tini` as PID 1).

**Scheduling** — The cron engine (and webhook ingest) fire events on a
schedule. A fired cron job runs a **headless Workspace**: it spawns the
job's named agent non-interactively against the prompt, the agent does
the work and reports back through the Inbox (dotted line), and the run is
visible in the Runs tab. Execution is workspace-resident — one substrate,
whether a human or a schedule opened the Workspace.

## Key Concepts

**UTA (Unified Trading Account)** — The core trading abstraction. Each
UTA wraps a broker connection, operation history, guard pipeline, and
snapshot scheduler into a single self-contained account. AI and the
frontend interact with UTAs exclusively — brokers are internal
implementation details. Multiple UTAs work like independent
repositories: one for Alpaca US equities, one for Bybit crypto, each
with its own history and guards. UTAs live inside the **UTA service**
(see Architecture above) rather than in the Alice process — broker
credentials are isolated to that carrier and never visible to the
agent runtime that drives trading decisions.

**Trading-as-Git** — The workflow inside each UTA. Stage orders, commit with a message, then push to execute. Push runs guards, dispatches to the broker, snapshots account state, and records a full audit trail.

**Guard** — A pre-execution safety check that runs inside a UTA before orders reach the broker. Guards enforce limits (max position size, cooldown between trades, symbol whitelist) and are configured per account.

**Scheduled run** — A cron job (cron expression / interval / one-shot) that, when it fires, spawns a **headless Workspace**: the job names an agent + a prompt, the agent runs non-interactively in the same substrate as a human-opened workspace, and it can report back through the Inbox.

**AI Provider** — Alice runs no model in-process; the model loop lives inside the native workspace CLI (Claude Code / Codex / opencode / Pi). What Alice keeps is a **credential vault**: api-key credentials + their protocol shapes, injected into workspaces so the selected CLI can talk to the chosen model endpoint.

**Data Hub (TraderHub)** — The hosted low-frequency data source. Market boards (macro, movers, calendars, global macro, Fed, shipping, term structure, sector rotation) and keyed datasets (FRED / ECB / BIS / IMF / SEC / World Bank / OECD / CFTC / ICE / NY Fed / BLS / EIA / BEA …) flow from TraderHub; direct providers can be configured as fallbacks.

**Workspace** — A directory + git repo + persistent terminal session running a native agent CLI (`claude`, `codex`, `opencode`, `pi`, or `shell`) of your choice. OpenAlice plumbs its MCP servers, workspace tools, and credentials into that environment.

**Templates & satellite repos** — A workspace template is a bootstrap script + initial file set that materializes a workspace of a particular shape (today: `chat`, `auto-quant`). Templates are distributed as capability extensions, not as `src/` dependencies.

**Inbox** — Workspace-to-user push channel. Agents working inside a workspace call the `inbox_push` MCP tool to surface docs (rendered live from workspace files) plus markdown commentary in a dedicated tab.

## Workspace chat

Chatting with Alice happens inside a **workspace**: a directory + git repo + a persistent terminal session running the native CLI of your chosen agent (`claude`, `codex`, `opencode`, `pi`, or `shell`).

- **Native prompt cache.** Claude Code, Codex, and the other agent CLIs implement vendor-specific cache control we can't replicate. On a long conversation this is often a 10× cost reduction.
- **Native frontend.** TUI rendering, syntax highlighting, diff display — the CLI vendor has already tuned these for their model.
- **Full tool surface.** The CLI sees the workspace's local files plus OpenAlice's MCP tools (trading, market data, news, analysis). No "greatest-common-denominator" trimming.
- **No protocol shim.** Nothing sits between you and the model — whatever the CLI can do, you can do.

The only requirement: the CLI binary has to be installed on the host running OpenAlice (the Docker image bundles `claude` and `codex`).

## Quick Start

> **Heads up:** there's no native installer yet. To try OpenAlice today you
> clone the repo and run it from source — this section is the contributor /
> early-adopter path. A DMG (macOS) + Windows installer are in flight; once
> they ship, the steps below collapse to "download, open, done."

### 0. Tools you need

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js 22+** | Runs the backend | [nodejs.org](https://nodejs.org/) · `brew install node` · `nvm install 22` |
| **pnpm 10+** | Workspace package manager | `npm install -g pnpm` · [pnpm.io/installation](https://pnpm.io/installation) |
| **git** | Clone the repo | Usually already installed. If not: [git-scm.com](https://git-scm.com/) |
| **Claude Code CLI** | The default agent CLI that powers Workspace chats | [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code), then run `claude` once to log in with your Claude Pro/Max or API account |

Windows additionally needs a POSIX shell — see [Windows](#windows) below.

Sanity check:

```bash
node --version    # v22.x.x
pnpm --version    # 10.x.x or newer
claude --version  # 2.x.x (Claude Code 2.x)
```

### 1. Clone and install dependencies

```bash
git clone https://github.com/DocwatZ/OpenAlice.git
cd OpenAlice
pnpm install
```

First-time `pnpm install` pulls the full monorepo + native deps (notably
`node-pty` for terminal sessions). On a normal connection allow ~1 minute.

> pnpm may print *"Ignored build scripts: ccxt, esbuild, protobufjs"* — this
> is fine, those are optional native optimizations and OpenAlice doesn't need
> them. You can run `pnpm approve-builds` later if you want to opt in.

### 2. Start it

```bash
pnpm dev
```

The first lines of output are the three URLs the dev orchestrator picked:

```text
[dev] backend  →  http://localhost:47331
[dev] MCP      →  http://localhost:47332/mcp
[dev] UI       →  http://localhost:5173  (Vite picks +1 if taken)
```

Below that you'll see backend startup logs (brokers connecting, news feeds
fetching, plugins starting). When you see

```text
engine: started
web plugin listening on http://localhost:47331
```

…the backend is ready.

> You may also see a warning *"serveStatic: root path '.../ui/dist' is not
> found"* — that's expected in dev mode (the UI is served by Vite on 5173, not
> by the backend). Ignore it. The warning goes away after `pnpm build` if you
> ever switch to production mode.

### 3. Open the UI

Open the **UI** URL the terminal printed — by default
[http://localhost:5173](http://localhost:5173). Don't open the backend port
(47331) directly in dev mode; that path serves only the pre-built UI bundle,
which doesn't exist yet on a fresh checkout.

If port 5173 is busy, Vite auto-picks 5174 (or higher) and prints the actual
URL in the terminal — always trust the terminal output over the number in
this README.

You should see Alice's sidebar (Inbox / Workspaces / Chat / Market / News).
Click **Chat** and start typing — no API keys, no config files to edit. It
uses your local Claude Code login.

### 4. When things go wrong

| Symptom | Most likely cause + fix |
| --- | --- |
| `claude: command not found` during startup | Claude Code CLI isn't installed or isn't on PATH. Revisit Step 0. |
| Backend logs `Please log in to Claude` | Claude Code session expired. Run `claude` once in any terminal to re-authenticate, then restart `pnpm dev`. |
| Browser shows *"can't connect"* on 5173 | The backend is still booting. Wait for `engine: started`, then refresh. |
| Browser loads but everything says *"disconnected"* | The WebSocket can't reach the backend. Check the terminal — backend probably exited; restart `pnpm dev`. |
| Port 5173 / 47331 already in use | Vite and the orchestrator both auto-bump to the next free port. Read the URL the terminal actually printed, not the number in this README. |
| `pnpm: command not found` | Run `npm install -g pnpm` to install it globally. |

Still stuck → see [Getting Help](#getting-help).

### Windows

OpenAlice's Workspace feature spawns bash-based bootstrap scripts to materialize new workspaces, so a POSIX shell environment is required:

- **Recommended:** install [Git for Windows](https://gitforwindows.org/) and accept the default *"Use Git from the Windows Command Prompt"* option during setup — this puts `bash` plus the POSIX userland OpenAlice relies on (`sed`, `cp`, `mkdir`, `basename`, `printf`, `source`, `[[ ]]`, …) on PATH.
- **Alternative:** run OpenAlice from inside [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) — the Linux env handles everything natively.

Native `cmd.exe` / PowerShell alone are not supported (no `bash`, no POSIX utilities). If `bash` isn't on PATH when you create a workspace, the bootstrap fails with an inline hint pointing back here.

Note: we don't currently dogfood OpenAlice on Windows, so the broader experience (PTY rendering, file watching, paths with spaces) may have rough edges. Bug reports very welcome.

## Unraid Setup Guide

If you want a simple always-on self-hosted deployment, Unraid is one of the easiest places to run OpenAlice.

### What this setup gives you

- OpenAlice running as a persistent Docker container on Unraid
- Data stored under `/mnt/user/appdata/openalice`
- Optional local/self-hosted AI via Ollama, LM Studio, vLLM, LiteLLM, or LocalAI
- Access from your LAN, Tailscale, or reverse proxy
- A clean path to keep broker secrets and AI config on your own hardware

### Before you begin

You should have:

- An Unraid server with Docker enabled
- A persistent appdata share, typically `/mnt/user/appdata`
- Basic access to the Unraid terminal or SSH
- At least one AI runtime plan:
  - **Claude/Codex subscription login** inside the container, or
  - **local/self-hosted model** via Ollama / LM Studio / vLLM / LiteLLM / LocalAI

### Option A — easiest path: Docker Compose on Unraid

1. Create an appdata folder:

```bash
mkdir -p /mnt/user/appdata/openalice
```

2. Save a compose file at:

```text
/mnt/user/appdata/openalice/docker-compose.yml
```

3. Use this compose file:

```yaml
services:
  openalice:
    image: openalice:local
    build: /mnt/user/appdata/openalice/OpenAlice
    container_name: openalice
    restart: unless-stopped
    ports:
      - "47331:47331"
    volumes:
      - /mnt/user/appdata/openalice:/data
    stdin_open: true
    tty: true
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

4. Clone the repo onto the Unraid box:

```bash
cd /mnt/user/appdata/openalice
git clone https://github.com/DocwatZ/OpenAlice.git
```

5. Start OpenAlice:

```bash
docker compose -f /mnt/user/appdata/openalice/docker-compose.yml up -d --build
```

6. Open the UI in your browser:

```text
http://<your-unraid-ip>:47331
```

7. Get the first-run admin token from logs:

```bash
docker logs openalice 2>&1 | grep -A1 'admin token'
```

8. Paste that token into the login screen.

### Option B — Unraid Community Applications / Add Container

If you prefer the Unraid GUI:

- **Name:** `openalice`
- **Repository:** `ghcr.io/traderalice/openalice:latest` if you want the upstream image, or build locally from the repo if you're using this fork's changes
- **Port mapping:** `47331:47331`
- **Path `/data`:** `/mnt/user/appdata/openalice`
- **TTY:** enabled
- **STDIN open:** enabled
- **Timezone:** your timezone

If you're using the GUI-only path with the upstream image, you can still add the local/self-hosted env vars documented below.

### First login and agent authentication

OpenAlice can run with subscription-backed CLIs or local/self-hosted model credentials.

#### If you want Claude Code workspaces

Authenticate once inside the container:

```bash
docker exec -it openalice claude
```

Follow the OAuth URL in your browser and paste the code back into the terminal.

#### If you want Codex workspaces

```bash
docker exec -it openalice codex login
```

#### If you want fully local/self-hosted workspaces

You do **not** need Claude or Codex login for `opencode` or `pi` workspaces when using a local/self-hosted OpenAI-compatible endpoint.

## Local LLM / Self-hosted support added in this fork

This fork adds a much smoother path for running OpenAlice against local or self-hosted models.

### What changed

Instead of requiring all AI access to come from Claude Code or Codex login flows, this fork can now bootstrap a reusable OpenAI-compatible credential directly from environment variables at container startup.

That means you can point OpenAlice at:

- **Ollama**
- **LM Studio**
- **vLLM**
- **LiteLLM Proxy**
- **LocalAI**
- **OpenRouter**
- Any other **OpenAI-compatible** endpoint via `OPENAI_BASE_URL`

### How it works

On startup, OpenAlice checks environment variables like:

- `LLM_PROVIDER`
- `OLLAMA_BASE_URL`
- `LMSTUDIO_BASE_URL`
- `VLLM_BASE_URL`
- `LITELLM_BASE_URL`
- `LOCALAI_BASE_URL`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `MODEL_NAME`
- `FALLBACK_MODEL`

If one of those provider configs is present, it auto-seeds a credential in the AI Provider vault with the slug:

```text
env-local-llm
```

That credential is refreshed on every boot, so changing the container environment and restarting OpenAlice updates the credential automatically.

### Why this matters

This removes a lot of friction for self-hosters:

- no manual credential creation for the common local-LLM case
- no copying API endpoints into every workspace
- easy Docker/Unraid deployment through env vars alone
- works cleanly with service names in Docker Compose or `host.docker.internal`
- lets OpenAlice stay self-hosted end-to-end for users who do not want cloud inference

### Important runtime limitation

Local/self-hosted providers are wired as **OpenAI Chat Completions** (`openai-chat`).

That means:

- **Supported workspace agents:** `opencode`, `pi`
- **Not supported for this path:** `claude`, `codex`

Why:

- `claude` expects Anthropic-style flows
- `codex` expects OpenAI Responses API flows
- Local endpoints like Ollama / LM Studio / vLLM / LocalAI are typically exposed as **OpenAI-compatible chat** endpoints

So when using local/self-hosted AI, create workspaces with **opencode** or **pi**.

### Built-in local/self-hosted provider presets

This fork also includes first-class provider presets in the AI Provider catalog for:

- Ollama
- LM Studio
- vLLM
- LiteLLM Proxy
- LocalAI
- OpenRouter
- Custom OpenAI-compatible endpoints

These presets provide sensible defaults, example base URLs, and model hints for both Docker-hosted and bare-metal setups.

### Docker networking behavior

For local/self-hosted providers, this fork is designed to work in the common deployment topologies:

- **Service in same Compose stack:** use the Docker service name, e.g. `http://ollama:11434`
- **Service on the Unraid host:** use `http://host.docker.internal:<port>`
- **Arbitrary OpenAI-compatible proxy:** use `OPENAI_BASE_URL`

Several providers auto-normalize the URL and append `/v1` where needed.

## Unraid local model recipes

### Recipe 1 — Ollama running directly on the Unraid host

Add these environment variables to the `openalice` container:

```yaml
environment:
  LLM_PROVIDER: "ollama"
  OLLAMA_BASE_URL: "http://host.docker.internal:11434"
  MODEL_NAME: "llama3.2"
```

Then restart the container.

After boot:

- go to **Settings → AI Providers**
- confirm `env-local-llm` exists
- create a workspace
- choose **opencode** or **pi** as the agent
- select the `env-local-llm` credential

### Recipe 2 — Ollama in the same compose stack

```yaml
services:
  openalice:
    image: openalice:local
    build: /mnt/user/appdata/openalice/OpenAlice
    container_name: openalice
    restart: unless-stopped
    ports:
      - "47331:47331"
    volumes:
      - /mnt/user/appdata/openalice:/data
    stdin_open: true
    tty: true
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      LLM_PROVIDER: "ollama"
      OLLAMA_BASE_URL: "http://ollama:11434"
      MODEL_NAME: "llama3.2"

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    ports:
      - "11434:11434"
    volumes:
      - /mnt/user/appdata/ollama:/root/.ollama
```

Bring it up:

```bash
docker compose -f /mnt/user/appdata/openalice/docker-compose.yml up -d --build
```

Pull a model:

```bash
docker exec -it ollama ollama pull llama3.2
```

### Recipe 3 — LM Studio on another machine on your LAN

If LM Studio is running on your desktop and exposes its server on port 1234:

```yaml
environment:
  LLM_PROVIDER: "lmstudio"
  LMSTUDIO_BASE_URL: "http://192.168.1.50:1234"
  MODEL_NAME: "local-model"
```

Make sure the Unraid container can reach that IP.

### Recipe 4 — vLLM in Docker

```yaml
environment:
  LLM_PROVIDER: "vllm"
  VLLM_BASE_URL: "http://vllm:8000"
  MODEL_NAME: "meta-llama/Meta-Llama-3-8B-Instruct"
```

### Recipe 5 — generic OpenAI-compatible endpoint

If you're running another proxy or gateway:

```yaml
environment:
  OPENAI_BASE_URL: "http://my-gateway:8080/v1"
  OPENAI_API_KEY: "optional-or-required-key"
  MODEL_NAME: "my-model"
```

This is the most flexible path if your backend is not one of the named providers.

## Recommended Unraid storage layout

Use persistent storage like this:

```text
/mnt/user/appdata/openalice/
├── data/
│   ├── config/
│   ├── sessions/
│   ├── trading/
│   └── control/
├── home/
│   ├── .claude/
│   └── .codex/
└── workspaces/
```

Important:

- back up `/mnt/user/appdata/openalice/data/config/`
- this contains AI credentials, broker settings, and runtime config
- if you use Claude/Codex login, preserve the `home/` subtree too

## Recommended network exposure for Unraid

Best to worst:

1. **Tailscale / private VPN**
2. **LAN only**
3. **Reverse proxy with HTTPS and additional auth**
4. **Direct public exposure** only if you truly understand the risk

If you reverse proxy OpenAlice, also set:

```bash
OPENALICE_TRUSTED_PROXIES=127.0.0.1
```

Adjust the IP to match the proxy as seen by the container.

## Unraid troubleshooting

### `env-local-llm` does not appear

Check:

- the container actually has the env vars set
- you restarted the container after editing them
- container logs contain `[env-bootstrap]`

Useful command:

```bash
docker logs openalice --tail 200
```

### Local model works from host but not from container

Usually this is networking.

Try:

- `http://host.docker.internal:<port>` for services on the Unraid host
- service name like `http://ollama:11434` for same-stack containers
- direct LAN IP for services on another machine

### Workspace opens but model calls fail

Most common cause: wrong agent selection.

For local/self-hosted AI, use:

- `opencode`, or
- `pi`

Do not use `claude` or `codex` for Ollama/LM Studio/vLLM-style chat endpoints.

### Container starts but UI is unreachable

Check:

```bash
docker logs openalice --tail 100
docker ps
```

Also confirm port `47331` is not already used by another app.

## Authentication

OpenAlice has a single admin-token gate at the web boundary. Three modes,
keyed off whether the bound interface is loopback:

**Local dev** (`pnpm dev`) — zero friction. Requests from `127.0.0.1` /
`::1` skip the gate entirely. You won't see a login screen and don't need
to know auth exists. This passthrough is disabled if you set
`OPENALICE_TRUSTED_PROXIES` (because with a proxy in front, every request
looks like localhost to Alice — trusting it would let the public in).

**Server / Docker / LAN-exposed** — a 256-bit admin token is generated on
first boot and printed **once** to stdout. Grab it, paste it into the
login screen on first browser visit, the session cookie lasts 7 days.

```bash
# Find the token from your container or process logs:
docker logs openalice 2>&1 | grep -A1 'admin token'
```

**Rotate the token** — delete `~/.openalice/data/config/auth.json` (in
Docker: `<volume>/data/config/auth.json`) and restart. The
next boot prints a fresh token and revokes all existing sessions.

**Escape hatch** — `OPENALICE_DISABLE_AUTH=1` turns the gate off. Only
do this when something else guarantees the boundary (Tailscale ACL, VPN,
reverse-proxy auth). Refusing to start with `bind=0.0.0.0` and no token
is the default; this env flag is the explicit opt-out.

What the gate covers: every `/api/*` route, the workspace PTY WebSocket,
and CSRF (cross-origin mutations are 403'd via Origin allowlist). The
React bundle itself is public — otherwise the login page couldn't load.

## Run on a server (Docker)

For self-hosting on a VPS or always-on box. The image bundles `claude` and
`codex` CLIs — no host install needed.

```bash
git clone https://github.com/DocwatZ/OpenAlice.git
cd OpenAlice
docker compose up -d --build
```

First-time auth (one-shot — credentials persist in the data volume so the
container can be rebuilt without losing them):

```bash
docker exec -it openalice claude        # OAuth: paste URL into any browser
docker exec -it openalice codex login   # same dance for codex
```

Then open `http://<your-server>:47331` in a browser. You'll hit the
admin-token login screen — see [Authentication](#authentication) above
for how to retrieve the first-run token from `docker logs`.

**Notes**

- All state — config, workspaces, claude/codex credentials, logs — lives in
  the `openalice-data` named volume. `docker compose down -v` is the
  factory reset.
- Already have claude/codex auth on the host? Skip the `docker exec` step
  by uncommenting the bind-mount lines in `docker-compose.yml` to reuse
  your local `~/.claude` and `~/.codex`.
- The MCP server (port 47332) is intentionally **not** exposed externally;
  it's consumed by the CLIs running inside the container only.
- The base image is `node:22-trixie-slim` (Debian 13) because several
  native deps (notably `longbridge`) ship glibc 2.39 binaries that older
  Debians don't have, and workspace bootstrap scripts need `bash` + POSIX
  utils. Alpine doesn't qualify on either count (musl libc, no bash).

## Remote access (Tailscale / LAN / reverse proxy)

Once the bind + admin token basics are in place, OpenAlice works over
any network path. Ordered from most to least recommended:

**Tailscale / VPN / LAN — direct.** Bind a non-loopback interface and
log in with the admin token. No origin configuration needed: the UI,
the API, and the workspace PTY WebSocket all accept same-origin
requests regardless of which host you reached them through — a LAN IP,
a Tailscale IP, a MagicDNS name.

```bash
OPENALICE_BIND_HOST=0.0.0.0 node dist/main.js   # the Docker image already binds 0.0.0.0
```

Then open `http://<machine-ip-or-tailnet-name>:47331` and paste the
admin token. Tailscale Serve also works (and gives you HTTPS for free) —
point it at `127.0.0.1:47331` and you don't even need to change the bind.

**Reverse proxy (Caddy / nginx) — for HTTPS or a domain.** Terminate
TLS at the proxy and tell Alice which peer to trust:

```bash
OPENALICE_TRUSTED_PROXIES=127.0.0.1   # the proxy's IP, as Alice sees it
```

Two things to know:

- Setting `OPENALICE_TRUSTED_PROXIES` disables the localhost bypass —
  required, since every request now arrives from the proxy's IP. It also
  makes Alice honor `X-Forwarded-Proto` / `X-Forwarded-For` from that
  peer (and only that peer).
- The proxy must pass through `Host`, the WebSocket `Upgrade` headers,
  and `X-Forwarded-Proto` (so the session cookie is marked `Secure`).
  Caddy's `reverse_proxy` does all three out of the box. For nginx:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:47331;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
  ```

**Public internet.** Mechanically the same as the reverse-proxy setup,
but think twice: this is a trading workbench holding broker
credentials. Prefer keeping it inside a tailnet/VPN; if you do expose
it, HTTPS is non-negotiable and proxy-level auth (basic auth, OAuth
proxy, client certs) in front of Alice's own token gate is worth the
extra step.

**Cross-origin topologies** (UI served from a different origin than the
backend — none of the setups above need this): allowlist the UI's
origin explicitly with `WEB_TERMINAL_ALLOWED_ORIGINS=<origin>[,…]` for
the PTY WebSocket and `OPENALICE_CSRF_TRUSTED_ORIGINS=<origin>[,…]` for
mutating API calls.

## Configuration

All config lives in `~/.openalice/data/config/` as JSON files with Zod validation — one global store shared by dev checkouts and the desktop app (the `OPENALICE_HOME` env var overrides the root; Docker uses the mounted volume). Missing files fall back to sensible defaults. You can edit these files directly or use the Web UI — except `accounts.json`, which is sealed (encrypted at rest) and managed through the UI.

**AI Provider** — The model runs inside the workspace CLI using its own login — e.g. your local Claude Code or Codex login, no API key needed. For api-key providers (Anthropic, OpenAI, Google, GLM, MiniMax, Kimi, DeepSeek, local/self-hosted OpenAI-compatible backends, …), add credentials in the Web UI's **AI Provider** vault; each credential declares the wire shapes it speaks and gets injected into workspaces, picking the shape the target agent uses. Subscription logins stay in the CLI.

### Local/self-hosted AI credential bootstrap

For Docker and Unraid users, this fork can auto-create a vault credential from environment variables.

Supported auto-bootstrap inputs:

- `LLM_PROVIDER=ollama|lmstudio|vllm|litellm|localai|openrouter`
- `OLLAMA_BASE_URL`
- `LMSTUDIO_BASE_URL`
- `VLLM_BASE_URL`
- `LITELLM_BASE_URL`
- `LOCALAI_BASE_URL`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `MODEL_NAME`
- `FALLBACK_MODEL`

Behavior:

- On startup, OpenAlice resolves the endpoint and writes a credential named `env-local-llm`
- The credential uses the `openai-chat` wire shape
- If the env vars change, restart the container and the credential is refreshed
- If no relevant env vars are set, nothing is created
- For providers that do not require a key, the vault stores a placeholder value so the schema remains valid

This is the recommended setup path for Ollama, LM Studio, vLLM, LiteLLM, LocalAI, OpenRouter, and custom OpenAI-compatible gateways in self-hosted deployments.

**Trading** — Unified Trading Account (UTA) architecture. Each account in `accounts.json` becomes a UTA with its own broker connection, git history, and guard config. Broker-specific settings live in the `brokerConfig` field — each broker type declares its own schema and validates it internally.

| File | Purpose |
|------|---------|
| `engine.json` | Trading pairs, tick interval, timeframe |
| `agent.json` | Max agent steps, evolution mode toggle, Claude Code tool permissions |
| `ai-provider.json` | Central credential vault — api-key credentials + their wire capabilities, injected into workspaces |
| `accounts.json` | Trading accounts with `type`, `enabled`, `guards`, and `brokerConfig` |
| `connectors.json` | Web/MCP server ports |
| `web-subchannels.json` | Web UI chat sub-channel definitions (per-channel system prompt + disabled-tools overrides) |
| `tools.json` | Tool enable/disable configuration |
| `market-data.json` | Data Hub (`enabled` / `baseUrl`), per-asset-class vendors, provider API keys (fallback when the hub is off or uncovered) |
| `news.json` | RSS feeds, fetch interval, retention period |
| `snapshot.json` | Account snapshot interval and retention |
| `trading.json` | Trading-engine knobs — external-order observation cadence (`observeExternalOrdersEvery`, default `15m`, `off` to disable) |
| `compaction.json` | Context window limits, auto-compaction thresholds |

The persona prompt uses a **default + user override** pattern:

| Default (git-tracked) | User override |
|------------------------|---------------------------|
| `default/persona.default.md` | `~/.openalice/data/brain/persona.md` |

On first run, defaults are auto-copied to the user override path. Edit the user files to customize without touching version control.

## Project Structure

OpenAlice is a pnpm monorepo with Turborepo build orchestration. See [docs/project-structure.md](docs/project-structure.md) for the full file tree.

## Getting Help

Stuck? Here's the recommended path, roughly in order:

1. **Let an AI agent fix it** — Claude Code, Cursor, or any other coding agent can read the codebase and patch most issues directly. Fastest path for bugs and "how do I do X" questions
2. **[Ask DeepWiki](https://deepwiki.com/TraderAlice/OpenAlice)** — natural-language Q&A over the entire codebase, good for architectural questions and figuring out where to look
3. **Community** — [Discord](https://discord.gg/zf4STmrQd8) for English speakers, [QQ 群](https://qm.qq.com/q/iSg6O4FmrC) for 中文开发者. For things AI can't answer — design discussions, roadmap, bug reports, trading integrations

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=TraderAlice/OpenAlice&type=Date)](https://star-history.com/#TraderAlice/OpenAlice&Date)

## License

[AGPL-3.0](LICENSE)
