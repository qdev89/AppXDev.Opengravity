/**
 * Gateway Orchestrator — the brain of Opengravity.
 * Owns all subsystems: CDP, sessions, routing, queue, monitor.
 * Provides unified API for all channels (Telegram, Web, API, etc.).
 */
import { EventEmitter } from 'events';
import { config } from './config.js';
import { log } from './logger.js';
import { TaskQueue } from './queue.js';
import { SessionManager } from './session.js';
import { Router } from './router.js';

const L = log.scope('gateway');

export class Gateway extends EventEmitter {
    constructor(cdpManager, responseMonitor) {
        super();
        this.cdp = cdpManager;
        this.monitor = responseMonitor;
        this.config = config;
        this.sessions = new SessionManager();
        this.queue = new TaskQueue({
            maxSize: config.val('defaults.maxQueueSize', 50),
        });
        this.router = new Router(config, cdpManager);

        this._autoProcess = true;
        this._processTimer = null;

        // Wire monitor events → session manager
        this._bindMonitor();

        // Wire CDP events
        this._bindCDP();

        // Wire queue events
        this._bindQueue();
    }

    // ─── PUBLIC API ───────────────────────────────────────

    /**
     * Send a prompt to an Antigravity instance.
     * This is THE primary method all channels should call.
     *
     * @param {object} opts
     * @param {string} opts.prompt - The message to send
     * @param {string} [opts.target] - Project name, cascade ID, or null for auto-routing
     * @param {number} [opts.priority=5] - 1 (highest) to 10 (lowest)
     * @param {string} [opts.source='api'] - Channel: 'telegram', 'web', 'api', 'cron'
     * @param {object} [opts.metadata={}] - Extra context (user ID, chat ID, etc.)
     * @returns {Promise<{ ok: boolean, task?: object, cascade?: object, reason?: string }>}
     */
    async send({ prompt, target, priority = 5, source = 'api', metadata = {} }) {
        if (!prompt || !prompt.trim()) {
            return { ok: false, reason: 'Empty prompt' };
        }

        // Route to the right cascade
        const route = this.router.route(prompt, target);
        if (!route) {
            return { ok: false, reason: 'No Antigravity instances connected' };
        }

        const { cascade, instance, method } = route;
        const cascadeId = cascade.id;

        // Check if this cascade is busy
        if (this.queue.isBusy(cascadeId)) {
            // Queue the task instead of rejecting
            const result = this.queue.submit({
                prompt,
                cascadeId,
                instanceName: instance?.name,
                priority,
                source,
                metadata,
            });

            if (result.ok) {
                L.info(`Queued task for busy cascade "${cascade.metadata.chatTitle}" (${this.queue.getPending().length} in queue)`);
                return {
                    ok: true,
                    queued: true,
                    task: result.task,
                    cascade: this._cascadeInfo(cascade),
                    position: this.queue.getPending().length,
                };
            }
            return { ok: false, reason: result.reason };
        }

        // Execute immediately
        return this._executePrompt(cascade, prompt, source, metadata);
    }

    /**
     * Get the status of all connected instances.
     */
    status() {
        const cascades = this.router.list();
        const sessionStats = this.sessions.getAllStats();
        const queueStats = this.queue.stats();

        return {
            instances: cascades.map(c => {
                const session = sessionStats.find(s => s.cascadeId === c.id);
                const running = this.queue.getRunning(c.id);
                return {
                    ...c,
                    phase: session?.phase || 'unknown',
                    tasksCompleted: session?.tasksCompleted || 0,
                    lastActivity: session?.lastActivity || null,
                    currentTask: running ? {
                        id: running.id,
                        prompt: running.prompt.substring(0, 100),
                        source: running.source,
                        startedAt: running.startedAt,
                    } : null,
                };
            }),
            queue: queueStats,
        };
    }

