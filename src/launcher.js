/**
 * Launcher — Auto-launch and manage Antigravity IDE instances.
 * Spawns child processes with the correct --remote-debugging-port and folder.
 * Auto-restarts crashed instances.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { log as logger } from './gateway/logger.js';

const log = logger.scope('launcher');

export class Launcher {
    constructor(opts = {}) {
        // Antigravity command — auto-detect or use env override
        this.cmd = opts.cmd || process.env.ANTIGRAVITY_CMD || this._detectCmd();
        this.processes = new Map(); // port → { proc, name, folder, host, port, restarts, maxRestarts }
        this.maxRestarts = opts.maxRestarts ?? 3;
        this.restartDelay = opts.restartDelay ?? 5000; // 5s before restart
        this.onStatusChange = opts.onStatusChange || null; // callback(port, status)
    }

    /**
     * Auto-detect the Antigravity CLI command on this system
     */
    _detectCmd() {
        // Common names for Antigravity / VS Code forks
        const candidates = [
            'antigravity',     // Primary
            'cursor',          // Cursor fork
            'code',            // VS Code fallback
            'windsurf',        // Windsurf fork
        ];

        // On Windows, check for .cmd variants
        if (process.platform === 'win32') {
            for (const c of candidates) {
                // spawn will find .cmd on PATH automatically
                return c;
            }
        }

        return candidates[0]; // Default to 'antigravity'
    }

    /**
     * Launch an Antigravity instance for a project
     * @param {Object} project - { name, folder, host, port }
     * @returns {{ ok: boolean, message: string, pid?: number }}
     */
    launch(project) {
        const { name, folder, host, port } = project;
        const portNum = parseInt(port);

        // Already running?
        if (this.processes.has(portNum)) {
            const existing = this.processes.get(portNum);
            if (existing.proc && !existing.proc.killed) {
                return { ok: false, message: `Already running on port ${portNum} (PID ${existing.proc.pid})` };
            }
        }

        // Build command args
        const args = [
            `--remote-debugging-port=${portNum}`,
        ];

        // Add folder if provided and exists
        if (folder) {
            // Don't validate folder existence — Antigravity can create it or the user might have a remote path
            args.push(folder);
        }

        log.info(`Launching: ${this.cmd} ${args.join(' ')}`);

        try {
            const proc = spawn(this.cmd, args, {
                detached: true, // Don't die when Opengravity exits
                stdio: 'ignore', // Don't pipe stdio
                shell: true, // Required on Windows for .cmd detection
                windowsHide: false, // Show the window
            });

            // Don't keep Opengravity alive just for this child
            proc.unref();

            const entry = {
                proc,
                name: name || `Agent ${portNum}`,
                folder: folder || '',
                host: host || 'localhost',
                port: portNum,
                restarts: 0,
                maxRestarts: this.maxRestarts,
                startedAt: Date.now(),
                lastRestart: null,
            };

            this.processes.set(portNum, entry);

            // Handle exit — auto-restart if unexpected
            proc.on('exit', (code, signal) => {
                log.warn(`Process on port ${portNum} exited (code=${code}, signal=${signal})`);
                this._handleExit(portNum, code, signal);
            });

            proc.on('error', (err) => {
                log.error(`Failed to launch on port ${portNum}: ${err.message}`);
                this.processes.delete(portNum);
                if (this.onStatusChange) this.onStatusChange(portNum, 'error', err.message);
            });

            log.info(`Started ${entry.name} on port ${portNum} (PID ${proc.pid})`);
            if (this.onStatusChange) this.onStatusChange(portNum, 'launched', proc.pid);

            return { ok: true, message: `Launched ${entry.name} on port ${portNum}`, pid: proc.pid };

        } catch (err) {
            log.error(`Launch failed: ${err.message}`);
            return { ok: false, message: `Launch failed: ${err.message}` };
        }
    }

    /**
     * Handle process exit — auto-restart if appropriate
     */
    _handleExit(port, code, signal) {
        const entry = this.processes.get(port);
        if (!entry) return;

        // Normal exit (user closed the window) — don't restart
        if (code === 0 || signal === 'SIGTERM') {
            log.info(`Port ${port}: Normal exit, not restarting`);
            this.processes.delete(port);
            if (this.onStatusChange) this.onStatusChange(port, 'stopped');
            return;
        }

        // Crash — auto-restart if under limit
        if (entry.restarts < entry.maxRestarts) {
            entry.restarts++;
            entry.lastRestart = Date.now();
            log.warn(`Port ${port}: Crash detected, restart ${entry.restarts}/${entry.maxRestarts} in ${this.restartDelay}ms`);

            if (this.onStatusChange) this.onStatusChange(port, 'restarting', entry.restarts);

            setTimeout(() => {
                if (this.processes.has(port)) {
                    log.info(`Port ${port}: Auto-restarting...`);
                    this.processes.delete(port); // Clear old entry
                    this.launch({
                        name: entry.name,
                        folder: entry.folder,
                        host: entry.host,
                        port: entry.port,
                    });
                }
            }, this.restartDelay);
        } else {
            log.error(`Port ${port}: Max restarts (${entry.maxRestarts}) reached, giving up`);
            this.processes.delete(port);
            if (this.onStatusChange) this.onStatusChange(port, 'failed');
        }
    }

    /**
     * Stop a running instance
     */
    stop(port) {
        const portNum = parseInt(port);
        const entry = this.processes.get(portNum);
        if (!entry || !entry.proc) {
            return { ok: false, message: `No process on port ${portNum}` };
        }

        // Prevent auto-restart
        entry.maxRestarts = 0;

        try {
            // On Windows, need to kill the process tree
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', entry.proc.pid, '/T', '/F'], { shell: true });
            } else {
                process.kill(-entry.proc.pid, 'SIGTERM');
            }
            this.processes.delete(portNum);
            log.info(`Stopped process on port ${portNum}`);
            return { ok: true, message: `Stopped ${entry.name} on port ${portNum}` };
        } catch (err) {
            return { ok: false, message: `Failed to stop: ${err.message}` };
        }
    }

    /**
     * Get status of all managed processes
     */
    getStatus() {
        const result = {};
        for (const [port, entry] of this.processes) {
            result[port] = {
                name: entry.name,
                folder: entry.folder,
                host: entry.host,
                port: entry.port,
                pid: entry.proc?.pid,
                running: entry.proc && !entry.proc.killed,
                restarts: entry.restarts,
                startedAt: entry.startedAt,
                lastRestart: entry.lastRestart,
            };
        }
        return result;
    }

    /**
     * Stop all managed processes
     */
    stopAll() {
        for (const [port] of this.processes) {
            this.stop(port);
        }
        log.info('All managed processes stopped');
    }
}
