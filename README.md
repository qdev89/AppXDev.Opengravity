# 🧠 Opengravity

**Antigravity-Powered AI Gateway** — Turn your Antigravity IDE into a programmable AI engine with REST API, WebSocket streaming, automation, and remote control.

[![Node.js](https://img.shields.io/badge/Node.js-≥18-green)](#prerequisites)
[![License](https://img.shields.io/badge/License-MIT-blue)](#license)
[![Version](https://img.shields.io/badge/Version-3.0.0-purple)](#)

---

## Table of Contents

- [What is Opengravity?](#what-is-opengravity)
- [How It Works](#how-it-works)
- [Quick Start (5 Minutes)](#quick-start-5-minutes)
- [Onboarding Guide for New Users](#onboarding-guide-for-new-users)
- [Configuration Reference](#configuration-reference)
- [Web Dashboard](#web-dashboard)
- [API Reference](#api-reference)
- [Telegram Bot](#telegram-bot)
- [Automation](#automation)
- [Remote Instances](#remote-instances)
- [Security](#security)
- [Architecture Deep Dive](#architecture-deep-dive)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## What is Opengravity?

Opengravity wraps **Antigravity IDE** (an AI coding assistant built on Claude/Gemini) with a gateway layer that exposes it as an API-driven service. Instead of sitting at your desk typing prompts, you can:

| Feature | Description |
|---------|-------------|
| 🔌 **REST API** | Send prompts programmatically from any language |
| 📡 **WebSocket Streaming** | Real-time agent activity feed |
| 🤖 **Auto-Accept** | Automatically approve confirmation dialogs |
| ⏰ **Cron Scheduler** | Schedule recurring AI tasks |
| 🔀 **Multi-Instance Router** | Manage multiple workspaces from one gateway |
| 🌐 **Remote Bridges** | Control Antigravity over Tailscale or Firebase relay |
| 📱 **Telegram Bot** | Send prompts and receive notifications from your phone |
| 🖥️ **Web Dashboard** | Beautiful Mission Control UI with health monitoring |
| 📲 **PWA** | Install as native app on phone/tablet |
| 🔐 **JWT Auth** | Token-based API security with zero dependencies |

### Who Is This For?

- **Solo developers** who want to control their AI coding agent remotely
- **Teams** who want to share an AI coding assistant via API
- **Automation enthusiasts** who want scheduled AI code reviews
- **Mobile developers** who want to send coding tasks from their phone

---

## How It Works

```
┌─────────────────── YOUR DEVICES ───────────────────┐
│  📱 Phone (Telegram)                                │
│  💻 Browser (Web Dashboard)                         │
│  🔧 Scripts (REST API / WebSocket)                  │
│  ⏰ Scheduled (Cron Jobs)                            │
└───────────────────────┬────────────────────────────┘
                        │ HTTP / WebSocket
                ┌───────▼────────┐
                │  OPENGRAVITY   │  ← Gateway on port 3000
                │  ┌───────────┐ │
                │  │ Sessions  │ │  Per-workspace state
                │  │ Router    │ │  Smart instance selection
                │  │ Queue     │ │  Priority task queue
                │  │ AutoAccept│ │  Dialog auto-clicker
                │  │ Cron      │ │  Scheduled tasks
                │  │ Auth      │ │  API key + JWT
                │  └───────────┘ │
                └───────┬────────┘
                        │ Chrome DevTools Protocol (CDP)
                ┌───────▼────────┐
                │ ANTIGRAVITY IDE│  ← Your AI coding agent
                │  🧠 Claude     │
                │  📁 Codebase   │
                │  💻 Terminal   │
                │  🌐 Browser    │
                │  🔧 MCP Tools  │
                └────────────────┘
```

**Key insight:** Antigravity IDE is the *brain*. Opengravity is the *nervous system* that connects it to the outside world.

---

## Quick Start (5 Minutes)

### Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org/)
- **Antigravity IDE** — installed and running
- **Git** — for cloning the repo

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/qdev89/AppXDev.Opengravity.git
cd AppXDev.Opengravity

# 2. Install dependencies (only 4!)
npm install

# 3. Copy the config template
cp .env.example .env

# 4. Start Antigravity IDE with remote debugging enabled
#    Add this flag to your Antigravity launch command:
#    --remote-debugging-port=9000

# 5. Start Opengravity
npm start
```

You'll see:

```
  ┌──────────────────────────────────────┐
  │   Opengravity                      🧠  │
  │   Antigravity-Powered AI Gateway       │
  └──────────────────────────────────────┘

🌐 Web viewer: http://localhost:3000
📡 API stream: ws://localhost:3000/api/v1/stream
🤖 Telegram bot: @YourBot connected
```

**Open http://localhost:3000** in your browser — you're in! 🎉

---

## Onboarding Guide for New Users

This step-by-step guide will get you from zero to fully operational.

### Step 1: Enable Antigravity Remote Debugging

Antigravity IDE must expose a **Chrome DevTools Protocol (CDP)** port for Opengravity to connect to it.

#### On Windows

Find your Antigravity shortcut and add the flag to the target:

```
"C:\path\to\Antigravity.exe" --remote-debugging-port=9000
```

Or launch from terminal:

```powershell
& "C:\path\to\Antigravity.exe" --remote-debugging-port=9000
```

#### On macOS

```bash
/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=9000
```

#### On Linux

```bash
antigravity --remote-debugging-port=9000
```

#### Multiple Instances

You can run multiple Antigravity instances on different ports:

```bash
# Instance 1: POSKit project
antigravity --remote-debugging-port=9000 /path/to/poskit

# Instance 2: DevOps project
antigravity --remote-debugging-port=9001 /path/to/devops
```

> **Verify it's working:** Open `http://127.0.0.1:9000/json` in your browser. If you see JSON data, CDP is active.

### Step 2: Install Opengravity

```bash
git clone https://github.com/qdev89/AppXDev.Opengravity.git
cd AppXDev.Opengravity
npm install
```

**Dependencies are minimal** (only 4 packages):
| Package | Purpose |
|---------|---------|
| `express` | Web server + API |
| `ws` | WebSocket (CDP + streaming) |
| `grammy` | Telegram bot |
| `dotenv` | Environment variables |

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Required for basic operation: nothing! Just start it.
# All settings below are optional enhancements.

# ── Telegram Bot (optional) ──
TELEGRAM_BOT_TOKEN=          # Get from @BotFather on Telegram
ALLOWED_USER_IDS=            # Your Telegram user ID (from @userinfobot)

# ── API Security (recommended) ──
API_KEY=your-secret-key-here # Protects /api/v1/* endpoints
API_SECRET=                  # Enables JWT tokens (generate below)

# ── Server ──
PORT=3000                    # Web dashboard port
LOG_LEVEL=info               # debug | info | warn | error

# ── CDP ──
CDP_PORTS=9000,9001,9002,9003  # Which ports to scan for Antigravity
```

**Generate an API_SECRET for JWT:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Configure Instances (Optional)

Edit `opengravity.json` to name your workspaces:

```json
{
  "instances": [
    {
      "name": "poskit",
      "host": "127.0.0.1",
      "port": 9000,
      "workspace": "POSKit",
      "keywords": ["pos", "receipt", "inventory"]
    },
    {
      "name": "blog",
      "host": "127.0.0.1",
      "port": 9001,
      "workspace": "QuocDevBlog",
      "keywords": ["blog", "portfolio"]
    }
  ],
  "defaults": {
    "autoAccept": false,
    "pollInterval": 2000,
    "discoveryInterval": 10000,
    "monitorInterval": 2000,
    "maxQueueSize": 50,
    "port": 3000
  },
  "cdpPorts": [9000, 9001, 9002, 9003],
  "cron": [],
  "telegram": {
    "token": "",
    "allowedUsers": ""
  }
}
```

> **Tip:** If you don't define instances, Opengravity will still auto-discover any Antigravity running on the configured CDP ports.

### Step 5: Launch

```bash
npm start
```

### Step 6: Verify Everything Works

1. **Web Dashboard** — Open http://localhost:3000
   - ✅ You should see the AG Mission Control interface
   - ✅ Bottom-left shows "● Connected" in green
   - ✅ Navigation rail shows icons for Projects, Health, Cron, Remotes

2. **Health Check** — Click the 💚 Health icon in the nav rail
   - ✅ Status shows "✅ OK"
   - ✅ Instance count matches your running Antigravity instances

3. **Send a Test Prompt** — Type in the message box and hit send
   - ✅ The prompt appears in task history
   - ✅ If an Antigravity instance is connected, it starts processing

4. **API Test** (from terminal):
   ```bash
   curl http://localhost:3000/health
   # → {"ok":true,"instances":{"total":1},...}
   ```

### Step 7: Install as PWA (Optional)

The dashboard is a Progressive Web App. To install it:

1. Open http://localhost:3000 in Chrome
2. Click the install icon (⬇️) in the address bar
3. Click "Install"
4. You now have a native-feeling app icon on your desktop/phone

---

## Configuration Reference

### Environment Variables (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | No | _(disabled)_ | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | No | _(all)_ | Comma-separated Telegram user IDs |
| `PORT` | No | `3000` | Web server port |
| `API_KEY` | No | _(disabled)_ | Static API key for `/api/v1/*` endpoints |
| `API_SECRET` | No | _(disabled)_ | JWT signing secret (HMAC-SHA256) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `CDP_PORTS` | No | `9000,9001,9002,9003` | CDP ports to scan |
| `DISCOVERY_INTERVAL` | No | `10000` | How often (ms) to scan for new instances |
| `POLL_INTERVAL` | No | `3000` | How often (ms) to capture HTML snapshots |
| `MONITOR_INTERVAL` | No | `2000` | How often (ms) to check agent phase |

### Instance Config (`opengravity.json`)

```json
{
  "instances": [
    {
      "name": "string",       // Friendly name (used for routing)
      "host": "127.0.0.1",    // IP address
      "port": 9000,           // CDP port
      "workspace": "string",  // Workspace/project name
      "keywords": ["string"]  // Keywords for smart routing
    }
  ],
  "defaults": {
    "autoAccept": false,       // Start with auto-accept enabled?
    "pollInterval": 2000,      // HTML snapshot interval (ms)
    "discoveryInterval": 10000,// Instance scan interval (ms)
    "monitorInterval": 2000,   // Phase monitor interval (ms)
    "maxQueueSize": 50,        // Max queued tasks
    "port": 3000               // Web server port
  },
  "cdpPorts": [9000, 9001, 9002, 9003],
  "cron": [
    {
      "name": "string",       // Job name (unique)
      "schedule": "0 9 * * *", // Cron expression
      "prompt": "string",      // Prompt to send
      "instance": "string",    // Target instance name
      "enabled": true          // Active?
    }
  ],
  "remotes": [
    {
      "name": "string",       // Remote name
      "type": "cdp|firebase",  // Connection type
      "host": "IP",           // For CDP type
      "ports": [9000],        // For CDP type
      "project": "string"     // For Firebase type
    }
  ],
  "telegram": {
    "token": "",               // Bot token (overrides .env)
    "allowedUsers": ""         // Allowed user IDs (overrides .env)
  }
}
```

---

## Web Dashboard

The dashboard is a premium PWA built for real-time monitoring and control.

### Navigation

| Icon | Panel | Description |
|------|-------|-------------|
| 📂 | **Projects** | List connected workspaces, select active one |
| 💚 | **Health** | System metrics grid (8 cards, auto-refresh 10s) |
| ⏰ | **Cron** | View/trigger/toggle scheduled jobs |
| 🌐 | **Remotes** | Remote instance connection status |
| 📋 | **Templates** | Quick prompt templates |
| 📝 | **History** | Task history log |
| ⚙️ | **Settings** | Theme, workspace management |

### Health Dashboard Metrics

| Metric | Description |
|--------|-------------|
| **Status** | ✅ OK / ❌ Down |
| **Instances** | Connected Antigravity instances count |
| **Queue** | Pending / Running tasks |
| **Uptime** | Server uptime |
| **Auto-Accept** | Current mode (off / all / instance) |
| **Cron Jobs** | Active / Total jobs |
| **Remotes** | Connected / Total remotes |
| **Stream Clients** | Active WebSocket connections |

### Toolbar Buttons

| Button | Action |
|--------|--------|
| 🖥️ Idle/Busy | Shows current agent phase |
| 🤖 OFF/ON | Toggle auto-accept mode |
| ⚡ | Toggle theme (light/dark) |
| 📸 | Take IDE screenshot |
| ⚙️ | Open settings panel |
| ⏹️ | Stop current task |

---

## API Reference

All API endpoints are under `/api/v1/`. Authentication is required when `API_KEY` or `API_SECRET` is set.

### Authentication

Three methods supported:

```bash
# Method 1: X-API-Key header
curl -H "X-API-Key: your-key" http://localhost:3000/api/v1/health

# Method 2: Authorization Bearer
curl -H "Authorization: Bearer your-key" http://localhost:3000/api/v1/health

# Method 3: Query parameter
curl "http://localhost:3000/api/v1/health?key=your-key"
```

### JWT Tokens

If `API_SECRET` is set, you can generate JWT tokens:

```bash
# Generate a token (valid 24h)
curl -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"key": "your-api-key", "label": "ci-server"}'

# Response:
# {
#   "ok": true,
#   "token": "eyJhbGciOiJIUzI1NiJ9...",
#   "expiresIn": 86400,
#   "expiresAt": "2026-03-04T15:00:00.000Z"
# }

# Use the token
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..." \
  http://localhost:3000/api/v1/health
```

### Endpoints

#### Core

| Method | Endpoint | Description | Body |
|--------|----------|-------------|------|
| `POST` | `/api/v1/send` | Send prompt to Antigravity | `{prompt, target?, priority?, source?}` |
| `POST` | `/api/v1/stop/:target` | Stop agent on target | — |
| `POST` | `/api/v1/accept/:target` | Accept confirmations | — |
| `GET` | `/api/v1/status` | Gateway status + instances | — |
| `GET` | `/api/v1/routes` | Instance routing table | — |

#### Health & Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Quick health check |
| `GET` | `/api/v1/health` | Full system health report |
| `GET` | `/api/v1/queue` | Queue stats + pending tasks |
| `GET` | `/api/v1/history` | Task execution history (`?limit=20`) |
| `GET` | `/api/v1/sessions` | Active session stats |

#### Auto-Accept

| Method | Endpoint | Description | Body |
|--------|----------|-------------|------|
| `GET` | `/api/v1/auto-accept` | Current mode + stats | — |
| `POST` | `/api/v1/auto-accept/mode` | Set mode | `{mode: "off"|"all"|"instance"}` |
| `POST` | `/api/v1/auto-accept/instance/:id` | Per-instance rule | `{enabled: bool}` |

#### Cron Scheduler

| Method | Endpoint | Description | Body |
|--------|----------|-------------|------|
| `GET` | `/api/v1/cron` | List all jobs | — |
| `POST` | `/api/v1/cron` | Create new job | `{name, schedule, prompt, instance?, enabled?}` |
| `DELETE` | `/api/v1/cron/:name` | Delete a job | — |
| `POST` | `/api/v1/cron/:name/trigger` | Manually trigger | — |
| `PUT` | `/api/v1/cron/:name/enabled` | Enable/disable | `{enabled: bool}` |
| `GET` | `/api/v1/cron/history` | Execution history | `?limit=20` |

#### Remote Instances

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/remotes` | List remotes + status |
| `GET` | `/api/v1/remotes/stats` | Remote bridge statistics |
| `POST` | `/api/v1/remotes/:name/send` | Send prompt to remote |
| `GET` | `/api/v1/remotes/:name/completed` | Get completed results |

#### Authentication

| Method | Endpoint | Description | Body |
|--------|----------|-------------|------|
| `POST` | `/api/v1/auth/token` | Generate JWT token | `{key, expiresIn?, label?}` |

#### WebSocket Streaming

```javascript
const ws = new WebSocket('ws://localhost:3000/api/v1/stream');

ws.onopen = () => {
  // Subscribe to channels
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['phase', 'task', 'instance', 'auto-accept', 'cron', 'queue']
  }));
};

ws.onmessage = (event) => {
  const { channel, data, timestamp } = JSON.parse(event.data);
  console.log(`[${channel}]`, data);
};
```

**Available channels:**

| Channel | Events |
|---------|--------|
| `phase` | Agent phase changes (idle → streaming → complete) |
| `task` | Task created, started, completed, failed |
| `instance` | Instance connected/disconnected |
| `auto-accept` | Confirmation auto-clicked |
| `cron` | Cron job executed |
| `queue` | Queue state changes |

#### Legacy Endpoints (Dashboard-internal)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/cascades` | List CDP cascade targets |
| `POST` | `/workspace/add` | Add new CDP target |
| `GET` | `/workspace/ports` | List scan targets |
| `GET` | `/snapshot/:id` | Get HTML snapshot |
| `GET` | `/styles/:id` | Get captured CSS |
| `POST` | `/send/:id` | Send message (legacy) |
| `GET` | `/screenshot/:id` | Capture screenshot |
| `POST` | `/autoaccept/:id` | Accept confirmations (legacy) |
| `POST` | `/stop/:id` | Stop agent (legacy) |
| `GET` | `/status` | Instance status (legacy) |

---

## Telegram Bot

### Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts to create your bot
3. Copy the token and add it to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABCdefGHIjklMNO
   ```
4. Find your user ID by messaging [@userinfobot](https://t.me/userinfobot)
5. Add your ID to `.env`:
   ```
   ALLOWED_USER_IDS=123456789
   ```
6. Restart Opengravity

### Commands

| Command | Description |
|---------|-------------|
| `/project` | Select which workspace to send prompts to |
| `/status` | Current agent status (phase, title, response) |
| `/screenshot` | Capture and send a screenshot of the IDE |
| `/stop` | Stop the currently running task |
| `/autoaccept` | Toggle auto-accept mode on/off |
| `/probe` | Run DOM diagnostic (for debugging selectors) |
| `/help` | Show command list |
| _any text_ | Send as prompt to the selected workspace |

### Usage Tips

- When you first message the bot, use `/project` to select your workspace
- Send plain text messages as prompts: "Fix the login bug in auth.js"
- You'll get a Telegram notification when the agent completes the task
- Use `/screenshot` to visually check what the agent is doing

---

## Automation

### Auto-Accept Engine

The auto-accept engine automatically clicks confirmation dialogs in Antigravity IDE (like "Accept", "Confirm", "Run", "Yes" buttons).

**Modes:**

| Mode | Behavior |
|------|----------|
| `off` | Manual confirmation only (default) |
| `all` | Auto-accept everything on all instances |
| `instance` | Custom rules per instance |

**Via API:**

```bash
# Enable for all instances
curl -X POST http://localhost:3000/api/v1/auto-accept/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "all"}'

# Check stats
curl http://localhost:3000/api/v1/auto-accept
```

**Via Telegram:**

```
/autoaccept
```

**Via Dashboard:**

Click the 🤖 button in the toolbar to toggle.

### Cron Scheduler

Schedule recurring AI tasks using cron expressions.

**In `opengravity.json`:**

```json
{
  "cron": [
    {
      "name": "morning-review",
      "schedule": "0 9 * * *",
      "prompt": "Review all open PRs and summarize findings",
      "instance": "poskit",
      "enabled": true
    },
    {
      "name": "daily-deps-check",
      "schedule": "0 14 * * 1",
      "prompt": "Check for outdated npm dependencies and security vulnerabilities",
      "instance": "devops",
      "enabled": true
    }
  ]
}
```

**Cron expression reference:**

```
┌───────────── minute (0-59)
│ ┌─────────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌─────── month (1-12)
│ │ │ │ ┌───── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

**Examples:**

| Expression | Description |
|------------|-------------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 9,14 * * *` | At 9:00 AM and 2:00 PM |
| `0 0 * * 0` | Every Sunday at midnight |

**Via API:**

```bash
# Create a job
curl -X POST http://localhost:3000/api/v1/cron \
  -H "Content-Type: application/json" \
  -d '{
    "name": "weekly-audit",
    "schedule": "0 9 * * 1",
    "prompt": "Audit code for security issues",
    "instance": "poskit"
  }'

# Trigger manually
curl -X POST http://localhost:3000/api/v1/cron/weekly-audit/trigger

# Disable
curl -X PUT http://localhost:3000/api/v1/cron/weekly-audit/enabled \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

## Remote Instances

Connect to Antigravity instances running on other machines.

### Via Tailscale (Recommended)

If your machines are on the same [Tailscale](https://tailscale.com/) VPN:

```json
{
  "remotes": [
    {
      "name": "vps-server",
      "type": "cdp",
      "host": "100.97.220.30",
      "ports": [9000, 9001]
    }
  ]
}
```

### Via Firebase Relay

For machines behind NAT without VPN:

```json
{
  "remotes": [
    {
      "name": "cloud-relay",
      "type": "firebase",
      "project": "your-firebase-project"
    }
  ]
}
```

### Remote Health Monitoring

The dashboard's **Remotes** panel shows connection status for all configured remotes. The health monitor pings remotes every 30 seconds.

---

## Security

### API Authentication

| Mode | How to Enable | Best For |
|------|---------------|----------|
| **Open** | Leave `API_KEY` empty | Local dev, testing |
| **Static Key** | Set `API_KEY=your-secret` | Simple, single-user |
| **JWT Tokens** | Set `API_SECRET=your-secret` | Multi-client, CI/CD |
| **Both** | Set both | Maximum flexibility |

### Rate Limiting

Built-in token-bucket rate limiter:
- **Default:** 120 requests per minute per IP
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Window`
- **429 response** with `Retry-After` header when exceeded

### Telegram Access Control

Set `ALLOWED_USER_IDS` to restrict bot access to specific Telegram users:

```bash
# Single user
ALLOWED_USER_IDS=123456789

# Multiple users
ALLOWED_USER_IDS=123456789,987654321
```

### Best Practices

1. **Always set `API_KEY`** in production
2. **Use JWT tokens** for CI/CD integrations (auto-expire)
3. **Restrict Telegram** to your user ID
4. **Run behind a reverse proxy** (nginx) for HTTPS
5. **Don't expose CDP ports** (9000) to the internet

---

## Architecture Deep Dive

### Module Map

```
opengravity/
├── server.js                    # Entry point + lifecycle orchestration
├── opengravity.json             # Runtime configuration
├── .env                         # Environment secrets
├── package.json                 # Dependencies + npm config
│
├── src/
│   ├── gateway/                 # 🧠 The Brain
│   │   ├── index.js             # Gateway orchestrator (event emitter)
│   │   ├── config.js            # Config loader (JSON + .env)
│   │   ├── session.js           # Per-instance conversation state
│   │   ├── router.js            # Smart instance routing (keywords)
│   │   ├── queue.js             # Priority task queue (FIFO)
│   │   └── logger.js            # Scoped leveled logger
│   │
│   ├── cdp/                     # 🔌 Chrome DevTools Protocol
│   │   ├── connection.js        # WebSocket CDP client
│   │   ├── manager.js           # Multi-target discovery + lifecycle
│   │   └── selectors.js         # DOM selector profiles
│   │
│   ├── monitor/                 # 👁️ Activity Monitoring
│   │   └── response.js          # Phase detection (idle/streaming/done)
│   │
│   ├── automation/              # 🤖 Automation Layer
│   │   ├── auto-accept.js       # Confirmation dialog clicker
│   │   └── cron.js              # Recurring task scheduler
│   │
│   ├── api/                     # 🔐 API Layer
│   │   ├── middleware.js        # Auth (API key + JWT) + rate limiting
│   │   └── stream.js            # WebSocket event streaming
│   │
│   ├── distribution/            # 🌐 Distribution Layer
│   │   ├── remote.js            # Remote instance bridge
│   │   └── health.js            # Health endpoint + system report
│   │
│   ├── bot/                     # 📱 Telegram Channel
│   │   └── telegram.js          # Grammy-based bot
│   │
│   └── web/                     # 🖥️ Web Server
│       └── server.js            # Express + WebSocket + all API routes
│
└── public/                      # 🎨 Dashboard Frontend
    ├── index.html               # Single page app
    ├── manifest.json            # PWA manifest
    ├── sw.js                    # Service worker (offline cache)
    ├── css/styles.css           # Full design system
    ├── js/app.js                # Dashboard logic
    └── icons/                   # App icons (SVG)
```

### Startup Sequence

```
server.js main()
│
├── 1. Load config (opengravity.json + .env)
├── 2. Create CDPManager (connects to Antigravity via CDP ports)
├── 3. Create ResponseMonitor (polls DOM for agent phase changes)
├── 4. Create Gateway (sessions, router, queue — the brain)
├── 5. Create AutoAccept (CDP dialog clicker)
├── 6. Create CronScheduler (recurring tasks)
├── 7. Create RemoteBridge (remote instance connections)
├── 8. Attach automation to Gateway (so API routes register)
├── 9. Create WebServer (Express + all routes + WebSocket)
├── 10. Create TelegramBot (Grammy)
├── 11. Create HealthDashboard (health endpoints)
├── 12. Start all subsystems
└── 13. Register graceful shutdown (SIGINT/SIGTERM)
```

### Event Flow

```
User sends "Fix the bug" via Telegram
│
├── TelegramBot.onMessage()
│   └── gateway.send({ prompt: "Fix the bug", source: "telegram" })
│
├── Gateway.send()
│   ├── Router.resolve(target) → Find best Antigravity instance
│   ├── Queue.enqueue(task) → Add to priority queue
│   └── Queue.process() → Execute when slot available
│
├── Gateway._executePrompt()
│   ├── Session.track(cascadeId, prompt)
│   ├── CDPManager.injectMessage(cdp, prompt) → Type into Antigravity
│   └── Emit 'prompt:sent' event
│
├── ResponseMonitor.poll()
│   ├── Detect: idle → streaming → complete
│   └── Emit 'response:streaming', 'response:complete'
│
├── Gateway handles 'response:complete'
│   ├── Queue.completeTask()
│   ├── Emit 'task:complete'
│   └── StreamServer.broadcast({ channel: 'task', data: ... })
│
└── TelegramBot receives task:complete
    └── Send notification: "✅ Task completed on POSKit"
```

---

## Troubleshooting

### Common Issues

#### "No workspaces found"

**Cause:** Antigravity is not running with `--remote-debugging-port` or the port doesn't match.

**Fix:**
1. Start Antigravity with: `--remote-debugging-port=9000`
2. Verify CDP: `curl http://127.0.0.1:9000/json`
3. Check `CDP_PORTS` in `.env` matches your port

#### "API auth DISABLED" warning

**Cause:** No `API_KEY` or `API_SECRET` set — all API routes are open.

**Fix:** Set `API_KEY=your-secret` in `.env`. This is fine for local dev.

#### Telegram bot not connecting

**Cause:** Invalid or missing bot token.

**Fix:**
1. Check `TELEGRAM_BOT_TOKEN` in `.env`
2. Test token: `curl https://api.telegram.org/bot<TOKEN>/getMe`
3. If using `opengravity.json` telegram config, it overrides `.env`

#### Auto-accept not clicking

**Cause:** DOM selectors may not match your Antigravity version.

**Fix:**
1. Use `/probe` in Telegram to check DOM structure
2. Check `src/cdp/selectors.js` for selector patterns
3. Ensure auto-accept is enabled: `curl http://localhost:3000/api/v1/auto-accept`

#### Port already in use

**Cause:** Another instance of Opengravity or another app is using port 3000.

**Fix:**
1. Change `PORT=3001` in `.env`
2. Or kill the existing process: `npx kill-port 3000`

#### WebSocket connection drops

**Cause:** Network interruption or Antigravity restart.

**Fix:** Opengravity auto-reconnects. Check dashboard — it should show "● Connected" after a few seconds.

---

## FAQ

**Q: Does Opengravity replace OpenClaw?**
> Yes, for coding tasks. Opengravity connects directly to Antigravity IDE via CDP, giving you full code context, terminal, browser, and tool access — not just LLM text generation.

**Q: Can I use multiple Antigravity instances?**
> Yes. Start each with a different `--remote-debugging-port` (9000, 9001, etc.) and configure them in `opengravity.json`. Opengravity routes prompts to the right instance based on keywords or explicit targeting.

**Q: Does it work if Antigravity is on another machine?**
> Yes. Use Tailscale VPN for direct CDP connection, or Firebase relay for NAT traversal. Configure under `remotes` in `opengravity.json`.

**Q: What AI models does it support?**
> Whatever Antigravity supports — Claude, Gemini, custom models. Opengravity is model-agnostic; it talks to Antigravity, not directly to LLM APIs.

**Q: Is there a cloud version?**
> Not yet. Opengravity runs locally alongside your Antigravity instances. You can deploy it to a VPS for 24/7 access.

**Q: How many dependencies does it have?**
> Just 4: `express`, `ws`, `grammy`, `dotenv`. Zero-dependency JWT using Node.js native `crypto`.

**Q: Can I use it without Telegram?**
> Absolutely. The web dashboard and REST API work independently. Telegram is optional.

**Q: Is it production-ready?**
> For personal/small-team use, yes. For multi-tenant SaaS, not yet — it's designed for single-user/small-team scenarios.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

### Development Mode

```bash
npm run dev  # Starts with --watch for auto-restart
```

---

## License

MIT © [Quoc Nguyen](https://github.com/qdev89)
