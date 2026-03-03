/**
 * Session Manager — tracks per-cascade conversation state.
 * Each cascade maintains its own session with message history,
 * task tracking, and phase information.
 */
import { EventEmitter } from 'events';
import { log } from './logger.js';

const L = log.scope('session');

export class SessionManager extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.maxMessages = opts.maxMessages || 200; // per session
        this._sessions = new Map(); // cascadeId → session
    }

    /**
     * Get or create a session for a cascade.
     */
    get(cascadeId) {
        if (!this._sessions.has(cascadeId)) {
            this._sessions.set(cascadeId, this._createSession(cascadeId));
            L.debug(`Session created for cascade ${cascadeId}`);
        }
        return this._sessions.get(cascadeId);
    }

    /**
     * Record a message sent to a cascade.
     */
    addUserMessage(cascadeId, text, source = 'unknown') {
        const session = this.get(cascadeId);
        const msg = {
            role: 'user',
            text,
            source,
            timestamp: Date.now(),
        };
        session.messages.push(msg);
        session.lastActivity = Date.now();
        session.messageCount++;

        // Trim old messages
        if (session.messages.length > this.maxMessages) {
            session.messages.splice(0, session.messages.length - this.maxMessages);
        }

        this.emit('message:user', { cascadeId, message: msg });
        return msg;
    }

    /**
     * Record an agent response from a cascade.
     */
    addAgentResponse(cascadeId, text, metadata = {}) {
        const session = this.get(cascadeId);
        const msg = {
            role: 'agent',
            text: text?.substring(0, 10000) || '', // cap at 10k chars
            timestamp: Date.now(),
            ...metadata,
        };
        session.messages.push(msg);
        session.lastActivity = Date.now();
        session.messageCount++;

        if (session.messages.length > this.maxMessages) {
            session.messages.splice(0, session.messages.length - this.maxMessages);
        }

        this.emit('message:agent', { cascadeId, message: msg });
        return msg;
    }

    /**
     * Update the phase for a cascade's session.
     */
    setPhase(cascadeId, phase, extra = {}) {
        const session = this.get(cascadeId);
        const prevPhase = session.phase;
        session.phase = phase;
        session.lastActivity = Date.now();

        if (phase === 'streaming' && prevPhase !== 'streaming') {
            session.taskStartTime = Date.now();
        }
        if (phase === 'complete' && session.taskStartTime) {
            session.lastTaskDuration = Date.now() - session.taskStartTime;
            session.taskStartTime = null;
            session.tasksCompleted++;
        }

        this.emit('phase', { cascadeId, phase, prevPhase, ...extra });
    }

    /**
     * Get recent messages for a cascade.
     */
    getMessages(cascadeId, limit = 20) {
        const session = this.get(cascadeId);
        return session.messages.slice(-limit);
    }

    /**
     * Get all session stats.
     */
    getAllStats() {
        const stats = [];
        for (const [id, session] of this._sessions) {
            stats.push({
                cascadeId: id,
                phase: session.phase,
                messageCount: session.messageCount,
                tasksCompleted: session.tasksCompleted,
                lastActivity: session.lastActivity,
                lastTaskDuration: session.lastTaskDuration,
            });
        }
        return stats;
    }

    /**
     * Remove a session (when cascade disconnects).
     */
    remove(cascadeId) {
        if (this._sessions.has(cascadeId)) {
            L.debug(`Session removed for cascade ${cascadeId}`);
            this._sessions.delete(cascadeId);
        }
    }

    /**
     * Clear all sessions.
     */
    clear() {
        this._sessions.clear();
    }

    // --- Private ---

    _createSession(cascadeId) {
        return {
            cascadeId,
            phase: 'idle',
            messages: [],
            messageCount: 0,
            tasksCompleted: 0,
            lastActivity: Date.now(),
            taskStartTime: null,
            lastTaskDuration: null,
            createdAt: Date.now(),
        };
    }
}
