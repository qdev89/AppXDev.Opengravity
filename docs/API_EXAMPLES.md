# Opengravity API Examples

Practical examples for integrating with the Opengravity API.

---

## Table of Contents

- [Quick Health Check](#quick-health-check)
- [Send a Prompt (cURL)](#send-a-prompt-curl)
- [Send a Prompt (JavaScript)](#send-a-prompt-javascript)
- [Send a Prompt (Python)](#send-a-prompt-python)
- [JWT Authentication Flow](#jwt-authentication-flow)
- [WebSocket Streaming](#websocket-streaming)
- [Cron Job Management](#cron-job-management)
- [Auto-Accept Control](#auto-accept-control)
- [CI/CD Integration](#cicd-integration)
- [GitHub Actions Workflow](#github-actions-workflow)

---

## Quick Health Check

```bash
# Simple health check
curl http://localhost:3000/health

# Full system report
curl http://localhost:3000/api/v1/health | jq .
```

**Response:**

```json
{
  "ok": true,
  "uptime": 3600,
  "uptimeHuman": "1h 0m",
  "instances": {
    "total": 2,
    "list": [
      { "title": "POSKit", "host": "127.0.0.1", "port": 9000, "phase": "idle" },
      { "title": "DevOps", "host": "127.0.0.1", "port": 9001, "phase": "streaming" }
    ]
  },
  "queue": { "pending": 0, "running": 1 },
  "autoAccept": { "mode": "all", "clicks": 42 },
  "cron": { "jobs": 2, "activeJobs": 2 },
  "remotes": { "total": 1, "connected": 1 },
  "streamClients": 3
}
```

---

## Send a Prompt (cURL)

```bash
# Simple prompt (auto-routes to any available instance)
curl -X POST http://localhost:3000/api/v1/send \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the login bug in auth.js"}'

# Target a specific instance
curl -X POST http://localhost:3000/api/v1/send \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add Vietnamese translation for receipt module",
    "target": "poskit",
    "priority": 3
  }'

# High-priority task
curl -X POST http://localhost:3000/api/v1/send \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "CRITICAL: Production database is returning 500 errors. Investigate immediately.",
    "priority": 1
  }'
```

---

## Send a Prompt (JavaScript)

```javascript
// Using fetch (Node.js 18+ or browser)
async function sendPrompt(prompt, target = null) {
    const response = await fetch('http://localhost:3000/api/v1/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'your-key',
        },
        body: JSON.stringify({ prompt, target }),
    });
    return response.json();
}

// Usage
const result = await sendPrompt('Review the last 5 commits for bugs');
console.log(result);
// → { ok: true, task: { id: "t_abc123", status: "queued" } }
```

---

## Send a Prompt (Python)

```python
import requests

API_URL = "http://localhost:3000/api/v1"
API_KEY = "your-key"

headers = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
}

# Send a prompt
response = requests.post(f"{API_URL}/send", json={
    "prompt": "Write unit tests for the user service",
    "target": "poskit",
}, headers=headers)

print(response.json())

# Check health
health = requests.get(f"{API_URL}/health", headers=headers)
print(health.json())
```

---

## JWT Authentication Flow

```bash
# Step 1: Generate a JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"key": "your-api-key", "label": "ci-server", "expiresIn": 604800}' \
  | jq -r '.token')

echo "Token: $TOKEN"

# Step 2: Use the token for subsequent requests
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/health

# Step 3: Use in scripts
curl -X POST http://localhost:3000/api/v1/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Run the test suite"}'
```

---

## WebSocket Streaming

### Node.js Client

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/api/v1/stream');

ws.on('open', () => {
    console.log('Connected to Opengravity stream');
    
    // Subscribe to channels
    ws.send(JSON.stringify({
        type: 'subscribe',
        channels: ['phase', 'task', 'instance'],
    }));
});

ws.on('message', (raw) => {
    const { channel, data, timestamp } = JSON.parse(raw);
    
    switch (channel) {
        case 'phase':
            console.log(`[Phase] ${data.title}: ${data.phase}`);
            break;
        case 'task':
            console.log(`[Task] ${data.status}: ${data.prompt?.substring(0, 50)}`);
            break;
        case 'instance':
            console.log(`[Instance] ${data.event}: ${data.title}`);
            break;
    }
});

ws.on('close', () => {
    console.log('Disconnected. Reconnecting in 5s...');
    setTimeout(() => { /* reconnect logic */ }, 5000);
});
```

### Browser Client

```html
<script>
const ws = new WebSocket(`ws://${location.host}/api/v1/stream`);

ws.onopen = () => {
    ws.send(JSON.stringify({
        type: 'subscribe',
        channels: ['phase', 'task'],
    }));
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    document.getElementById('log').textContent += 
        `[${msg.channel}] ${JSON.stringify(msg.data)}\n`;
};
</script>
```

---

## Cron Job Management

```bash
# ── List all jobs ──
curl http://localhost:3000/api/v1/cron | jq .

# ── Create a daily code review ──
curl -X POST http://localhost:3000/api/v1/cron \
  -H "Content-Type: application/json" \
  -d '{
    "name": "morning-review",
    "schedule": "0 9 * * 1-5",
    "prompt": "Review all changes made yesterday. Check for bugs, security issues, and code quality.",
    "instance": "poskit",
    "enabled": true
  }'

# ── Create a weekly dependency check ──
curl -X POST http://localhost:3000/api/v1/cron \
  -H "Content-Type: application/json" \
  -d '{
    "name": "weekly-deps",
    "schedule": "0 10 * * 1",
    "prompt": "Run npm audit and check for outdated dependencies. Create issues for critical updates.",
    "instance": "devops"
  }'

# ── Manually trigger a job ──
curl -X POST http://localhost:3000/api/v1/cron/morning-review/trigger

# ── Disable a job ──
curl -X PUT http://localhost:3000/api/v1/cron/morning-review/enabled \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# ── Delete a job ──
curl -X DELETE http://localhost:3000/api/v1/cron/morning-review

# ── View execution history ──
curl "http://localhost:3000/api/v1/cron/history?limit=10" | jq .
```

---

## Auto-Accept Control

```bash
# ── Check current mode ──
curl http://localhost:3000/api/v1/auto-accept | jq .

# ── Enable for all ──
curl -X POST http://localhost:3000/api/v1/auto-accept/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "all"}'

# ── Per-instance rules ──
curl -X POST http://localhost:3000/api/v1/auto-accept/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "instance"}'

# Enable for poskit only
curl -X POST http://localhost:3000/api/v1/auto-accept/instance/cascade_abc123 \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# ── Turn off ──
curl -X POST http://localhost:3000/api/v1/auto-accept/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "off"}'
```

---

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  ai-review:
    runs-on: self-hosted  # Must have access to Opengravity
    steps:
      - name: Get JWT Token
        id: auth
        run: |
          TOKEN=$(curl -s -X POST ${{ secrets.OPENGRAVITY_URL }}/api/v1/auth/token \
            -H "Content-Type: application/json" \
            -d '{"key": "${{ secrets.OPENGRAVITY_KEY }}", "label": "github-actions"}' \
            | jq -r '.token')
          echo "token=$TOKEN" >> $GITHUB_OUTPUT

      - name: Request AI Review
        run: |
          curl -X POST ${{ secrets.OPENGRAVITY_URL }}/api/v1/send \
            -H "Authorization: Bearer ${{ steps.auth.outputs.token }}" \
            -H "Content-Type: application/json" \
            -d '{
              "prompt": "Review PR #${{ github.event.pull_request.number }}: ${{ github.event.pull_request.title }}. Focus on bugs, security, and code quality.",
              "target": "poskit",
              "priority": 3,
              "source": "github-actions"
            }'
```

### Shell Script for Automated Tasks

```bash
#!/bin/bash
# deploy-review.sh — Send a deployment review task to Opengravity

OPENGRAVITY_URL="${OPENGRAVITY_URL:-http://localhost:3000}"
API_KEY="${OPENGRAVITY_API_KEY}"

send_task() {
    local prompt="$1"
    local target="${2:-}"
    
    curl -s -X POST "${OPENGRAVITY_URL}/api/v1/send" \
        -H "X-API-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg p "$prompt" --arg t "$target" \
            '{prompt: $p, target: $t, source: "script"}')"
}

# Usage
send_task "Review the deployment logs and check for errors" "devops"
send_task "Run the full test suite and report results" "poskit"
```

---

## Rate Limiting

The API enforces rate limits per IP:

```bash
# Check your rate limit status in response headers
curl -v http://localhost:3000/api/v1/health 2>&1 | grep -i x-rate

# X-RateLimit-Limit: 120
# X-RateLimit-Remaining: 119
# X-RateLimit-Window: 60000
```

If you exceed the limit, you'll get a `429 Too Many Requests` response:

```json
{
  "ok": false,
  "error": "Too Many Requests",
  "retryAfter": 45
}
```
