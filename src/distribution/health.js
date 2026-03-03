/**
 * Health Dashboard — lightweight /health endpoint and system overview.
 * Aggregates status from all subsystems into a single JSON response.
 */
import { log } from '../gateway/logger.js';

const L = log.scope('health');

export class HealthDashboard {
    constructor(gateway) {
        this.gateway = gateway;
        this._startTime = Date.now();
    }

    /**
     * Get full system health report.
     */
    report() {
        const gw = this.gateway;
        const now = Date.now();

        return {
            ok: true,
            uptime: Math.round((now - this._startTime) / 1000),
            uptimeHuman: this._formatUptime(now - this._startTime),
            timestamp: new Date().toISOString(),

            // Instances
            instances: {
                total: gw.cdp.cascades.size,
                list: gw.router.list().map(c => ({
                    id: c.id,
                    title: c.metadata?.chatTitle || 'Unknown',
                    host: c.host || '127.0.0.1',
                    port: c.port,
                    phase: gw.sessions.get(c.id)?.phase || 'unknown',
                    busy: gw.queue.isBusy(c.id),
                })),
            },

            // Queue
            queue: gw.queue.stats(),

            // Sessions
            sessions: gw.sessions.getAllStats(),

            // Automation
            autoAccept: gw.autoAccept ? gw.autoAccept.stats() : null,
            cron: gw.cron ? {
                jobs: gw.cron.list().length,
                activeJobs: gw.cron.list().filter(j => j.enabled).length,
            } : null,

            // Remotes
            remotes: gw.remoteBridge ? gw.remoteBridge.stats() : null,

            // API stream
            streamClients: gw._streamClientCount ? gw._streamClientCount() : 0,
        };
    }

    /**
     * Get a compact one-line status.
     */
    compact() {
        const gw = this.gateway;
        const instances = gw.cdp.cascades.size;
        const busy = [...gw.cdp.cascades.keys()].filter(id => gw.queue.isBusy(id)).length;
        const pending = gw.queue.getPending().length;

        return {
            ok: true,
            instances,
            busy,
            pending,
            uptime: Math.round((Date.now() - this._startTime) / 1000),
        };
    }

    /**
     * Register Express routes.
     */
    registerRoutes(app) {
        app.get('/health', (req, res) => {
            res.json(this.compact());
        });

        app.get('/api/v1/health', (req, res) => {
            res.json(this.report());
        });

        L.info('Health endpoints registered: /health, /api/v1/health');
    }

    // --- Private ---

    _formatUptime(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);

        if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
        if (h > 0) return `${h}h ${m % 60}m`;
        if (m > 0) return `${m}m ${s % 60}s`;
        return `${s}s`;
    }
}
