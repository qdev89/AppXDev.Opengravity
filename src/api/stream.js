/**
 * WebSocket Streaming — real-time event stream for API consumers.
 * 
 * Clients connect to /api/v1/stream and receive JSON events for:
 *   - phase changes (idle → streaming → complete)
 *   - task submissions and completions
 *   - instance connect/disconnect
 *   - auto-accept clicks
 *   - cron executions
 *
 * Protocol:
 *   → Client sends: { type: "subscribe", channels: ["phase", "task", "instance", "auto-accept", "cron"] }
 *   ← Server sends: { type: "event", channel: "phase", data: { ... } }
 *   ← Server sends: { type: "ping" } (every 30s keepalive)
 */
import { log } from '../gateway/logger.js';

const L = log.scope('ws-stream');

export class StreamServer {
    constructor(wss, gateway) {
        this.wss = wss;
        this.gateway = gateway;
        this._clients = new Set();
        this._pingTimer = null;

        this._bindGateway();
        this._bindWebSocket();
        this._startPing();
    }

    /**
     * Broadcast an event to all subscribed clients.
     */
    broadcast(channel, data) {
        const msg = JSON.stringify({ type: 'event', channel, data, ts: Date.now() });

        for (const client of this._clients) {
            if (client.ws.readyState !== 1) continue; // OPEN
            if (client.channels.size > 0 && !client.channels.has(channel)) continue;

            try {
                client.ws.send(msg);
            } catch { }
        }
    }

    /**
     * Get connected client count.
     */
    clientCount() {
        return this._clients.size;
    }

    /**
     * Stop the stream server.
     */
    stop() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        for (const client of this._clients) {
            try { client.ws.close(); } catch { }
        }
        this._clients.clear();
    }

    // --- Private ---

    _bindWebSocket() {
        this.wss.on('connection', (ws, req) => {
            const client = {
                ws,
                channels: new Set(), // empty = all channels
                connectedAt: Date.now(),
                ip: req.socket.remoteAddress,
            };

            this._clients.add(client);
            L.info(`Stream client connected (${this._clients.size} total) from ${client.ip}`);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                channels: ['phase', 'task', 'instance', 'auto-accept', 'cron', 'queue'],
                ts: Date.now(),
            }));

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
                        client.channels = new Set(msg.channels);
                        ws.send(JSON.stringify({
                            type: 'subscribed',
                            channels: [...client.channels],
                        }));
                    }
                    if (msg.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong' }));
                    }
                } catch { }
            });

            ws.on('close', () => {
                this._clients.delete(client);
                L.debug(`Stream client disconnected (${this._clients.size} remaining)`);
            });

            ws.on('error', () => {
                this._clients.delete(client);
            });
        });
    }

    _bindGateway() {
        const gw = this.gateway;

        // Phase changes
        gw.on('phase', (event) => {
            this.broadcast('phase', {
                cascadeId: event.cascadeId,
                phase: event.phase,
                prevPhase: event.prevPhase,
                title: event.cascade?.metadata?.chatTitle,
            });
        });

        // Task events
        gw.on('prompt:sent', ({ task, cascade }) => {
            this.broadcast('task', {
                event: 'sent',
                taskId: task.id,
                prompt: task.prompt.substring(0, 200),
                source: task.source,
                cascade: cascade.title,
            });
        });

        gw.on('task:complete', ({ cascadeId, task }) => {
            this.broadcast('task', {
                event: 'complete',
                taskId: task?.id,
                cascadeId,
                duration: task ? task.completedAt - task.startedAt : null,
            });
        });

        // Instance events
        gw.on('instance:connected', (info) => {
            this.broadcast('instance', { event: 'connected', ...info });
        });

        gw.on('instance:disconnected', (info) => {
            this.broadcast('instance', { event: 'disconnected', ...info });
        });

        // Queue events
        gw.on('queue:task:submitted', (task) => {
            this.broadcast('queue', {
                event: 'submitted',
                taskId: task.id,
                prompt: task.prompt.substring(0, 200),
                priority: task.priority,
            });
        });

        // Auto-accept events (if available)
        if (gw.autoAccept) {
            gw.autoAccept.on('clicked', (event) => {
                this.broadcast('auto-accept', event);
            });
        }

        // Cron events (if available)
        if (gw.cron) {
            gw.cron.on('job:executed', ({ job, result, trigger }) => {
                this.broadcast('cron', {
                    job,
                    trigger,
                    ok: result.ok,
                    cascade: result.cascade?.title,
                });
            });
        }
    }

    _startPing() {
        this._pingTimer = setInterval(() => {
            const msg = JSON.stringify({ type: 'ping', ts: Date.now() });
            for (const client of this._clients) {
                if (client.ws.readyState === 1) {
                    try { client.ws.send(msg); } catch { }
                }
            }
        }, 30000);
    }
}
