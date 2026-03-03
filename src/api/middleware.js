/**
 * API Middleware — authentication and rate limiting for the REST API.
 * 
 * Auth: Simple Bearer token or X-API-Key header.
 * Rate limit: Token bucket per IP, configurable window and max requests.
 */
import { log } from '../gateway/logger.js';

const L = log.scope('api-auth');

/**
 * Create an API key authentication middleware.
 * Skips auth for dashboard routes (/, /public/*, /ws) — only protects /api/v1/*.
 * 
 * @param {object} opts
 * @param {string} opts.apiKey - The API key to validate against
 * @param {boolean} [opts.enabled=true] - Whether auth is enabled
 * @returns {Function} Express middleware
 */
export function createAuthMiddleware(opts = {}) {
    const apiKey = opts.apiKey || process.env.API_KEY || '';
    const enabled = opts.enabled !== false && apiKey.length > 0;

    if (!enabled) {
        L.warn('API auth DISABLED — no API_KEY set. All API routes are open.');
        return (req, res, next) => next();
    }

    L.info(`API auth enabled (key: ${apiKey.substring(0, 4)}...)`);

    return (req, res, next) => {
        // Only protect /api/* routes
        if (!req.path.startsWith('/api/')) return next();

        // Check Authorization header or X-API-Key
        const headerKey = req.headers['x-api-key']
            || req.headers['authorization']?.replace(/^Bearer\s+/i, '')
            || req.query.key;

        if (headerKey === apiKey) {
            return next();
        }

        L.warn(`Auth rejected: ${req.method} ${req.path} from ${req.ip}`);
        res.status(401).json({
            ok: false,
            error: 'Unauthorized',
            message: 'Provide a valid API key via X-API-Key header, Authorization: Bearer, or ?key= query param',
        });
    };
}

/**
 * Token bucket rate limiter per IP.
 * 
 * @param {object} opts
 * @param {number} [opts.maxRequests=60] - Max requests per window
 * @param {number} [opts.windowMs=60000] - Window duration in ms (default: 1 minute)
 * @param {boolean} [opts.enabled=true] - Whether rate limiting is enabled
 * @returns {Function} Express middleware
 */
export function createRateLimiter(opts = {}) {
    const maxRequests = opts.maxRequests || 60;
    const windowMs = opts.windowMs || 60000;
    const enabled = opts.enabled !== false;

    if (!enabled) return (req, res, next) => next();

    const buckets = new Map(); // ip → { tokens, lastRefill }

    // Cleanup stale entries every 5 minutes
    setInterval(() => {
        const cutoff = Date.now() - windowMs * 2;
        for (const [ip, bucket] of buckets) {
            if (bucket.lastRefill < cutoff) buckets.delete(ip);
        }
    }, 300000);

    return (req, res, next) => {
        // Only rate-limit API routes
        if (!req.path.startsWith('/api/')) return next();

        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();

        let bucket = buckets.get(ip);
        if (!bucket) {
            bucket = { tokens: maxRequests, lastRefill: now };
            buckets.set(ip, bucket);
        }

        // Refill tokens based on elapsed time
        const elapsed = now - bucket.lastRefill;
        const refill = Math.floor(elapsed / windowMs) * maxRequests;
        if (refill > 0) {
            bucket.tokens = Math.min(maxRequests, bucket.tokens + refill);
            bucket.lastRefill = now;
        }

        // Set rate limit headers
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(Math.max(0, bucket.tokens - 1)));
        res.set('X-RateLimit-Window', String(windowMs));

        if (bucket.tokens <= 0) {
            const retryAfter = Math.ceil((windowMs - elapsed) / 1000);
            res.set('Retry-After', String(retryAfter));
            L.warn(`Rate limited: ${ip} (${req.method} ${req.path})`);
            return res.status(429).json({
                ok: false,
                error: 'Too Many Requests',
                retryAfter,
            });
        }

        bucket.tokens--;
        next();
    };
}
