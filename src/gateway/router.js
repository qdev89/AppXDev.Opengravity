/**
 * Router — maps project names and keywords to Antigravity cascade instances.
 * Supports: exact name match, workspace path match, keyword fuzzy match, default fallback.
 */
import { log } from './logger.js';

const L = log.scope('router');

export class Router {
    constructor(config, cdpManager) {
        this.config = config;
        this.cdp = cdpManager;
    }

    /**
     * Resolve a cascade ID from a project name, keyword, or explicit ID.
     * Resolution order:
     *   1. Explicit cascade ID (if starts with hash-like pattern)
     *   2. Config instance name match → find cascade on that port
     *   3. Cascade title fuzzy match
     *   4. Default: active cascade or first available
     *
     * @param {string} [target] - Project name, cascade ID, or null for default
     * @returns {{ cascade: object, instance: object|null, method: string } | null}
     */
    resolve(target) {
        const cascades = this.cdp.cascades;

        if (!target || cascades.size === 0) {
            const fallback = this.cdp.getActiveCascade();
            return fallback ? { cascade: fallback, instance: null, method: 'default' } : null;
        }

        // 1. Exact cascade ID
        if (cascades.has(target)) {
            return { cascade: cascades.get(target), instance: null, method: 'id' };
        }

        // 2. Config instance name → port → cascade
        const instance = this.config.getInstance(target);
        if (instance) {
            const host = instance.host || '127.0.0.1';
            const cascade = this._findByPort(instance.port, host);
            if (cascade) {
                L.debug(`Routed "${target}" → instance "${instance.name}" → port ${instance.port}`);
                return { cascade, instance, method: 'instance' };
            }
            L.warn(`Instance "${instance.name}" configured (port ${instance.port}) but no cascade found`);
        }

        // 3. Fuzzy match on cascade title
        const lowerTarget = target.toLowerCase();
        for (const [id, c] of cascades) {
            const title = (c.metadata?.chatTitle || '').toLowerCase();
            const windowTitle = (c.metadata?.windowTitle || '').toLowerCase();
            if (title.includes(lowerTarget) || windowTitle.includes(lowerTarget)) {
                L.debug(`Routed "${target}" → cascade "${c.metadata.chatTitle}" (fuzzy match)`);
                return { cascade: c, instance: null, method: 'fuzzy' };
            }
        }

        // 4. Smart keyword extraction from message
        const keywordMatch = this._matchKeywords(target);
        if (keywordMatch) return keywordMatch;

        // 5. Default fallback
        const fallback = this.cdp.getActiveCascade();
        if (fallback) {
            L.debug(`No match for "${target}", using default cascade`);
            return { cascade: fallback, instance: null, method: 'default' };
        }

        return null;
    }

    /**
     * Route a prompt to the best cascade.
     * Extracts project hints from the prompt text itself.
     * 
     * @param {string} prompt - The full prompt text
     * @param {string} [explicitTarget] - Explicit target override
     * @returns {{ cascade: object, instance: object|null, method: string } | null}
     */
    route(prompt, explicitTarget) {
        // Explicit target takes priority
        if (explicitTarget) {
            return this.resolve(explicitTarget);
        }

        // Try to extract project name from prompt keywords
        const instances = this.config.getInstances();
        const lowerPrompt = prompt.toLowerCase();

        for (const inst of instances) {
            const terms = [
                inst.name,
                inst.workspace,
                ...(inst.keywords || []),
            ].filter(Boolean).map(t => t.toLowerCase());

            for (const term of terms) {
                if (lowerPrompt.includes(term)) {
                    const cascade = this._findByPort(inst.port, inst.host || '127.0.0.1');
                    if (cascade) {
                        L.info(`Auto-routed prompt to "${inst.name}" (keyword: "${term}")`);
                        return { cascade, instance: inst, method: 'keyword' };
                    }
                }
            }
        }

        // Default
        return this.resolve(null);
    }

    /**
     * List all routeable targets (cascades with optional instance config overlay).
     */
    list() {
        const cascadeList = this.cdp.getCascadeList();
        const instances = this.config.getInstances();

        return cascadeList.map(c => {
            // Try to match to a config instance
            const inst = instances.find(i => {
                const host = i.host || '127.0.0.1';
                return i.port === c.port && host === (c.host || '127.0.0.1');
            });

            return {
                ...c,
                instanceName: inst?.name || null,
                workspace: inst?.workspace || null,
                keywords: inst?.keywords || [],
            };
        });
    }

    // --- Private ---

    _findByPort(port, host = '127.0.0.1') {
        for (const [, c] of this.cdp.cascades) {
            if (c.port === port && (c.host || '127.0.0.1') === host) {
                return c;
            }
        }
        return null;
    }

    _matchKeywords(text) {
        // Extract common project-related keywords
        const instances = this.config.getInstances();
        const words = text.toLowerCase().split(/\s+/);

        for (const inst of instances) {
            if (inst.keywords) {
                for (const kw of inst.keywords) {
                    if (words.includes(kw.toLowerCase())) {
                        const cascade = this._findByPort(inst.port, inst.host || '127.0.0.1');
                        if (cascade) {
                            return { cascade, instance: inst, method: 'keyword' };
                        }
                    }
                }
            }
        }
        return null;
    }
}
