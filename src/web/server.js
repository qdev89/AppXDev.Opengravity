/**
 * Web Server — Express + WebSocket server for AG Mission Control.
 * Serves the web dashboard and provides API endpoints for cascade management.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createAuthMiddleware, createRateLimiter, registerAuthRoutes } from '../api/middleware.js';
import { StreamServer } from '../api/stream.js';

import { Launcher } from '../launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createWebServer(cdpManager, responseMonitor, opts = {}) {
    const port = opts.port || parseInt(process.env.PORT) || 3000;
    const gateway = opts.gateway || null; // Gateway orchestrator (Phase 1)
    const launcher = opts.launcher ?? new Launcher();
    const app = express();
    const server = http.createServer(app);
    // If gateway exists, use noServer mode so we can route upgrade requests
    // between dashboard WS and API stream WS. Otherwise, attach directly.
    const wss = new WebSocketServer(gateway ? { noServer: true } : { server });

    app.use(express.json());
    app.use(express.static(join(__dirname, '../../public'), { maxAge: 0, etag: false }));

    // ── API Security Middleware ──
    app.use(createAuthMiddleware({
        apiKey: opts.apiKey || process.env.API_KEY,
        apiSecret: opts.apiSecret || process.env.API_SECRET,
    }));
    app.use(createRateLimiter({ maxRequests: opts.rateLimit || 120, windowMs: 60000 }));
    registerAuthRoutes(app);

    // ── API: Get cascade list ─────────────────────────
    app.get('/cascades', (req, res) => {
        res.json({ cascades: cdpManager.getCascadeList() });
    });

    // ── API: Add workspace + auto-launch ─────────────
    app.post('/workspace/add', async (req, res) => {
        const { host, port, name, folder } = req.body;
        if (!port) return res.status(400).json({ ok: false, reason: 'Port required' });
        const isNew = cdpManager.addPort(port, host || '127.0.0.1');

        // Auto-launch if launcher is available and this is a new target
        let launchResult = null;
        if (launcher && folder) {
            launchResult = await launcher.launch({ name, folder, host: host || 'localhost', port });
        }

        res.json({
            ok: true,
            isNew,
            launched: launchResult?.ok || false,
            pid: launchResult?.pid || null,
            message: launchResult?.ok
                ? `🚀 Launched ${name || 'agent'} on port ${port}`
                : isNew ? `Scanning ${host || '127.0.0.1'}:${port}...` : 'Already scanning this target'
        });
    });

    // ── API: Launch instance manually ─────────────────
    app.post('/workspace/launch', async (req, res) => {
        if (!launcher) return res.status(503).json({ ok: false, reason: 'Launcher not available' });
        const { name, folder, host, port } = req.body;
        if (!port) return res.status(400).json({ ok: false, reason: 'Port required' });
        // Also register the port for CDP scanning
        cdpManager.addPort(port, host || '127.0.0.1');
        const result = await launcher.launch({ name, folder, host, port });
        res.json(result);
    });

    // ── API: Stop launched instance ───────────────────
    app.post('/workspace/stop', (req, res) => {
        if (!launcher) return res.status(503).json({ ok: false, reason: 'Launcher not available' });
        const { port } = req.body;
        if (!port) return res.status(400).json({ ok: false, reason: 'Port required' });
        const result = launcher.stop(port);
        res.json(result);
    });

    // ── API: Get launcher status ─────────────────────
    app.get('/workspace/status', (req, res) => {
        if (!launcher) return res.json({ processes: {} });
        res.json({ processes: launcher.getStatus() });
    });

    // ── API: List scan targets ────────────────────────
    app.get('/workspace/ports', (req, res) => {
        res.json({ ports: cdpManager.ports });
    });

    // ── API: Server-side project persistence ──────────
    app.get('/api/v1/projects', (req, res) => {
        const cfg = opts.config;
        res.json({ projects: cfg?.val('projects', []) || [] });
    });

    app.post('/api/v1/projects', (req, res) => {
        const cfg = opts.config;
        if (!cfg) return res.status(503).json({ ok: false, reason: 'Config not available' });
        const { name, host, port, folder, color } = req.body;
        if (!port) return res.status(400).json({ ok: false, reason: 'Port required' });

        const projects = cfg.val('projects', []);
        // Upsert by host+port
        const existing = projects.findIndex(p => p.host === (host || 'localhost') && p.port === port);
        const project = { name: name || '', host: host || 'localhost', port, folder: folder || '', color: color || '' };
        if (existing >= 0) {
            projects[existing] = project;
        } else {
            projects.push(project);
        }
        cfg.get().projects = projects;
        // Auto-sync: ensure port is in cdpPorts for discovery
        const cdpPorts = cfg.val('cdpPorts', []);
        if (port && !cdpPorts.includes(port)) {
            cdpPorts.push(port);
            cdpPorts.sort((a, b) => a - b);
            cfg.get().cdpPorts = cdpPorts;
            // Also tell the CDP manager to start scanning this port
            if (cdpManager && typeof cdpManager.addPort === 'function') {
                cdpManager.addPort(host || 'localhost', port);
            }
        }
        cfg.save();
        res.json({ ok: true, project });
    });

    app.delete('/api/v1/projects/:port', (req, res) => {
        const cfg = opts.config;
        if (!cfg) return res.status(503).json({ ok: false, reason: 'Config not available' });
        const port = parseInt(req.params.port);
        const host = req.query.host || 'localhost';
        const projects = cfg.val('projects', []);
        cfg.get().projects = projects.filter(p => !(p.port === port && p.host === host));
        cfg.save();
        res.json({ ok: true });
    });

    // ── API: Get cascade snapshot ─────────────────────
    app.get('/snapshot/:id', (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade || !cascade.snapshot) {
            return res.status(404).json({ error: 'No snapshot' });
        }
        res.json({
            html: cascade.snapshot.html,
            bodyBg: cascade.snapshot.bodyBg,
            bodyColor: cascade.snapshot.bodyColor
        });
    });

    // ── API: Get cascade CSS ──────────────────────────
    app.get('/styles/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }
        res.json({ css: cascade.css || '' });
    });

    // ── API: Send message to cascade ──────────────────
    app.post('/send/:id', async (req, res) => {
        console.log(`📨 POST /send/${req.params.id} body:`, JSON.stringify(req.body).substring(0, 100));
        try {
            const cascade = cdpManager.cascades.get(req.params.id);
            if (!cascade) {
                console.log('📨 Cascade not found');
                return res.status(404).json({ ok: false, reason: 'Cascade not found' });
            }

            const { message } = req.body;
            if (!message) {
                console.log('📨 No message in body');
                return res.status(400).json({ ok: false, reason: 'No message provided' });
            }

            const result = await cdpManager.injectMessage(cascade.cdp, message);
            console.log(`📨 Inject result:`, result);
            if (result.ok) {
                res.json({ ok: true, method: result.method });
            } else {
                res.status(500).json({ ok: false, reason: result.reason });
            }
        } catch (err) {
            console.error('📨 Send error:', err);
            res.status(500).json({ ok: false, reason: err.message || 'Server error' });
        }
    });

    // ── API: Take screenshot ──────────────────────────
    app.get('/screenshot/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }

        const png = await cdpManager.captureScreenshot(cascade.cdp);
        if (png) {
            res.type('image/png').send(png);
        } else {
            res.status(500).json({ error: 'Screenshot failed' });
        }
    });

    // ── API: Auto-accept confirmations ─────────────────
    app.post('/autoaccept/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) return res.status(404).json({ ok: false });
        try {
            const result = await cascade.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    // Look for accept/confirm/approve buttons
                    const selectors = [
                        'button[aria-label*="Accept"]', 'button[aria-label*="Confirm"]',
                        'button[aria-label*="Allow"]', 'button[aria-label*="Approve"]',
                        'button[aria-label*="Yes"]', 'button[aria-label*="Continue"]',
                        'button[aria-label*="Run"]',
                        '.confirm-button', '.accept-button',
                        'button.primary:not([disabled])'
                    ];
                    for (const sel of selectors) {
                        const btns = document.querySelectorAll(sel);
                        for (const btn of btns) {
                            if (btn.offsetParent && !btn.disabled) {
                                btn.click();
                                return 'clicked: ' + (btn.textContent || btn.ariaLabel || sel).substring(0, 50);
                            }
                        }
                    }
                    return 'none';
                })()`,
                returnByValue: true,
                contextId: cascade.cdp.rootContextId
            });
            const action = result?.result?.value || 'none';
            res.json({ ok: true, action });
        } catch (e) {
            res.json({ ok: false, reason: e.message });
        }
    });

    // ── API: Stop agent ───────────────────────────────
    app.post('/stop/:id', async (req, res) => {
        if (gateway) {
            const result = await gateway.stop(req.params.id);
            return res.json(result);
        }
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }
        try {
            await cascade.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
                    if (stopBtn) { stopBtn.click(); return 'clicked'; }
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    return 'escape';
                })()`,
                returnByValue: true,
                contextId: cascade.cdp.rootContextId
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, reason: e.message });
        }
    });

    // ── Gateway API v1 ────────────────────────────────
    if (gateway) {
        // Send prompt via gateway (unified routing + queue)
        app.post('/api/v1/send', async (req, res) => {
            const { prompt, target, priority, source } = req.body;
            if (!prompt) return res.status(400).json({ ok: false, reason: 'No prompt' });
            const result = await gateway.send({
                prompt, target, priority,
                source: source || 'web',
                metadata: { ip: req.ip },
            });
            res.json(result);
        });

        // Gateway status (instances + queue)
        app.get('/api/v1/status', (req, res) => {
            res.json(gateway.status());
        });

        // Queue info
        app.get('/api/v1/queue', (req, res) => {
            res.json({
                stats: gateway.queue.stats(),
                pending: gateway.queue.getPending(),
            });
        });

        // Task history
        app.get('/api/v1/history', (req, res) => {
            const limit = parseInt(req.query.limit) || 20;
            res.json({ history: gateway.queue.getHistory(limit) });
        });

        // Session stats
        app.get('/api/v1/sessions', (req, res) => {
            res.json({ sessions: gateway.sessions.getAllStats() });
        });

        // Accept confirmation via gateway
        app.post('/api/v1/accept/:target', async (req, res) => {
            const result = await gateway.acceptConfirmation(req.params.target);
            res.json(result);
        });

        // Stop via gateway
        app.post('/api/v1/stop/:target', async (req, res) => {
            const result = await gateway.stop(req.params.target);
            res.json(result);
        });

        // Routes/instances list
        app.get('/api/v1/routes', (req, res) => {
            res.json({ routes: gateway.router.list() });
        });

        // ── Fleet: Per-Instance Approval Detection ──
        app.get('/api/v1/instances/:id/approval', async (req, res) => {
            const cascade = cdpManager.cascades.get(req.params.id);
            if (!cascade || !cascade.cdp) {
                return res.json({ hasApproval: false });
            }
            try {
                const result = await cascade.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                        // Check for confirmation/approval dialogs in Antigravity IDE
                        const selectors = [
                            'button[aria-label*="Accept"]', 'button[aria-label*="Confirm"]',
                            'button[aria-label*="Allow"]', 'button[aria-label*="Approve"]',
                            'button[aria-label*="Yes"]', 'button[aria-label*="Continue"]',
                            'button[aria-label*="Run"]',
                            '.confirm-button', '.accept-button',
                            '[class*="confirmation"] button.primary:not([disabled])'
                        ];
                        for (const sel of selectors) {
                            const btns = document.querySelectorAll(sel);
                            for (const btn of btns) {
                                if (btn.offsetParent && !btn.disabled) {
                                    return { found: true, text: (btn.textContent || btn.ariaLabel || '').substring(0, 80) };
                                }
                            }
                        }
                        return { found: false };
                    })()`,
                    returnByValue: true,
                    contextId: cascade.cdp.rootContextId
                });
                const val = result?.result?.value || { found: false };
                res.json({
                    hasApproval: val.found,
                    message: val.found ? `"${val.text}" needs your approval` : null,
                });
            } catch (e) {
                res.json({ hasApproval: false, error: e.message });
            }
        });

        // ── Fleet: Accept confirmation ──
        app.post('/api/v1/instances/:id/approve', async (req, res) => {
            // Delegate to existing gateway method if available
            if (gateway.acceptConfirmation) {
                const result = await gateway.acceptConfirmation(req.params.id);
                return res.json(result);
            }
            // Fallback: direct CDP click
            const cascade = cdpManager.cascades.get(req.params.id);
            if (!cascade || !cascade.cdp) {
                return res.status(404).json({ ok: false, reason: 'Instance not found' });
            }
            try {
                const result = await cascade.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                        const selectors = [
                            'button[aria-label*="Accept"]', 'button[aria-label*="Confirm"]',
                            'button[aria-label*="Allow"]', 'button[aria-label*="Approve"]',
                            'button[aria-label*="Yes"]', 'button[aria-label*="Continue"]',
                            'button[aria-label*="Run"]',
                            '.confirm-button', '.accept-button',
                            'button.primary:not([disabled])'
                        ];
                        for (const sel of selectors) {
                            const btns = document.querySelectorAll(sel);
                            for (const btn of btns) {
                                if (btn.offsetParent && !btn.disabled) {
                                    btn.click();
                                    return 'clicked: ' + (btn.textContent || btn.ariaLabel || sel).substring(0, 50);
                                }
                            }
                        }
                        return 'none';
                    })()`,
                    returnByValue: true,
                    contextId: cascade.cdp.rootContextId
                });
                res.json({ ok: true, action: result?.result?.value || 'none' });
            } catch (e) {
                res.json({ ok: false, reason: e.message });
            }
        });

        // ── Fleet: Deny/dismiss confirmation ──
        app.post('/api/v1/instances/:id/deny', async (req, res) => {
            const cascade = cdpManager.cascades.get(req.params.id);
            if (!cascade || !cascade.cdp) {
                return res.status(404).json({ ok: false, reason: 'Instance not found' });
            }
            try {
                const result = await cascade.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                        // Try clicking deny/cancel/dismiss buttons first
                        const denySelectors = [
                            'button[aria-label*="Deny"]', 'button[aria-label*="Cancel"]',
                            'button[aria-label*="Reject"]', 'button[aria-label*="No"]',
                            'button[aria-label*="Dismiss"]', 'button[aria-label*="Close"]',
                            '.cancel-button', '.deny-button',
                            '[class*="confirmation"] button.secondary',
                            '[class*="confirmation"] button:not(.primary)'
                        ];
                        for (const sel of denySelectors) {
                            const btns = document.querySelectorAll(sel);
                            for (const btn of btns) {
                                if (btn.offsetParent && !btn.disabled) {
                                    btn.click();
                                    return 'denied: ' + (btn.textContent || btn.ariaLabel || sel).substring(0, 50);
                                }
                            }
                        }
                        // Fallback: press Escape
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        return 'escaped';
                    })()`,
                    returnByValue: true,
                    contextId: cascade.cdp.rootContextId
                });
                res.json({ ok: true, action: result?.result?.value || 'escaped' });
            } catch (e) {
                res.json({ ok: false, reason: e.message });
            }
        });

        // ── Automation: Auto-Accept ──
        if (gateway.autoAccept) {
            app.get('/api/v1/auto-accept', (req, res) => {
                res.json(gateway.autoAccept.stats());
            });

            app.post('/api/v1/auto-accept/mode', (req, res) => {
                const { mode } = req.body;
                if (!['off', 'all', 'instance'].includes(mode)) {
                    return res.status(400).json({ ok: false, reason: 'Invalid mode (off|all|instance)' });
                }
                gateway.autoAccept.setMode(mode);
                res.json({ ok: true, mode });
            });

            app.post('/api/v1/auto-accept/instance/:id', (req, res) => {
                const { enabled } = req.body;
                gateway.autoAccept.setInstanceRule(req.params.id, enabled !== false);
                res.json({ ok: true });
            });
        }

        // ── Automation: Cron Scheduler ──
        if (gateway.cron) {
            app.get('/api/v1/cron', (req, res) => {
                res.json({ jobs: gateway.cron.list() });
            });

            app.get('/api/v1/cron/history', (req, res) => {
                const limit = parseInt(req.query.limit) || 20;
                res.json({ history: gateway.cron.getHistory(limit) });
            });

            app.post('/api/v1/cron', (req, res) => {
                const { name, schedule, prompt, instance, enabled } = req.body;
                if (!name || !schedule || !prompt) {
                    return res.status(400).json({ ok: false, reason: 'name, schedule, prompt required' });
                }
                try {
                    const job = gateway.cron.addJob({ name, schedule, prompt, instance, enabled });
                    res.json({ ok: true, job });
                } catch (e) {
                    res.status(400).json({ ok: false, reason: e.message });
                }
            });

            app.delete('/api/v1/cron/:name', (req, res) => {
                const ok = gateway.cron.removeJob(req.params.name);
                res.json({ ok });
            });

            app.post('/api/v1/cron/:name/trigger', async (req, res) => {
                const result = await gateway.cron.trigger(req.params.name);
                res.json(result);
            });

            app.put('/api/v1/cron/:name/enabled', (req, res) => {
                const { enabled } = req.body;
                const ok = gateway.cron.setEnabled(req.params.name, enabled !== false);
                res.json({ ok });
            });
        }

        // ── Distribution: Remote Bridge ──
        if (gateway.remoteBridge) {
            app.get('/api/v1/remotes', (req, res) => {
                res.json({ remotes: gateway.remoteBridge.list() });
            });

            app.get('/api/v1/remotes/stats', (req, res) => {
                res.json(gateway.remoteBridge.stats());
            });

            app.post('/api/v1/remotes/:name/send', async (req, res) => {
                const { prompt } = req.body;
                if (!prompt) return res.status(400).json({ ok: false, reason: 'No prompt' });
                const result = await gateway.remoteBridge.sendViaFirebase(
                    req.params.name, prompt, { ip: req.ip }
                );
                res.json(result);
            });

            app.get('/api/v1/remotes/:name/completed', async (req, res) => {
                const completed = await gateway.remoteBridge.pollFirebaseCompleted(req.params.name);
                res.json({ completed });
            });
        }
    }

    // ── API: Get status ───────────────────────────────
    app.get('/status', async (req, res) => {
        const cascade = cdpManager.getActiveCascade();
        if (!cascade) {
            return res.json({ connected: false });
        }

        const response = await cdpManager.extractResponseText(cascade.cdp);
        res.json({
            connected: true,
            cascadeId: cascade.id,
            title: cascade.metadata.chatTitle,
            textLength: response?.textLength || 0,
            messageCount: response?.messageCount || 0,
            isStreaming: response?.isStreaming || false
        });
    });

    // ── WebSocket — real-time updates ─────────────────
    wss.on('connection', (client) => {
        console.log('🔌 Web client connected');

        // Send current cascade list
        client.send(JSON.stringify({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        }));
    });

    // Broadcast helper
    function broadcast(data) {
        const msg = JSON.stringify(data);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    }

    // ── CDP Manager events → WebSocket ────────────────
    cdpManager.on('cascade:list', (list) => {
        broadcast({ type: 'cascade_list', cascades: list });
    });

    cdpManager.on('cascade:added', (cascade) => {
        broadcast({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        });
    });

    cdpManager.on('cascade:removed', () => {
        broadcast({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        });
    });

    cdpManager.on('snapshot:update', (cascade) => {
        broadcast({
            type: 'snapshot_update',
            cascadeId: cascade.id,
            title: cascade.metadata.chatTitle
        });
    });

    // ── Response Monitor events → WebSocket ───────────
    if (responseMonitor) {
        responseMonitor.on('phase', (event) => {
            broadcast({
                type: 'phase_change',
                phase: event.phase,
                prevPhase: event.prevPhase,
                cascadeId: event.cascadeId,
                title: event.cascade.metadata.chatTitle,
                messageCount: event.messageCount
            });
        });
    }
    // ── API Streaming WebSocket ──────────────────────
    let streamServer = null;
    if (gateway) {
        // Separate WSS for /api/v1/stream on the same HTTP server
        const streamWss = new WebSocketServer({ noServer: true });

        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            if (url.pathname === '/api/v1/stream') {
                streamWss.handleUpgrade(request, socket, head, (ws) => {
                    streamWss.emit('connection', ws, request);
                });
            } else {
                // Let the existing WSS handle dashboard connections
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
            }
        });

        streamServer = new StreamServer(streamWss, gateway);
    }

    // ── Start ─────────────────────────────────────────
    server.listen(port, '0.0.0.0', () => {
        console.log(`🌐 Web viewer: http://localhost:${port}`);
        if (streamServer) {
            console.log(`📡 API stream: ws://localhost:${port}/api/v1/stream`);
        }
    });

    return { app, server, wss, broadcast, streamServer };
}
