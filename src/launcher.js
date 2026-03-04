/**
 * Launcher — Auto-launch and manage Antigravity IDE instances.
 * Spawns isolated Antigravity instances with --remote-debugging-port and project folder.
 * 
 * KEY INSIGHT (Windows/Electron):
 * Electron apps use a single-instance lock per user-data-dir. If an Antigravity
 * instance is already running (default profile), launching another instance with
 * the SAME profile just opens a new window in the existing process (ignoring
 * --remote-debugging-port). To create a truly independent instance with CDP enabled,
 * we MUST use a separate --user-data-dir AND ensure no lock file conflicts.
 * 
 * On Windows, we use PowerShell Start-Process for reliable detached process creation.
 */
import { spawn, exec } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { log as logger } from './gateway/logger.js';

const log = logger.scope('launcher');

export class Launcher {
    constructor(opts = {}) {
        this.cmd = opts.cmd || process.env.ANTIGRAVITY_CMD || null;
        this.processes = new Map(); // port → { name, folder, host, port, pid, startedAt }
        this.onStatusChange = opts.onStatusChange || null;
    }

    /**
     * Auto-detect the Antigravity Electron binary path.
     * Must find the .exe directly on Windows (not the CLI .cmd wrapper).
     */
    _detectBinary() {
        if (this.cmd) return this.cmd;

        if (process.platform === 'win32') {
            const home = process.env.USERPROFILE || process.env.HOME || '';
            const candidates = [
                join(home, 'AppData', 'Local', 'Programs', 'Antigravity', 'Antigravity.exe'),
                join(home, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
                join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
                join(home, 'AppData', 'Local', 'Programs', 'Windsurf', 'Windsurf.exe'),
                'C:\\Program Files\\Antigravity\\Antigravity.exe',
                'C:\\Program Files\\Microsoft VS Code\\Code.exe',
            ];
            for (const p of candidates) {
                if (existsSync(p)) {
                    log.info(`Detected binary: ${p}`);
                    return p;
                }
            }
        }

        return 'antigravity';
    }

    /**
     * Prepare an isolated user-data-dir for a port.
     * Clears any stale lock files from previous crashes.
     */
    _prepareProfile(portNum) {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const profileDir = join(home, '.opengravity', 'profiles', `port-${portNum}`);

        // Create profile dir if it doesn't exist
        mkdirSync(profileDir, { recursive: true });

        // Clear stale Electron lock files that would cause exit code 9
        const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
        for (const f of lockFiles) {
            const lockPath = join(profileDir, f);
            try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        }

        return profileDir;
    }

    /**
     * Launch an Antigravity instance for a project.
     * On Windows, uses PowerShell Start-Process for reliable detached launch.
     * @param {Object} project - { name, folder, host, port }
     * @returns {{ ok: boolean, message: string, pid?: number }}
     */
    launch(project) {
        const { name, folder, host, port } = project;
        const portNum = parseInt(port);

        // Already launched?
        if (this.processes.has(portNum)) {
            const existing = this.processes.get(portNum);
            return { ok: false, message: `Already launched on port ${portNum} (PID ${existing.pid})` };
        }

        const binary = this._detectBinary();
        const profileDir = this._prepareProfile(portNum);

        // Build arguments
        const extraArgs = [];
        if (folder) extraArgs.push(`"${folder}"`);

        const allArgs = [
            `--remote-debugging-port=${portNum}`,
            `--user-data-dir="${profileDir}"`,
            '--no-sandbox',
            ...extraArgs,
        ].join(' ');

        log.info(`Launching: "${binary}" ${allArgs}`);

        try {
            if (process.platform === 'win32') {
                return this._launchWindows(binary, allArgs, portNum, name, folder, host);
            } else {
                return this._launchUnix(binary, allArgs, portNum, name, folder, host);
            }
        } catch (err) {
            log.error(`Launch failed: ${err.message}`);
            return { ok: false, message: `Launch failed: ${err.message}` };
        }
    }

    /**
     * Windows launch — uses cmd /c start to create a truly independent process.
     * This bypasses Electron's single-instance lock issues with Node's spawn.
     */
    _launchWindows(binary, allArgs, portNum, name, folder, host) {
        // Use cmd /c start "" to launch a fully detached process
        // The empty quotes after 'start' are the window title (required when binary path has spaces)
        const cmd = `start "" "${binary}" ${allArgs}`;
        
        log.info(`Windows launch cmd: ${cmd}`);

        exec(cmd, { windowsHide: false, shell: 'cmd.exe' }, (err) => {
            if (err) {
                log.error(`Windows launch error: ${err.message}`);
                this.processes.delete(portNum);
                if (this.onStatusChange) this.onStatusChange(portNum, 'error', err.message);
            }
        });

        const entry = {
            name: name || `Agent ${portNum}`,
            folder: folder || '',
            host: host || 'localhost',
            port: portNum,
            pid: null, // cmd /c start doesn't give us the PID directly
            startedAt: Date.now(),
        };
        this.processes.set(portNum, entry);

        log.info(`Started ${entry.name} on port ${portNum} via cmd /c start`);
        if (this.onStatusChange) this.onStatusChange(portNum, 'launched');

        // After a delay, try to discover the actual PID
        setTimeout(() => this._discoverPid(portNum), 5000);

        return { ok: true, message: `Launched ${entry.name} on port ${portNum}` };
    }

    /**
     * Unix launch — standard spawn with detached
     */
    _launchUnix(binary, allArgs, portNum, name, folder, host) {
        const args = allArgs.replace(/"/g, '').split(' ');
        const proc = spawn(binary, args, {
            detached: true,
            stdio: 'ignore',
        });
        proc.unref();

        const entry = {
            name: name || `Agent ${portNum}`,
            folder: folder || '',
            host: host || 'localhost',
            port: portNum,
            pid: proc.pid,
            startedAt: Date.now(),
        };
        this.processes.set(portNum, entry);

        proc.on('exit', (code) => {
            // Electron parent fork exits normally (code 0) — the real app keeps running
            log.info(`Port ${portNum}: Parent exited (code=${code}), app should be running`);
        });

        proc.on('error', (err) => {
            log.error(`Failed to launch on port ${portNum}: ${err.message}`);
            this.processes.delete(portNum);
            if (this.onStatusChange) this.onStatusChange(portNum, 'error', err.message);
        });

        log.info(`Started ${entry.name} on port ${portNum} (PID ${proc.pid})`);
        if (this.onStatusChange) this.onStatusChange(portNum, 'launched', proc.pid);

        return { ok: true, message: `Launched ${entry.name} on port ${portNum}`, pid: proc.pid };
    }

    /**
     * Try to discover the PID of the launched Antigravity instance by checking
     * which process is listening on the CDP port.
     */
    _discoverPid(portNum) {
        if (process.platform !== 'win32') return;
        
        exec(`netstat -nao | findstr ":${portNum}.*LISTENING"`, (err, stdout) => {
            if (err || !stdout) return;
            // Parse: TCP    127.0.0.1:9009    0.0.0.0:0    LISTENING    12345
            const match = stdout.trim().match(/LISTENING\s+(\d+)/);
            if (match) {
                const pid = parseInt(match[1]);
                const entry = this.processes.get(portNum);
                if (entry) {
                    entry.pid = pid;
                    log.info(`Port ${portNum}: Discovered PID ${pid}`);
                }
            }
        });
    }

    /**
     * Stop a running instance by port
     */
    stop(port) {
        const portNum = parseInt(port);
        const entry = this.processes.get(portNum);
        if (!entry) {
            return { ok: false, message: `No process tracked on port ${portNum}` };
        }

        try {
            if (entry.pid) {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
                } else {
                    process.kill(-entry.pid, 'SIGTERM');
                }
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
                pid: entry.pid,
                startedAt: entry.startedAt,
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
