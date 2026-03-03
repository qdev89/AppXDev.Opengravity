# 🧠 Opengravity

**Antigravity-Powered AI Gateway** — Turn your Antigravity IDE into a programmable AI engine with REST API, WebSocket streaming, automation, and remote control.

## What is this?

Opengravity wraps Antigravity IDE (Claude-powered coding assistant) with a gateway layer that exposes it as an API-driven service. Instead of manually typing prompts, you can:

- **Send prompts via REST API** — programmatic access to your AI coding agent
- **Auto-accept confirmations** — no more manually clicking "Confirm" buttons
- **Schedule recurring tasks** — cron jobs that run prompts on a schedule
- **Route to multiple instances** — manage several workspaces from one gateway
- **Connect remote machines** — control Antigravity over Tailscale or Firebase relay
- **Monitor via WebSocket** — real-time streaming of agent activity
- **Control from Telegram** — send prompts and receive notifications from your phone

## Quick Start

```bash
# 1. Clone
git clone https://github.com/AppXDev/Opengravity.git
cd Opengravity

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your settings (TELEGRAM_BOT_TOKEN, API_KEY, etc.)

# 4. Start Antigravity with remote debugging
# Add to Antigravity's launch args:
#   --remote-debugging-port=9000

# 5. Launch
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

## Architecture

```
       Telegram  │  Web Dashboard  │  REST API  │  Cron
            └────────────┬─────────────┘
                    ┌────▼────┐
                    │ Gateway │  ← Unified orchestrator
                    ├─────────┤
                    │Sessions │ Router │ Queue
                    ├─────────┤
                    │AutoAccept│ Cron  │ Stream
                    ├─────────┤
                    │RemoteBridge│ Health
                    └────┬────┘
                    ┌────▼────┐
                    │  CDP    │  ← Chrome DevTools Protocol
                    └────┬────┘
                    ┌────▼────┐
                    │ 🧠 Antigravity IDE │
                    └─────────┘
```

## Configuration

### Environment Variables (`.env`)

| Variable | Description | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | _(disabled)_ |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs | _(all allowed)_ |
| `PORT` | Web server port | `3000` |
| `API_KEY` | API key for `/api/v1/*` (empty = no auth) | _(disabled)_ |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `CDP_PORTS` | Comma-separated CDP ports | `9000,9001,9002,9003` |

### Instance Config (`opengravity.json`)

```json
{
  "instances": [
    { "name": "poskit", "port": 9000, "keywords": ["pos", "receipt"] },
    { "name": "devops", "port": 9001, "keywords": ["deploy", "ci"] }
  ],
  "defaults": {
    "autoAccept": true,
    "pollInterval": 2000,
    "port": 3000
  },
  "cron": [
    { "name": "daily-review", "schedule": "0 9 * * *", "prompt": "Review open PRs", "instance": "poskit" }
  ],
  "remotes": [
    { "name": "vps", "type": "cdp", "host": "100.97.220.30", "ports": [9000] },
    { "name": "cloud", "type": "firebase", "project": "devopsagent-staging" }
  ]
}
```

## API Reference

### Send a Prompt

```bash
curl -X POST http://localhost:3000/api/v1/send \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the login bug", "target": "poskit"}'
```

### Check Health

```bash
curl http://localhost:3000/health
# → {"ok":true,"instances":2,"busy":1,"pending":0,"uptime":3600}

curl http://localhost:3000/api/v1/health
# → Full system report with all subsystems
```

### Auto-Accept

```bash
# Enable for all instances
curl -X POST http://localhost:3000/api/v1/auto-accept/mode \
  -d '{"mode": "all"}'

# Check stats
curl http://localhost:3000/api/v1/auto-accept
```

### Cron Jobs

```bash
# List jobs
curl http://localhost:3000/api/v1/cron

# Create a job
curl -X POST http://localhost:3000/api/v1/cron \
  -d '{"name":"morning","schedule":"0 9 * * *","prompt":"Check PRs","instance":"poskit"}'

# Manual trigger
curl -X POST http://localhost:3000/api/v1/cron/morning/trigger
```

### WebSocket Streaming

```javascript
const ws = new WebSocket('ws://localhost:3000/api/v1/stream');

ws.onopen = () => {
  // Subscribe to specific channels
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['phase', 'task'] }));
};

ws.onmessage = (event) => {
  const { channel, data } = JSON.parse(event.data);
  console.log(`[${channel}]`, data);
};
```

**Channels:** `phase`, `task`, `instance`, `auto-accept`, `cron`, `queue`

### Authentication

Set `API_KEY` in `.env` to enable. Supports:
- `X-API-Key: your-key` header
- `Authorization: Bearer your-key` header
- `?key=your-key` query parameter

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/project` | Select which workspace to control |
| `/status` | Current agent status |
| `/screenshot` | Capture IDE screenshot |
| `/stop` | Stop current task |
| `/autoaccept` | Toggle auto-accept mode |
| `/probe` | DOM diagnostic |
| _any text_ | Send as prompt to selected workspace |

## Modules

| Module | Purpose |
|---|---|
| `gateway/index.js` | Central orchestrator |
| `gateway/config.js` | Config loader |
| `gateway/session.js` | Session state |
| `gateway/router.js` | Smart routing |
| `gateway/queue.js` | Task queue |
| `gateway/logger.js` | Structured logging |
| `automation/auto-accept.js` | Confirmation clicker |
| `automation/cron.js` | Cron scheduler |
| `api/middleware.js` | Auth + rate limiting |
| `api/stream.js` | WebSocket streaming |
| `distribution/remote.js` | Remote bridge |
| `distribution/health.js` | Health dashboard |

## License

MIT
