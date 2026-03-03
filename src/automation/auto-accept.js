/**
 * AutoAccept — CDP-based confirmation dialog auto-clicker.
 * Polls for approval/confirmation buttons and clicks them automatically.
 * 
 * Modes:
 *   - 'off'     — no auto-accept (manual only)
 *   - 'all'     — accept everything on all instances
 *   - 'instance' — per-instance rules from config
 */
import { EventEmitter } from 'events';
import { log } from '../gateway/logger.js';

const L = log.scope('auto-accept');

// Selectors for confirmation/approval buttons in Antigravity
const ACCEPT_SELECTORS = [
    // Antigravity-specific confirmation dialogs
    'button[aria-label*="Accept"]',
    'button[aria-label*="Confirm"]',
    'button[aria-label*="Allow"]',
    'button[aria-label*="Approve"]',
    'button[aria-label*="Yes"]',
    'button[aria-label*="Continue"]',
    'button[aria-label*="Run"]',
    // Generic primary/confirm buttons
    '.confirm-button',
    '.accept-button',
];

const ACCEPT_SCRIPT = `(() => {
    const selectors = ${JSON.stringify(ACCEPT_SELECTORS)};
    const results = [];
    for (const sel of selectors) {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
            if (btn.offsetParent && !btn.disabled) {
                const label = (btn.textContent || btn.ariaLabel || sel).substring(0, 50).trim();
                btn.click();
                results.push(label);
            }
        }
    }
    return { clicked: results.length, labels: results };
})()`;

export class AutoAccept extends EventEmitter {
    constructor(cdpManager, gateway, opts = {}) {
        super();
        this.cdp = cdpManager;
        this.gateway = gateway;
        this.mode = opts.mode || 'off'; // 'off' | 'all' | 'instance'
        this.pollInterval = opts.pollInterval || 3000;
        this.instanceRules = opts.instanceRules || new Map(); // cascadeId → boolean
        this._timer = null;
        this._stats = {
            totalClicks: 0,
            lastClick: null,
            clicksPerInstance: new Map(),
        };
    }

    /**
     * Set the auto-accept mode.
     * @param {'off'|'all'|'instance'} mode
     */
    setMode(mode) {
        const prev = this.mode;
        this.mode = mode;
        L.info(`Mode changed: ${prev} → ${mode}`);
        this.emit('mode:changed', { prev, mode });

        if (mode === 'off' && this._timer) {
            this.stop();
        } else if (mode !== 'off' && !this._timer) {
            this.start();
        }
    }

    /**
     * Set per-instance auto-accept rule.
     */
    setInstanceRule(cascadeId, enabled) {
        this.instanceRules.set(cascadeId, enabled);
        L.info(`Instance rule: ${cascadeId} → ${enabled ? 'ON' : 'OFF'}`);
    }

    /**
     * Check if auto-accept is enabled for a specific cascade.
     */
    isEnabled(cascadeId) {
        if (this.mode === 'off') return false;
        if (this.mode === 'all') return true;
        if (this.mode === 'instance') {
            return this.instanceRules.get(cascadeId) === true;
        }
        return false;
    }

    /**
     * Manually trigger an accept check on a specific cascade.
     */
    async checkOnce(cascadeId) {
        const cascade = this.cdp.cascades.get(cascadeId);
        if (!cascade) return { clicked: 0 };
        return this._checkCascade(cascadeId, cascade);
    }

    /**
     * Get auto-accept stats.
     */
    stats() {
        return {
            mode: this.mode,
            running: !!this._timer,
            totalClicks: this._stats.totalClicks,
            lastClick: this._stats.lastClick,
            instanceRules: Object.fromEntries(this.instanceRules),
        };
    }

    /**
     * Start the auto-accept polling loop.
     */
    start() {
        if (this.mode === 'off') {
            L.info('Auto-accept is OFF — not starting');
            return;
        }
        if (this._timer) return;

        this._timer = setInterval(() => this._poll(), this.pollInterval);
        L.info(`Auto-accept started (mode: ${this.mode}, interval: ${this.pollInterval}ms)`);
    }

    /**
     * Stop the polling loop.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            L.info('Auto-accept stopped');
        }
    }

    // --- Private ---

    async _poll() {
        for (const [id, cascade] of this.cdp.cascades) {
            if (!this.isEnabled(id)) continue;
            try {
                await this._checkCascade(id, cascade);
            } catch { }
        }
    }

    async _checkCascade(cascadeId, cascade) {
        if (!cascade.cdp.rootContextId) return { clicked: 0 };

        try {
            const result = await cascade.cdp.call('Runtime.evaluate', {
                expression: ACCEPT_SCRIPT,
                returnByValue: true,
                contextId: cascade.cdp.rootContextId,
            });

            const val = result?.result?.value;
            if (val && val.clicked > 0) {
                this._stats.totalClicks += val.clicked;
                this._stats.lastClick = Date.now();

                const prev = this._stats.clicksPerInstance.get(cascadeId) || 0;
                this._stats.clicksPerInstance.set(cascadeId, prev + val.clicked);

                const title = cascade.metadata?.chatTitle || cascadeId;
                L.info(`Clicked ${val.clicked} button(s) on "${title}": ${val.labels.join(', ')}`);

                this.emit('clicked', {
                    cascadeId,
                    title,
                    count: val.clicked,
                    labels: val.labels,
                });

                return val;
            }
            return { clicked: 0 };
        } catch {
            return { clicked: 0 };
        }
    }
}
