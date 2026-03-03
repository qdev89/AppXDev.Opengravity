/**
 * Remote Bridge — connects Opengravity to Antigravity instances on remote machines.
 * 
 * Two connection methods:
 *   1. Direct CDP (Tailscale/LAN) — connect directly to remote CDP ports
 *   2. Firebase Relay — use Firebase RTDB as a message bridge (for NAT-traversal)
 * 
 * Config (opengravity.json):
 *   "remotes": [
 *     { "name": "vps", "type": "cdp", "host": "100.97.220.30", "ports": [9000, 9001] },
 *     { "name": "cloud", "type": "firebase", "project": "devopsagent-staging", "path": "/opengravity" }
 *   ]
 */
import { EventEmitter } from 'events';
import https from 'https';
import http from 'http';
import { log } from '../gateway/logger.js';

const L = log.scope('remote');

export class RemoteBridge extends EventEmitter {
    constructor(cdpManager, gateway, opts = {}) {
        super();
        this.cdp = cdpManager;
        this.gateway = gateway;
        this.remotes = [];
        this._healthTimer = null;
        this._healthInterval = opts.healthInterval || 30000; // 30s
        this._firebaseListeners = new Map();
    }

    /**
     * Load remote configs and start connections.
     * @param {Array} remoteConfigs - Array of remote definitions
     */
    load(remoteConfigs) {
        for (const remote of remoteConfigs || []) {
            const entry = {
                name: remote.name || 'unnamed',
                type: remote.type || 'cdp',
                host: remote.host || null,
                ports: remote.ports || [],
                project: remote.project || null,
                path: remote.path || '/opengravity',
                databaseUrl: remote.databaseUrl || null,
                status: 'disconnected',
                lastCheck: null,
                lastSuccess: null,
                error: null,
            };

            this.remotes.push(entry);

            if (entry.type === 'cdp') {
                this._registerCDPRemote(entry);
            } else if (entry.type === 'firebase') {
                this._registerFirebaseRemote(entry);
            }

            L.info(`Remote loaded: "${entry.name}" (${entry.type}) → ${entry.host || entry.project}`);
        }
    }

    /**
     * Start health monitoring for all remotes.
     */
    start() {
        if (this._healthTimer) return;
        this._healthTimer = setInterval(() => this._checkHealth(), this._healthInterval);
        L.info(`Remote health monitor started (${this.remotes.length} remotes, ${this._healthInterval}ms interval)`);
        // Immediate first check
        this._checkHealth();
    }

    /**
     * Stop health monitoring.
     */
    stop() {
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
        // Clean up Firebase listeners
        for (const [, cleanup] of this._firebaseListeners) {
            if (typeof cleanup === 'function') cleanup();
        }
        this._firebaseListeners.clear();
        L.info('Remote bridge stopped');
    }

    /**
     * List all remotes with their status.
     */
    list() {
        return this.remotes.map(r => ({
            name: r.name,
            type: r.type,
            host: r.host,
            ports: r.ports,
            project: r.project,
            status: r.status,
            lastCheck: r.lastCheck,
            lastSuccess: r.lastSuccess,
            error: r.error,
        }));
    }

