/**
 * API Middleware — authentication and rate limiting for the REST API.
 * 
 * Auth modes:
 *   1. Static API key (API_KEY env) — simple Bearer/X-API-Key header
 *   2. JWT tokens (API_SECRET env) — HMAC-SHA256 signed, expires in 24h
 * 
 * Rate limit: Token bucket per IP, configurable window and max requests.
 */
import { createHmac } from 'node:crypto';
import { log } from '../gateway/logger.js';

const L = log.scope('api-auth');

// ── Minimal JWT (zero dependencies, HMAC-SHA256) ──
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64dec = (str) => Buffer.from(str, 'base64url');

function signJWT(payload, secret, expiresIn = 86400) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresIn }));
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}

function verifyJWT(token, secret) {
    try {
        const [header, body, sig] = token.split('.');
        if (!header || !body || !sig) return null;
        const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
        if (sig !== expected) return null;
        const payload = JSON.parse(b64dec(body).toString());
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch { return null; }
}

/**
 * Create an API key + JWT authentication middleware.
 * Skips auth for dashboard routes — only protects /api/v1/*.
 * 
 * @param {object} opts
 * @param {string} opts.apiKey - Static API key
 * @param {string} opts.apiSecret - JWT signing secret
 * @returns {Function} Express middleware
 */
export function createAuthMiddleware(opts = {}) {
    const apiKey = opts.apiKey || process.env.API_KEY || '';
    const apiSecret = opts.apiSecret || process.env.API_SECRET || '';
    const hasKey = apiKey.length > 0;
    const hasJWT = apiSecret.length > 0;

    if (!hasKey && !hasJWT) {
        L.warn('API auth DISABLED — no API_KEY or API_SECRET set. All API routes are open.');
        return (req, res, next) => next();
    }

    if (hasJWT) L.info('JWT auth enabled (HMAC-SHA256)');
    if (hasKey) L.info(`API key auth enabled (key: ${apiKey.substring(0, 4)}...)`);

    return (req, res, next) => {
        if (!req.path.startsWith('/api/')) return next();

        // Allow token generation endpoint without auth
        if (req.path === '/api/v1/auth/token' && req.method === 'POST') return next();

        const headerKey = req.headers['x-api-key']
            || req.headers['authorization']?.replace(/^Bearer\s+/i, '')
            || req.query.key;

        // Check static API key
        if (hasKey && headerKey === apiKey) return next();

        // Check JWT
        if (hasJWT && headerKey) {
            const payload = verifyJWT(headerKey, apiSecret);
            if (payload) {
                req.jwtPayload = payload;
                return next();
            }
        }

        L.warn(`Auth rejected: ${req.method} ${req.path} from ${req.ip}`);
        res.status(401).json({
            ok: false,
            error: 'Unauthorized',
            message: 'Provide a valid API key or JWT token via X-API-Key header, Authorization: Bearer, or ?key= query param',
        });
    };
}

/**
 * Register JWT token generation endpoint.
 * Requires API_SECRET and a valid API_KEY to generate tokens.
 */
export function registerAuthRoutes(app) {
    const apiKey = process.env.API_KEY || '';
    const apiSecret = process.env.API_SECRET || '';

    if (!apiSecret) return;

    app.post('/api/v1/auth/token', (req, res) => {
        const { key, expiresIn, label } = req.body || {};

        // Require valid API key to generate JWT
        if (apiKey && key !== apiKey) {
            return res.status(401).json({ ok: false, error: 'Invalid API key' });
        }

        const ttl = Math.min(expiresIn || 86400, 604800); // max 7 days
        const token = signJWT({ sub: 'api', label: label || 'default' }, apiSecret, ttl);

        res.json({
            ok: true,
            token,
            expiresIn: ttl,
            expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        });
    });

    L.info('JWT token endpoint registered: POST /api/v1/auth/token');
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
