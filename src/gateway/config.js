/**
 * Config — loads and manages opengravity.json configuration.
 * Merges file config with environment variables (.env).
 * Creates default config if none exists.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../opengravity.json');

const L = log.scope('config');

const DEFAULT_CONFIG = {
    instances: [],
    defaults: {
        autoAccept: false,
        pollInterval: 2000,
        discoveryInterval: 10000,
        monitorInterval: 2000,
        maxQueueSize: 50,
        port: 3000,
    },
    cdpPorts: [9000, 9001, 9002, 9003],
    cron: [],
    telegram: {
        token: '',
        allowedUsers: '',
    },
};

class Config {
    constructor() {
        this._config = null;
        this._path = CONFIG_PATH;
    }

    /**
     * Load config from file, merging with defaults and env vars.
     * Creates default config file if none exists.
     */
    load() {
        let fileConfig = {};

        if (existsSync(this._path)) {
            try {
                const raw = readFileSync(this._path, 'utf-8');
                fileConfig = JSON.parse(raw);
                L.info(`Loaded config from ${this._path}`);
            } catch (e) {
                L.error(`Failed to parse config: ${e.message}`);
            }
        } else {
            L.info('No opengravity.json found — creating default config');
            this._writeDefault();
        }

        // Deep merge: defaults < file < env
        this._config = this._deepMerge(DEFAULT_CONFIG, fileConfig);
        this._applyEnv();

        return this._config;
    }

    /**
     * Get the full config object.
     */
    get() {
        if (!this._config) this.load();
        return this._config;
    }

    /**
     * Get a specific value by dot-path (e.g. 'defaults.pollInterval').
     */
    val(path, fallback) {
        const parts = path.split('.');
        let obj = this.get();
        for (const p of parts) {
            if (obj == null || typeof obj !== 'object') return fallback;
            obj = obj[p];
        }
        return obj ?? fallback;
    }

    /**
     * Save current config back to file.
     */
    save() {
        try {
            writeFileSync(this._path, JSON.stringify(this._config, null, 2), 'utf-8');
            L.info('Config saved');
        } catch (e) {
            L.error(`Failed to save config: ${e.message}`);
        }
    }

    /**
     * Get instance config by name (case-insensitive).
     */
    getInstance(name) {
        const lower = name.toLowerCase();
        return this.val('instances', []).find(i =>
            i.name?.toLowerCase() === lower ||
            i.workspace?.toLowerCase() === lower
        );
    }

    /**
     * Get all registered instances.
     */
    getInstances() {
        return this.val('instances', []);
    }

    /**
     * Get all CDP ports (from instances + cdpPorts config).
     * Returns array of { port, host } objects.
     */
    getCDPTargets() {
        const targets = new Set();
        const result = [];

        // From explicit cdpPorts
        for (const p of this.val('cdpPorts', [])) {
            const port = typeof p === 'object' ? p.port : p;
            const host = typeof p === 'object' ? p.host : '127.0.0.1';
            const key = `${host}:${port}`;
            if (!targets.has(key)) {
                targets.add(key);
                result.push({ port, host });
            }
        }

        // From named instances
        for (const inst of this.val('instances', [])) {
            if (inst.port) {
                const host = inst.host || '127.0.0.1';
                const key = `${host}:${inst.port}`;
                if (!targets.has(key)) {
                    targets.add(key);
                    result.push({ port: inst.port, host });
                }
            }
        }

        return result;
    }

    // --- Private ---

    _writeDefault() {
        try {
            writeFileSync(this._path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
        } catch (e) {
            L.warn(`Could not write default config: ${e.message}`);
        }
    }

    _applyEnv() {
        // Env vars override file config
        if (process.env.TELEGRAM_BOT_TOKEN) {
            this._config.telegram.token = process.env.TELEGRAM_BOT_TOKEN;
        }
        if (process.env.ALLOWED_USER_IDS) {
            this._config.telegram.allowedUsers = process.env.ALLOWED_USER_IDS;
        }
        if (process.env.PORT) {
            this._config.defaults.port = parseInt(process.env.PORT);
        }
        if (process.env.CDP_PORTS) {
            this._config.cdpPorts = process.env.CDP_PORTS.split(',').map(Number);
        }
        if (process.env.DISCOVERY_INTERVAL) {
            this._config.defaults.discoveryInterval = parseInt(process.env.DISCOVERY_INTERVAL);
        }
        if (process.env.POLL_INTERVAL) {
            this._config.defaults.pollInterval = parseInt(process.env.POLL_INTERVAL);
        }
        if (process.env.MONITOR_INTERVAL) {
            this._config.defaults.monitorInterval = parseInt(process.env.MONITOR_INTERVAL);
        }
    }

    _deepMerge(target, source) {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = this._deepMerge(target[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }
}

export const config = new Config();
