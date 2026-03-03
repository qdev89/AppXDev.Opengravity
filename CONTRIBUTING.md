# Contributing to Opengravity

Thank you for your interest in contributing! This guide covers how to set up a development environment and submit changes.

## Development Setup

### Prerequisites

- Node.js 18+ 
- Git
- An Antigravity IDE instance (for testing)

### Getting Started

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/AppXDev.Opengravity.git
cd AppXDev.Opengravity

# Install dependencies
npm install

# Create your environment config
cp .env.example .env
# Edit .env as needed

# Start in dev mode (auto-restart on file changes)
npm run dev
```

### Project Structure

```
src/
├── gateway/        # Core orchestration (sessions, routing, queue)
├── cdp/            # Chrome DevTools Protocol client
├── monitor/        # Agent activity monitoring
├── automation/     # Auto-accept, cron scheduler
├── api/            # Auth middleware, WebSocket streaming
├── distribution/   # Remote instance bridges, health
├── bot/            # Telegram bot
└── web/            # Express server + all API routes

public/             # Web dashboard (HTML/CSS/JS, PWA)
```

### Key Design Principles

1. **Zero unnecessary dependencies** — Only 4 npm packages. Use Node.js built-ins when possible.
2. **Gateway-first** — All channels (Telegram, Web, API) route through the Gateway orchestrator.
3. **Event-driven** — Gateway emits events that channels subscribe to.
4. **Graceful degradation** — If a subsystem fails, others continue working.

### Adding a New Channel

To add a new channel (e.g., Slack, Discord):

1. Create `src/channels/your-channel.js`
2. Accept `gateway` in constructor
3. Use `gateway.send()` to send prompts
4. Listen to gateway events for responses
5. Wire it up in `server.js`

Example:

```javascript
export class SlackBot {
    constructor(gateway, opts) {
        this.gateway = gateway;
        // ... setup
        
        // Listen for task completions
        gateway.on('task:complete', ({ cascadeId, task }) => {
            // Notify Slack
        });
    }
    
    async handleMessage(text, channel) {
        const result = await this.gateway.send({
            prompt: text,
            source: 'slack',
            metadata: { channel },
        });
        return result;
    }
}
```

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `chore:` — Build process, dependencies
- `refactor:` — Code change that neither fixes a bug nor adds a feature

### Submitting a PR

1. Create a feature branch from `main`
2. Make your changes with descriptive commits
3. Test locally with `npm run dev`
4. Push and open a PR
5. Describe what changed and why

## Questions?

Open an issue on GitHub or reach out via Telegram.
