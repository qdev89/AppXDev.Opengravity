#!/usr/bin/env node
/**
 * Opengravity — Antigravity-Powered AI Gateway
 * 
 * Core reasoning engine: Antigravity IDE via Chrome DevTools Protocol.
 * Channels: Web Dashboard, Telegram Bot (existing), REST API (upcoming).
 * 
 * The Gateway orchestrator provides a unified API that all channels use.
 */
import 'dotenv/config';
import { config } from './src/gateway/config.js';
import { log } from './src/gateway/logger.js';
import { CDPManager } from './src/cdp/manager.js';
import { ResponseMonitor } from './src/monitor/response.js';
import { Gateway } from './src/gateway/index.js';
import { createWebServer } from './src/web/server.js';
import { TelegramBot } from './src/bot/telegram.js';
import { AutoAccept } from './src/automation/auto-accept.js';
import { CronScheduler } from './src/automation/cron.js';
import { RemoteBridge } from './src/distribution/remote.js';
import { HealthDashboard } from './src/distribution/health.js';

const L = log.scope('main');

async function main() {
    // Load config (opengravity.json + .env)
    const cfg = config.load();

    console.log('');
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │   Opengravity                      🧠  │');
    console.log('  │   Antigravity-Powered AI Gateway       │');
    console.log('  └──────────────────────────────────────┘');
    console.log('');

    // Set log level from env (default: info)
    if (process.env.LOG_LEVEL) {
        log.setLevel(process.env.LOG_LEVEL);
    }

    // ── 1. CDP Manager — connects to Antigravity instances ──
    const cdpTargets = config.getCDPTargets();
    const cdp = new CDPManager({
        ports: cdpTargets.length > 0 ? cdpTargets : cfg.cdpPorts,
        discoveryInterval: cfg.defaults.discoveryInterval,
        pollInterval: cfg.defaults.pollInterval,
    });

    // ── 2. Response Monitor — tracks agent activity phases ──
    const monitor = new ResponseMonitor(cdp, {
        pollInterval: cfg.defaults.monitorInterval,
    });

    // ── 3. Gateway — the brain (sessions, routing, queue) ──
    const gateway = new Gateway(cdp, monitor);

    // Gateway events for logging
    gateway.on('prompt:sent', ({ task, cascade }) => {
        L.info(`📤 Prompt sent to "${cascade.title}" [${task.source}]`);
    });
    gateway.on('task:complete', ({ cascadeId, task }) => {
        const duration = task ? `${Math.round((task.completedAt - task.startedAt) / 1000)}s` : '';
        L.info(`✅ Task complete on cascade ${cascadeId} ${duration}`);
    });
    gateway.on('instance:connected', (info) => {
        L.info(`🟢 Instance connected: "${info.title}" (${info.host}:${info.port})`);
    });
    gateway.on('instance:disconnected', (info) => {
        L.warn(`🔴 Instance disconnected: "${info.title}"`);
    });

    // ── 4. Web Server — dashboard + API ──
    const web = createWebServer(cdp, monitor, {
        port: cfg.defaults.port,
        gateway, // pass gateway for API access
    });

    // ── 5. Telegram Bot — mobile remote control ──
    const telegram = new TelegramBot(cdp, monitor, {
        token: cfg.telegram.token,
        allowedUsers: cfg.telegram.allowedUsers,
        gateway, // pass gateway for unified routing
    });

    // ── 6. Auto-Accept Engine ──
    const autoAccept = new AutoAccept(cdp, gateway, {
        mode: cfg.defaults.autoAccept ? 'all' : 'off',
        pollInterval: cfg.defaults.pollInterval,
    });

    autoAccept.on('clicked', ({ title, count, labels }) => {
        L.info(`🤖 Auto-accepted ${count} dialog(s) on "${title}": ${labels.join(', ')}`);
    });

    // ── 7. Cron Scheduler ──
    const cron = new CronScheduler(gateway, {
        checkInterval: 60000, // check every minute
    });
    cron.loadJobs(cfg.cron);

    cron.on('job:executed', ({ job, result, trigger }) => {
        L.info(`⏰ Cron "${job}" [${trigger}]: ${result.ok ? '✅' : '❌ ' + result.reason}`);
    });

    // Make automation accessible on gateway for API
    gateway.autoAccept = autoAccept;
    gateway.cron = cron;

    // ── 8. Remote Bridge — connect to remote Antigravity instances ──
    const remoteBridge = new RemoteBridge(cdp, gateway);
    remoteBridge.load(cfg.remotes || []);
    gateway.remoteBridge = remoteBridge;

    remoteBridge.on('remote:status', ({ name, status }) => {
        L.info(`🌐 Remote "${name}" → ${status}`);
    });

    // ── 9. Health Dashboard ──
    const health = new HealthDashboard(gateway);
    health.registerRoutes(web.app);

    // Track stream client count for health report
    if (web.streamServer) {
        gateway._streamClientCount = () => web.streamServer.clientCount();
    }

    // ── Start everything ──
    cdp.start();
    monitor.start();
    gateway.startProcessing();
    autoAccept.start();
    cron.start();
    remoteBridge.start();
    await telegram.start();

    // Report config
    const instances = config.getInstances();
    if (instances.length > 0) {
        L.info(`Registered instances: ${instances.map(i => `${i.name}(:${i.port})`).join(', ')}`);
    }
    L.info(`Scanning CDP ports: ${cdpTargets.map(t => `${t.host}:${t.port}`).join(', ')}`);
    const remoteCount = (cfg.remotes || []).length;
    if (remoteCount > 0) {
        L.info(`Remote bridges: ${remoteCount} configured`);
    }

    // ── Graceful shutdown ──
    const shutdown = () => {
        console.log('\n🛑 Shutting down Opengravity...');
        telegram.stop();
        cron.stop();
        autoAccept.stop();
        remoteBridge.stop();
        gateway.stopProcessing();
        if (web.streamServer) web.streamServer.stop();
        monitor.stop();
        cdp.stop();
        web.server.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});