    /**
     * Stop the agent on a specific cascade.
     */
    async stop(target) {
        const route = this.router.resolve(target);
        if (!route) return { ok: false, reason: 'Cascade not found' };

        const { cascade } = route;
        try {
            await cascade.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
                    if (stopBtn) { stopBtn.click(); return 'clicked'; }
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    return 'escape';
                })()`,
                returnByValue: true,
                contextId: cascade.cdp.rootContextId,
            });

            // Fail the current task
            this.queue.fail(cascade.id, 'Manually stopped');
            L.info(`Agent stopped on "${cascade.metadata.chatTitle}"`);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    }

    /**
     * Take a screenshot of a cascade.
     */
    async screenshot(target) {
        const route = this.router.resolve(target);
        if (!route) return null;
        return this.cdp.captureScreenshot(route.cascade.cdp);
    }

    /**
     * Accept/click confirmation dialogs on a cascade.
     */
    async acceptConfirmation(target) {
        const route = this.router.resolve(target);
        if (!route) return { ok: false, reason: 'Cascade not found' };

        const { cascade } = route;
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
                contextId: cascade.cdp.rootContextId,
            });
            const action = result?.result?.value || 'none';
            return { ok: action !== 'none', action };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    }

    /**
     * Get response text from a cascade.
     */
    async getResponse(target) {
        const route = this.router.resolve(target);
        if (!route) return null;
        return this.cdp.extractResponseText(route.cascade.cdp);
    }

    /**
     * Start queue auto-processing.
     */
    startProcessing() {
        if (this._processTimer) return;
        this._processTimer = setInterval(() => this._processQueue(), 3000);
        L.info('Queue auto-processing started');
    }

    /**
     * Stop queue auto-processing.
     */
    stopProcessing() {
        if (this._processTimer) {
            clearInterval(this._processTimer);
            this._processTimer = null;
        }
    }

    // ─── PRIVATE ──────────────────────────────────────────

    async _executePrompt(cascade, prompt, source, metadata) {
        const cascadeId = cascade.id;

        // Create a task entry for tracking
        const task = {
            id: `task_${Date.now().toString(36)}`,
            prompt,
            cascadeId,
            source,
            metadata,
            status: 'running',
            startedAt: Date.now(),
        };

        // Mark as running in queue
        this.queue._running.set(cascadeId, task);

        // Record in session
        this.sessions.addUserMessage(cascadeId, prompt, source);

        // Inject the message via CDP
        L.info(`Sending to "${cascade.metadata.chatTitle}": "${prompt.substring(0, 80)}..."`);
        const result = await this.cdp.injectMessage(cascade.cdp, prompt);

        if (!result.ok) {
            this.queue.fail(cascadeId, result.reason);
            return { ok: false, reason: result.reason };
        }

        this.emit('prompt:sent', { task, cascade: this._cascadeInfo(cascade) });

        return {
            ok: true,
            task,
            cascade: this._cascadeInfo(cascade),
            method: result.method,
        };
    }

    _processQueue() {
        // For each idle cascade, check if there's a pending task
        for (const [id, cascade] of this.cdp.cascades) {
            if (this.queue.isBusy(id)) continue;

            const session = this.sessions.get(id);
            if (session.phase !== 'idle') continue;

            const task = this.queue.next(id);
            if (task) {
                L.info(`Processing queued task ${task.id} on "${cascade.metadata.chatTitle}"`);
                this._executePrompt(cascade, task.prompt, task.source, task.metadata);
            }
        }
    }

    _bindMonitor() {
        this.monitor.on('phase', (event) => {
            this.sessions.setPhase(event.cascadeId, event.phase, {
                cascade: event.cascade,
                message: event.lastMessage,
            });

            // Relay to gateway consumers
            this.emit('phase', event);
        });

        this.monitor.on('complete', (event) => {
            // Mark the running task as complete
            const task = this.queue.complete(event.cascadeId, {
                message: event.message,
                messageCount: event.messageCount,
            });

            // Record agent response in session
            this.sessions.addAgentResponse(event.cascadeId, event.message, {
                messageCount: event.messageCount,
            });

            this.emit('task:complete', { ...event, task });
        });

        this.monitor.on('started', (event) => {
            this.emit('task:started', event);
        });
    }

    _bindCDP() {
        this.cdp.on('cascade:added', (cascade) => {
            L.info(`Instance connected: "${cascade.metadata.chatTitle}" (port ${cascade.port})`);
            this.emit('instance:connected', this._cascadeInfo(cascade));
        });

        this.cdp.on('cascade:removed', (cascade) => {
            L.info(`Instance disconnected: "${cascade.metadata.chatTitle}"`);
            this.sessions.remove(cascade.id);
            this.queue.fail(cascade.id, 'Cascade disconnected');
            this.emit('instance:disconnected', this._cascadeInfo(cascade));
        });
    }

    _bindQueue() {
        this.queue.on('task:submitted', (task) => {
            this.emit('queue:task:submitted', task);
        });
    }

    _cascadeInfo(cascade) {
        return {
            id: cascade.id,
            title: cascade.metadata.chatTitle,
            window: cascade.metadata.windowTitle,
            port: cascade.port,
            host: cascade.host,
        };
    }
}
