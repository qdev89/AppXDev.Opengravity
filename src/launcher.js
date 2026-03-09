/**
 * Launcher — Launch and manage Antigravity IDE instances.
 *
 * STRATEGY:
 * 1. If CDP port is already active → connect directly (someone already ran Antigravity with CDP)
 * 2. If no existing Antigravity is running → launch fresh with --remote-debugging-port (remoat style)
 * 3. If Antigravity IS running but without CDP → launch a SECOND instance with:
 *    --remote-debugging-port + --user-data-dir (for isolation from running instance)
 *    --extensions-dir (pointing to main profile extensions, so no re-install needed)
 *
 * On Windows: uses a .bat file for reliable detached launch.
 * On Unix: uses spawn with detached:true.
 */
import { spawn, execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, readdirSync, rmSync, readFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import * as http from 'http';
import { log as logger } from './gateway/logger.js';

const log = logger.scope('launcher');

/**
 * Check if CDP responds on the specified port.
 */
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try { resolve(Array.isArray(JSON.parse(data))); }
                catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
}

/**
 * Check if any Antigravity process is currently running.
 */
function isAntigravityRunning() {
    if (process.platform === 'win32') {
        try {
            const result = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf-8', timeout: 5000 });
            return result.includes('Antigravity.exe');
        } catch { return false; }
    }
    try {
        execSync('pgrep -x Antigravity || pgrep -x antigravity', { encoding: 'utf-8', timeout: 5000 });
        return true;
    } catch { return false; }
}

/**
 * Locate the main Antigravity user profile directory.
 * Returns the path to the "User" folder or null if not found.
 */