    /**
     * Send a prompt to a specific remote via Firebase relay.
     * Used when direct CDP isn't available.
     */
    async sendViaFirebase(remoteName, prompt, metadata = {}) {
        const remote = this.remotes.find(r => r.name === remoteName && r.type === 'firebase');
        if (!remote) return { ok: false, reason: `Firebase remote "${remoteName}" not found` };

        const dbUrl = remote.databaseUrl || this._inferDatabaseUrl(remote.project);
        if (!dbUrl) return { ok: false, reason: 'No database URL configured' };

        const task = {
            id: `og_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
            prompt,
            source: 'opengravity',
            status: 'pending',
            createdAt: new Date().toISOString(),
            metadata,
        };

        try {
            await this._firebasePut(dbUrl, `${remote.path}/inbox/${task.id}`, task);
            L.info(`Sent task via Firebase to "${remoteName}": "${prompt.substring(0, 60)}..."`);
            this.emit('firebase:sent', { remote: remoteName, task });
            return { ok: true, task };
        } catch (e) {
            L.error(`Firebase send failed: ${e.message}`);
            return { ok: false, reason: e.message };
        }
    }

    /**
     * Check for completed tasks from Firebase.
     */
    async pollFirebaseCompleted(remoteName) {
        const remote = this.remotes.find(r => r.name === remoteName && r.type === 'firebase');
        if (!remote) return [];

        const dbUrl = remote.databaseUrl || this._inferDatabaseUrl(remote.project);
        if (!dbUrl) return [];

        try {
            const completed = await this._firebaseGet(dbUrl, `${remote.path}/completed`);
            if (!completed) return [];
            return Object.values(completed);
        } catch {
            return [];
        }
    }

    /**
     * Get remote stats.
     */
    stats() {
        return {
            total: this.remotes.length,
            connected: this.remotes.filter(r => r.status === 'connected').length,
            disconnected: this.remotes.filter(r => r.status === 'disconnected').length,
            error: this.remotes.filter(r => r.status === 'error').length,
            remotes: this.list(),
        };
    }

    // --- Private ---

    /**
     * Register CDP remote ports with the CDPManager for discovery.
     */
    _registerCDPRemote(remote) {
        for (const port of remote.ports) {
            const target = { host: remote.host, port };
            // Check if port already exists
            const existingPorts = this.cdp.ports;
            const key = `${target.host}:${target.port}`;
            const alreadyExists = existingPorts.some(p => {
                const h = typeof p === 'object' ? p.host : '127.0.0.1';
                const pt = typeof p === 'object' ? p.port : p;
                return `${h}:${pt}` === key;
            });

            if (!alreadyExists) {
                this.cdp.ports.push(target);
                L.info(`Added remote CDP target: ${key} (${remote.name})`);
            }
        }
    }

    /**
     * Register Firebase remote for relay-based communication.
     */
    _registerFirebaseRemote(remote) {
        // Firebase remotes don't need CDP registration —
        // they relay messages through RTDB, not direct CDP.
        L.info(`Firebase remote "${remote.name}" registered (project: ${remote.project})`);
    }

    /**
     * Health check all remotes.
     */
    async _checkHealth() {
        for (const remote of this.remotes) {
            remote.lastCheck = Date.now();

            if (remote.type === 'cdp') {
                await this._checkCDPHealth(remote);
            } else if (remote.type === 'firebase') {
                await this._checkFirebaseHealth(remote);
            }
        }
    }

    async _checkCDPHealth(remote) {
        let anyAlive = false;

        for (const port of remote.ports) {
            try {
                const list = await this._httpGet(`http://${remote.host}:${port}/json/version`);
                if (list) {
                    anyAlive = true;
                    break;
                }
            } catch { }
        }

        const prevStatus = remote.status;
        remote.status = anyAlive ? 'connected' : 'disconnected';
        if (anyAlive) {
            remote.lastSuccess = Date.now();
            remote.error = null;
        }

        if (prevStatus !== remote.status) {
            L.info(`Remote "${remote.name}" ${remote.status}`);
            this.emit('remote:status', { name: remote.name, status: remote.status });
        }
    }

    async _checkFirebaseHealth(remote) {
        const dbUrl = remote.databaseUrl || this._inferDatabaseUrl(remote.project);
        if (!dbUrl) {
            remote.status = 'error';
            remote.error = 'No database URL';
            return;
        }

        try {
            const result = await this._firebaseGet(dbUrl, `${remote.path}/heartbeat`);
            remote.status = 'connected';
            remote.lastSuccess = Date.now();
            remote.error = null;
        } catch (e) {
            // A 404 or null is fine — it means Firebase is reachable
            if (e.statusCode === 404 || e.message.includes('null')) {
                remote.status = 'connected';
                remote.lastSuccess = Date.now();
                remote.error = null;
            } else {
                remote.status = 'error';
                remote.error = e.message;
            }
        }
    }

    _inferDatabaseUrl(project) {
        if (!project) return null;
        return `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app`;
    }

    _httpGet(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve(data); }
                });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }

    _firebaseGet(dbUrl, path) {
        const url = `${dbUrl}${path}.json`;
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch {
                        resolve(null);
                    }
                });
            }).on('error', reject);
        });
    }

    _firebasePut(dbUrl, path, data) {
        const url = `${dbUrl}${path}.json`;
        const body = JSON.stringify(data);

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const req = https.request({
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body);
            req.end();
        });
    }
}
