/**
 * Logger — structured, leveled logging for Opengravity Gateway.
 * Supports: debug, info, warn, error with emoji prefixes and timestamps.
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

function setLevel(level) {
    currentLevel = LEVELS[level] ?? LEVELS.info;
}

function ts() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function fmt(level, prefix, scope, msg, ...args) {
    if (LEVELS[level] < currentLevel) return;
    const tag = scope ? `[${scope}]` : '';
    console.log(`${ts()} ${prefix} ${tag} ${msg}`, ...args);
}

const log = {
    debug: (scope, msg, ...args) => fmt('debug', '🔍', scope, msg, ...args),
    info:  (scope, msg, ...args) => fmt('info',  'ℹ️ ', scope, msg, ...args),
    warn:  (scope, msg, ...args) => fmt('warn',  '⚠️ ', scope, msg, ...args),
    error: (scope, msg, ...args) => fmt('error', '❌', scope, msg, ...args),
    
    // Shortcut: create a scoped logger
    scope: (name) => ({
        debug: (msg, ...args) => log.debug(name, msg, ...args),
        info:  (msg, ...args) => log.info(name, msg, ...args),
        warn:  (msg, ...args) => log.warn(name, msg, ...args),
        error: (msg, ...args) => log.error(name, msg, ...args),
    }),

    setLevel,
};

export { log };