function findMainProfile() {
    const appData = process.env.APPDATA || '';
    const candidates = [
        join(appData, 'Antigravity', 'User'),
        join(appData, 'Antigravity IDE', 'User'),
        join(appData, 'Code', 'User'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

export class Launcher {
    constructor(opts = {}) {
        this.cmd = opts.cmd || process.env.ANTIGRAVITY_CMD || null;
        this.processes = new Map();
        this.onStatusChange = opts.onStatusChange || null;
    }

    /**
     * Auto-detect the Antigravity binary path.
     */
    _detectBinary() {
        if (this.cmd) return this.cmd;
        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA || '';
            const candidates = [
                join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
                join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
                join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
            ];
            for (const p of candidates) {
                if (existsSync(p)) {
                    log.info(`Detected binary: ${p}`);
                    return p;
                }
            }
            return 'Antigravity.exe';
        }
        return 'antigravity';
    }

    /**
     * Prepare user-data-dir for an isolated instance.
     * - Clears stale Electron lock files so we don't get code 9 failures.
     * - Copies settings, globalStorage, and key state from main Antigravity profile.
     * - The globalStorage/storage.json contains onboarding completion flags
     *   (e.g. unifiedStateSync.hasOnboardingMigrated) that prevent the
     *   "Welcome to Antigravity" wizard from appearing.
     */
    _prepareProfile(port) {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const profileDir = join(home, '.opengravity', 'profiles', `port-${port}`);
        mkdirSync(profileDir, { recursive: true });

        // Clear stale Electron singleton locks
        for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            const lockPath = join(profileDir, lock);
            try { rmSync(lockPath, { force: true }); } catch { }
        }

        // ── Bootstrap from main Antigravity profile ──
        const mainProfile = findMainProfile();
        if (!mainProfile) {
            log.warn('Could not locate main Antigravity profile — isolated instance may show onboarding');
            return profileDir;
        }

        const profileUserDir = join(profileDir, 'User');
        mkdirSync(profileUserDir, { recursive: true });

        // Files to copy from User/ directory
        const userFiles = ['settings.json', 'keybindings.json'];
        for (const file of userFiles) {
            const src = join(mainProfile, file);
            const dst = join(profileUserDir, file);
            if (existsSync(src) && !existsSync(dst)) {
                try {
                    copyFileSync(src, dst);
                    log.info(`Bootstrapped ${file} from main profile → port-${port}`);
                } catch (err) {
                    log.warn(`Failed to copy ${file}: ${err.message}`);
                }
            }
        }

        // Copy snippets directory
        const mainSnippetsDir = join(mainProfile, 'snippets');
        const isoSnippetsDir = join(profileUserDir, 'snippets');
        if (existsSync(mainSnippetsDir) && !existsSync(isoSnippetsDir)) {
            try {
                mkdirSync(isoSnippetsDir, { recursive: true });
                for (const f of readdirSync(mainSnippetsDir)) {
                    copyFileSync(join(mainSnippetsDir, f), join(isoSnippetsDir, f));
                }
            } catch { }
        }

        // ── CRITICAL: Copy globalStorage (contains onboarding state) ──
        // The key file is globalStorage/storage.json which contains:
        //   - unifiedStateSync.hasOnboardingMigrated
        //   - antigravityUnifiedStateSync.seenNuxOneTimeMigration
        //   - antigravityUnifiedStateSync.agentPreferences.*
        //   - antigravityUnifiedStateSync.modelPreferences.*
        // Without this, the "Welcome to Antigravity" wizard appears every launch.
        const mainGlobalStorage = join(mainProfile, 'globalStorage');
        const isoGlobalStorage = join(profileUserDir, 'globalStorage');
        mkdirSync(isoGlobalStorage, { recursive: true });

        const globalStorageFiles = ['storage.json', 'state.vscdb', 'state.vscdb.backup'];
        for (const file of globalStorageFiles) {
            const src = join(mainGlobalStorage, file);
            const dst = join(isoGlobalStorage, file);
            if (existsSync(src) && !existsSync(dst)) {
                try {
                    copyFileSync(src, dst);
                    log.info(`Bootstrapped globalStorage/${file} → port-${port}`);
                } catch (err) {
                    log.warn(`Failed to copy globalStorage/${file}: ${err.message}`);
                }
            }
        }

        // ── Ensure settings have onboarding-skip flags ──
        const isolatedSettingsPath = join(profileUserDir, 'settings.json');
        try {
            let settings = {};
            if (existsSync(isolatedSettingsPath)) {
                settings = JSON.parse(readFileSync(isolatedSettingsPath, 'utf-8'));
            }
            let modified = false;
            const skipFlags = {
                'workbench.welcome.enabled': false,
                'workbench.startupEditor': 'none',
                'workbench.tips.enabled': false,
                'update.showReleaseNotes': false,
            };
            for (const [key, val] of Object.entries(skipFlags)) {
                if (settings[key] === undefined) {
                    settings[key] = val;
                    modified = true;
                }
            }
            if (modified) {
                writeFileSync(isolatedSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            }
        } catch { }

        return profileDir;
    }


    /**
     * Build the argument list for launching Antigravity.
     */
    _buildArgs(port, folder, { needsIsolation = false } = {}) {
        const args = [`--remote-debugging-port=${port}`];

        if (needsIsolation) {
            // Need --user-data-dir to bypass Electron's single-instance lock
            const profileDir = this._prepareProfile(port);
            args.push(`--user-data-dir=${profileDir}`);

            // NOTE: We no longer use --disable-extensions globally.
            // Extensions are kept so the IDE works normally (settings, theme, etc.)
            // If specific extensions cause CDP conflicts, disable them individually
            // via settings.json instead.

            args.push('--no-sandbox');
        }

        if (folder) args.push(folder);
        return args;
    }

    /**
     * Generate a .bat launcher file (Windows only).
     */
    _generateBatLauncher(binary, args, port) {
        const home = process.env.USERPROFILE || '';
        const launcherDir = join(home, '.opengravity', 'launchers');
        mkdirSync(launcherDir, { recursive: true });

        const batPath = join(launcherDir, `launch-${port}.bat`);
        const argsStr = args.map(a => `"${a}"`).join(' ');

        const batContent = [
            '@echo off',
            `rem Auto-generated by Opengravity — launch Antigravity on port ${port}`,
            `start "" "${binary}" ${argsStr}`,
            `exit /b 0`,
        ].join('\r\n');

        writeFileSync(batPath, batContent, 'utf-8');
        log.info(`Generated launcher: ${batPath}`);
        return batPath;
    }

    /**
     * Launch an Antigravity instance for a project.
     */
    async launch(project) {
        const { name, folder, host, port } = project;
        const portNum = parseInt(port);

        // If port is tracked, check if CDP is actually still alive
        if (this.processes.has(portNum)) {
            const alive = await checkPort(portNum);
            if (alive) {
                return { ok: true, message: `Port ${portNum} is already active and connected` };
            }
            // CDP is dead — clear stale entry and re-launch
            log.info(`Port ${portNum} was tracked but CDP is dead — re-launching`);
            this.processes.delete(portNum);
        }

        // Check if CDP port is already responding (someone else launched it)
        const alreadyRunning = await checkPort(portNum);
        if (alreadyRunning) {
            log.info(`CDP port ${portNum} already active`);
            const e = { name: name || `Agent ${portNum}`, folder: folder || '', host: host || 'localhost', port: portNum, pid: null, startedAt: Date.now() };
            this.processes.set(portNum, e);
            if (this.onStatusChange) this.onStatusChange(portNum, 'launched');
            return { ok: true, message: `Port ${portNum} already has CDP active` };
        }

        // Check if Antigravity is currently running (without CDP on this port)
        const needsIsolation = isAntigravityRunning();
        if (needsIsolation) {
            log.info(`Antigravity already running — will use isolated profile for port ${portNum}`);
        } else {
            log.info(`No Antigravity running — launching fresh on port ${portNum}`);
        }

        const binary = this._detectBinary();
        const args = this._buildArgs(portNum, folder, { needsIsolation });

        log.info(`Launching: "${binary}" ${args.join(' ')}`);

        try {
            if (process.platform === 'win32') {
                return this._launchWindows(binary, args, portNum, name, folder, host);
            } else {
                return this._launchUnix(binary, args, portNum, name, folder, host);
            }
        } catch (err) {
            log.error(`Launch failed: ${err.message}`);
            return { ok: false, message: `Launch failed: ${err.message}` };
        }
    }

    /**
     * Windows launch — .bat file with `start ""` for true process isolation.
     */
    _launchWindows(binary, args, portNum, name, folder, host) {
        const batPath = this._generateBatLauncher(binary, args, portNum);

        const child = spawn('cmd', ['/c', batPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();

        const entry = {
            name: name || `Agent ${portNum}`,
            folder: folder || '', host: host || 'localhost', port: portNum,
            pid: child.pid, startedAt: Date.now(),
        };
        this.processes.set(portNum, entry);

        child.on('exit', (code) => {
            log.info(`Port ${portNum}: Bat launcher exited (code=${code})`);
        });
        child.on('error', (err) => {
            log.error(`Failed to launch on port ${portNum}: ${err.message}`);
            this.processes.delete(portNum);
            if (this.onStatusChange) this.onStatusChange(portNum, 'error', err.message);
        });

        log.info(`Started ${entry.name} on port ${portNum} via .bat launcher`);
        if (this.onStatusChange) this.onStatusChange(portNum, 'launched', child.pid);
        return { ok: true, message: `Launched ${entry.name} on port ${portNum}`, pid: child.pid };
    }

    /**
     * Unix launch — spawn detached.
     */
    _launchUnix(binary, args, portNum, name, folder, host) {
        const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
        child.unref();

        const entry = {
            name: name || `Agent ${portNum}`,
            folder: folder || '', host: host || 'localhost', port: portNum,
            pid: child.pid, startedAt: Date.now(),
        };
        this.processes.set(portNum, entry);

        child.on('exit', (code) => {
            log.info(`Port ${portNum}: Parent exited (code=${code})`);
        });
        child.on('error', (err) => {
            log.error(`Failed to launch on port ${portNum}: ${err.message}`);
            this.processes.delete(portNum);
            if (this.onStatusChange) this.onStatusChange(portNum, 'error', err.message);
        });

        log.info(`Started ${entry.name} on port ${portNum} (PID ${child.pid})`);
        if (this.onStatusChange) this.onStatusChange(portNum, 'launched', child.pid);
        return { ok: true, message: `Launched ${entry.name} on port ${portNum}`, pid: child.pid };
    }

    stop(port) {
        const portNum = parseInt(port);
        const entry = this.processes.get(portNum);
        if (!entry) return { ok: false, message: `No process found on port ${portNum}` };
        try {
            if (entry.pid) {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
                } else {
                    process.kill(-entry.pid, 'SIGTERM');
                }
            }
            this.processes.delete(portNum);
            return { ok: true, message: `Stopped ${entry.name} on port ${portNum}` };
        } catch (err) {
            return { ok: false, message: `Failed to stop: ${err.message}` };
        }
    }

    getStatus() {
        const r = {};
        for (const [port, entry] of this.processes) r[port] = { ...entry };
        return r;
    }

    stopAll() {
        for (const [p] of this.processes) this.stop(p);
    }
}
