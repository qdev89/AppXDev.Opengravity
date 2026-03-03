/**
 * CronScheduler — runs recurring tasks on a cron schedule.
 * Tasks are defined in opengravity.json under the "cron" key.
 * Each job sends a prompt to a named instance via the Gateway.
 *
 * Config format:
 *   "cron": [
 *     { "name": "daily-review", "schedule": "0 9 * * *", "prompt": "Review open PRs", "instance": "poskit", "enabled": true },
 *     { "name": "weekly-deps", "schedule": "0 10 * * 1", "prompt": "Check for outdated dependencies", "instance": "devops" }
 *   ]
 */
import { EventEmitter } from 'events';
import { log } from '../gateway/logger.js';

const L = log.scope('cron');

/**
 * Simple cron-like scheduler (no dependency needed).
 * Supports: minute hour dayOfMonth month dayOfWeek
 * Wildcards (*) and specific values only (no ranges/steps for simplicity).
 */
function parseCron(expression) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error(`Invalid cron: "${expression}" (need 5 fields)`);
    return {
        minute: parts[0],
        hour: parts[1],
        dayOfMonth: parts[2],
        month: parts[3],
        dayOfWeek: parts[4],
    };
}

function matchesField(field, value) {
    if (field === '*') return true;
    // Support comma-separated values: "1,5,10"
    const values = field.split(',').map(v => parseInt(v.trim()));
    return values.includes(value);
}

function matchesCron(cron, date) {
    return (
        matchesField(cron.minute, date.getMinutes()) &&
        matchesField(cron.hour, date.getHours()) &&
        matchesField(cron.dayOfMonth, date.getDate()) &&
        matchesField(cron.month, date.getMonth() + 1) &&
        matchesField(cron.dayOfWeek, date.getDay())
    );
}

export class CronScheduler extends EventEmitter {
    constructor(gateway, opts = {}) {
        super();
        this.gateway = gateway;
        this.jobs = [];
        this._timer = null;
        this._lastCheck = null;
        this._checkInterval = opts.checkInterval || 60000; // check every minute
        this._history = []; // last N executions
        this._maxHistory = opts.maxHistory || 50;
    }

    /**
     * Load jobs from config.
     * @param {Array} cronConfig - Array of cron job definitions
     */
    loadJobs(cronConfig) {
        this.jobs = [];
        for (const job of cronConfig || []) {
            try {
                const parsed = parseCron(job.schedule);
                this.jobs.push({
                    name: job.name || 'unnamed',
                    schedule: job.schedule,
                    parsed,
                    prompt: job.prompt,
                    instance: job.instance || null,
                    enabled: job.enabled !== false,
                    lastRun: null,
                    runCount: 0,
                });
                L.info(`Loaded cron job: "${job.name}" [${job.schedule}] → ${job.instance || 'default'}`);
            } catch (e) {
                L.error(`Invalid cron job "${job.name}": ${e.message}`);
            }
        }
        L.info(`${this.jobs.length} cron job(s) loaded`);
    }

    /**
     * Add a job dynamically.
     */
    addJob({ name, schedule, prompt, instance, enabled = true }) {
        const parsed = parseCron(schedule);
        const job = { name, schedule, parsed, prompt, instance, enabled, lastRun: null, runCount: 0 };
        this.jobs.push(job);
        L.info(`Added cron job: "${name}" [${schedule}]`);
        this.emit('job:added', job);
        return job;
    }

    /**
     * Remove a job by name.
     */
    removeJob(name) {
        const idx = this.jobs.findIndex(j => j.name === name);
        if (idx === -1) return false;
        const removed = this.jobs.splice(idx, 1)[0];
        L.info(`Removed cron job: "${name}"`);
        this.emit('job:removed', removed);
        return true;
    }

    /**
     * Enable/disable a job.
     */
    setEnabled(name, enabled) {
        const job = this.jobs.find(j => j.name === name);
        if (!job) return false;
        job.enabled = enabled;
        L.info(`Cron job "${name}" ${enabled ? 'enabled' : 'disabled'}`);
        return true;
    }

    /**
     * List all jobs with their status.
     */
    list() {
        return this.jobs.map(j => ({
            name: j.name,
            schedule: j.schedule,
            instance: j.instance,
            enabled: j.enabled,
            lastRun: j.lastRun,
            runCount: j.runCount,
            prompt: j.prompt.substring(0, 100),
        }));
    }

    /**
     * Get execution history.
     */
    getHistory(limit = 20) {
        return this._history.slice(-limit);
    }

    /**
     * Start the scheduler.
     */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._check(), this._checkInterval);
        L.info(`Cron scheduler started (${this.jobs.filter(j => j.enabled).length} active jobs)`);
    }

    /**
     * Stop the scheduler.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            L.info('Cron scheduler stopped');
        }
    }

    /**
     * Manually trigger a job by name.
     */
    async trigger(name) {
        const job = this.jobs.find(j => j.name === name);
        if (!job) return { ok: false, reason: `Job "${name}" not found` };
        return this._executeJob(job, true);
    }

    // --- Private ---

    async _check() {
        const now = new Date();

        // Avoid double-firing in the same minute
        const currentMinute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        if (this._lastCheck === currentMinute) return;
        this._lastCheck = currentMinute;

        for (const job of this.jobs) {
            if (!job.enabled) continue;
            if (matchesCron(job.parsed, now)) {
                await this._executeJob(job, false);
            }
        }
    }

    async _executeJob(job, manual = false) {
        const trigger = manual ? 'manual' : 'schedule';
        L.info(`Executing cron job: "${job.name}" (${trigger})`);

        try {
            const result = await this.gateway.send({
                prompt: job.prompt,
                target: job.instance,
                priority: 3, // cron jobs are medium-high priority
                source: 'cron',
                metadata: { cronJob: job.name, trigger },
            });

            job.lastRun = Date.now();
            job.runCount++;

            const entry = {
                job: job.name,
                trigger,
                timestamp: Date.now(),
                ok: result.ok,
                reason: result.reason || null,
                cascadeTitle: result.cascade?.title || null,
            };
            this._history.push(entry);
            if (this._history.length > this._maxHistory) this._history.shift();

            this.emit('job:executed', { job: job.name, result, trigger });

            if (result.ok) {
                L.info(`Cron "${job.name}" sent to "${result.cascade?.title}" (${trigger})`);
            } else {
                L.warn(`Cron "${job.name}" failed: ${result.reason}`);
            }

            return result;
        } catch (e) {
            L.error(`Cron "${job.name}" error: ${e.message}`);
            return { ok: false, reason: e.message };
        }
    }
}
