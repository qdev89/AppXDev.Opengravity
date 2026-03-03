/**
 * TaskQueue — priority FIFO queue with per-instance concurrency control.
 * Prevents prompt collisions: only one task runs per Antigravity instance at a time.
 */
import { EventEmitter } from 'events';
import { log } from './logger.js';

const L = log.scope('queue');

let taskCounter = 0;

export class TaskQueue extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.maxSize = opts.maxSize || 50;

        // Queue: sorted by priority (lower = higher), then by insertion order
        this._queue = [];

        // Currently executing tasks per cascade instance
        this._running = new Map(); // cascadeId → task

        // Completed task history (ring buffer)
        this._history = [];
        this._maxHistory = opts.maxHistory || 100;
    }

    /**
     * Submit a task to the queue.
     * @param {object} opts
     * @param {string} opts.prompt - The message to inject
     * @param {string} [opts.cascadeId] - Target cascade (null = auto-route)
     * @param {string} [opts.instanceName] - Named instance (resolved by router)
     * @param {number} [opts.priority=5] - 1 (highest) to 10 (lowest)
     * @param {string} [opts.source='api'] - Where the task came from: 'telegram', 'web', 'api', 'cron'
     * @param {object} [opts.metadata] - Extra info (user ID, channel, etc.)
     * @returns {object} The created task
     */
    submit({ prompt, cascadeId, instanceName, priority = 5, source = 'api', metadata = {} }) {
        if (this._queue.length >= this.maxSize) {
            L.warn(`Queue full (${this.maxSize}), rejecting task`);
            return { ok: false, reason: 'Queue full' };
        }

        const task = {
            id: `task_${++taskCounter}_${Date.now().toString(36)}`,
            prompt,
            cascadeId: cascadeId || null,
            instanceName: instanceName || null,
            priority,
            source,
            metadata,
            status: 'pending',     // pending → running → complete | failed
            createdAt: Date.now(),
            startedAt: null,
            completedAt: null,
            result: null,
            error: null,
        };

        // Insert sorted by priority, then FIFO within same priority
        const idx = this._queue.findIndex(t => t.priority > priority);
        if (idx === -1) {
            this._queue.push(task);
        } else {
            this._queue.splice(idx, 0, task);
        }

        L.info(`Task submitted: ${task.id} [${source}] priority=${priority} "${prompt.substring(0, 60)}..."`);
        this.emit('task:submitted', task);

        return { ok: true, task };
    }

    /**
     * Get the next pending task for a specific cascade (respecting concurrency=1).
     * Returns null if no task available or instance is busy.
     */
    next(cascadeId) {
        // Check if this cascade is already running a task
        if (this._running.has(cascadeId)) return null;

        // Find first pending task targeting this cascade (or unrouted)
        const idx = this._queue.findIndex(t =>
            t.status === 'pending' &&
            (t.cascadeId === cascadeId || t.cascadeId === null)
        );

        if (idx === -1) return null;

        const task = this._queue[idx];
        task.status = 'running';
        task.startedAt = Date.now();
        task.cascadeId = cascadeId; // lock to this cascade

        this._queue.splice(idx, 1);
        this._running.set(cascadeId, task);

        L.info(`Task started: ${task.id} on cascade ${cascadeId}`);
        this.emit('task:started', task);

        return task;
    }

    /**
     * Mark a task as complete.
     */
    complete(cascadeId, result = null) {
        const task = this._running.get(cascadeId);
        if (!task) return null;

        task.status = 'complete';
        task.completedAt = Date.now();
        task.result = result;

        this._running.delete(cascadeId);
        this._addHistory(task);

        const duration = task.completedAt - task.startedAt;
        L.info(`Task complete: ${task.id} (${Math.round(duration / 1000)}s)`);
        this.emit('task:complete', task);

        return task;
    }

    /**
     * Mark a task as failed.
     */
    fail(cascadeId, error = 'unknown') {
        const task = this._running.get(cascadeId);
        if (!task) return null;

        task.status = 'failed';
        task.completedAt = Date.now();
        task.error = error;

        this._running.delete(cascadeId);
        this._addHistory(task);

        L.error(`Task failed: ${task.id} — ${error}`);
        this.emit('task:failed', task);

        return task;
    }

    /**
     * Check if a cascade is busy (running a task).
     */
    isBusy(cascadeId) {
        return this._running.has(cascadeId);
    }

    /**
     * Get the running task for a cascade.
     */
    getRunning(cascadeId) {
        return this._running.get(cascadeId) || null;
    }

    /**
     * Get all pending tasks.
     */
    getPending() {
        return this._queue.filter(t => t.status === 'pending');
    }

    /**
     * Get task history.
     */
    getHistory(limit = 20) {
        return this._history.slice(-limit);
    }

    /**
     * Get queue stats.
     */
    stats() {
        return {
            pending: this._queue.length,
            running: this._running.size,
            completed: this._history.filter(t => t.status === 'complete').length,
            failed: this._history.filter(t => t.status === 'failed').length,
            maxSize: this.maxSize,
        };
    }

    /**
     * Cancel a pending task by ID.
     */
    cancel(taskId) {
        const idx = this._queue.findIndex(t => t.id === taskId);
        if (idx === -1) return false;
        const task = this._queue.splice(idx, 1)[0];
        task.status = 'cancelled';
        task.completedAt = Date.now();
        this._addHistory(task);
        L.info(`Task cancelled: ${taskId}`);
        this.emit('task:cancelled', task);
        return true;
    }

    // --- Private ---

    _addHistory(task) {
        this._history.push(task);
        if (this._history.length > this._maxHistory) {
            this._history.shift();
        }
    }
}
