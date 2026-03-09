/* AG Mission Control — Fleet Agent Dashboard v3.4 (Phase 4) */
(function () {
    // ── State ──────────────────────────────────────
    let cascades = [];
    let currentCascadeId = null;
    let ws = null;
    let phaseMap = {};          // cascadeId → phase string
    let phaseTimestamps = {};   // cascadeId → { phase, since, title }
    let approvalMap = {};      // cascadeId → { text, time }
    let approvalLog = JSON.parse(localStorage.getItem('ag-approval-log') || '[]');
    let perAgentAutoAccept = JSON.parse(localStorage.getItem('ag-per-agent-aa') || '{}');
    let agentNicknames = JSON.parse(localStorage.getItem('ag-nicknames') || '{}');
    let agentColors = JSON.parse(localStorage.getItem('ag-colors') || '{}');
    let pinnedAgents = JSON.parse(localStorage.getItem('ag-pinned') || '[]');
    let notificationsEnabled = false;
    let refreshTimer = null;
    let activePanel = 'fleet';
    let taskHistory = JSON.parse(localStorage.getItem('ag-task-history') || '[]');
    let autoAcceptEnabled = localStorage.getItem('ag-auto-accept') === 'true';
    let perAgentStats = JSON.parse(localStorage.getItem('ag-agent-stats') || '{}');
    let autoAcceptStats = { totalClicks: 0, lastClick: null, clicksPerInstance: {} };
    let isSending = false;
    let messagesSent = 0;
    let tasksCompleted = 0;
    let ctxTargetId = null;    // context menu target cascade ID
    let selectedColor = '#7c5cfc';
    let renameTargetId = null;
    let removeTargetId = null;
    let pendingAgents = JSON.parse(localStorage.getItem('ag-pending-agents') || '[]'); // { id, name, host, port, color }
    let editingAgent = null;   // host:port key when editing, null when adding
    let activityLog = JSON.parse(localStorage.getItem('ag-activity-log') || '[]'); // { cascadeId, type, text, time }
    let agentRoles = JSON.parse(localStorage.getItem('ag-roles') || '{}'); // cascadeId/pendingId → role key
    let agentTokens = JSON.parse(localStorage.getItem('ag-tokens') || '{}'); // cascadeId → { tokens, cost }
    const sessionStart = Date.now();

    // Role badge definitions (CrewAI-inspired specialization)
    const ROLES = {
        frontend:   { icon: '🎨', label: 'Frontend',  color: '#60a5fa' },
        backend:    { icon: '⚙️', label: 'Backend',   color: '#f59e0b' },
        fullstack:  { icon: '🔄', label: 'Full-Stack', color: '#a78bfa' },
        devops:     { icon: '🚀', label: 'DevOps',    color: '#34d399' },
        researcher: { icon: '🔬', label: 'Researcher', color: '#06b6d4' },
        designer:   { icon: '🎯', label: 'Designer',  color: '#fb923c' },
        qa:         { icon: '🧪', label: 'QA',        color: '#f87171' },
        pm:         { icon: '📋', label: 'PM',        color: '#fbbf24' },
        data:       { icon: '📊', label: 'Data',      color: '#2dd4bf' },
        security:   { icon: '🔒', label: 'Security',  color: '#ef4444' }
    };

    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    // ── Theme ──────────────────────────────────────
    function initTheme() {
        const saved = localStorage.getItem('ag-theme');
        const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        setTheme(theme);
    }
    function setTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('ag-theme', t);
        const btn = $('themeToggle');
        if (btn) btn.textContent = t === 'dark' ? '🌙' : '☀️';
    }
    function toggleTheme() {
        setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    }

    // ── Notifications ──────────────────────────────
    function requestNotifications() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(p => { notificationsEnabled = (p === 'granted'); });
        } else if ('Notification' in window) {
            notificationsEnabled = (Notification.permission === 'granted');
        }
    }
    function playSound() {
        try {
            const ctx = new AudioContext(), osc = ctx.createOscillator(), g = ctx.createGain();
            osc.connect(g); g.connect(ctx.destination);
            osc.frequency.value = 880; osc.type = 'sine';
            g.gain.setValueAtTime(0.3, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
            osc.start(); osc.stop(ctx.currentTime + 0.3);
        } catch { }
    }
    function getPhase(id) { return phaseMap[id || currentCascadeId] || 'idle'; }

    // ── WebSocket ──────────────────────────────────
    function connect() {
        ws = new WebSocket(`ws://${location.host}`);
        ws.onopen = () => {
            $('connectionBadge').classList.remove('disconnected');
            $('connectionBadge').querySelector('span').textContent = 'Connected';
        };
        ws.onclose = () => {
            $('connectionBadge').classList.add('disconnected');
            $('connectionBadge').querySelector('span').textContent = 'Reconnecting...';
            setTimeout(connect, 2000);
        };
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'cascade_list') {
                cascades = data.cascades;
                // Auto-map nicknames from pending agents by port
                cascades.forEach(c => {
                    if (!agentNicknames[c.id]) {
                        const match = pendingAgents.find(p => c.port && p.port && p.port.toString() === c.port.toString() && p.name);
                        if (match) {
                            agentNicknames[c.id] = match.name;
                            localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames));
                        }
                    }
                });
                renderFleet();
                if (!currentCascadeId && cascades.length > 0) selectAgent(cascades[0].id);
            }
            if (data.type === 'snapshot_update' && data.cascadeId === currentCascadeId) {
                updateChat(currentCascadeId);
            }
            if (data.type === 'phase_change') {
                updatePhase(data.phase, data.cascadeId, data.title);
            }
        };
    }

    // ── Fleet Rendering ───────────────────────────
    function renderFleet() {
        const list = $('fleetList');
        if (!list) return;

        // Merge live cascades + pending (offline) agents
        const liveIds = new Set(cascades.map(c => c.id));
        const offlineCards = pendingAgents
            .filter(p => !liveIds.has(p.id) && !cascades.some(c => (c.port || '').toString() === p.port.toString()))
            .map(p => ({ ...p, _offline: true }));
        const allAgents = [...cascades, ...offlineCards];

        if (allAgents.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:30px">
                <div class="icon">🔍</div>
                <h3>No agents found</h3>
                <p>Click <b>+ Add Agent</b> to register one,<br>or launch Antigravity with<br><code>--remote-debugging-port=9000</code></p>
            </div>`;
            updateFleetSummary();
            return;
        }

        // Sort: pinned first, then by name
        const sorted = [...allAgents].sort((a, b) => {
            const pa = pinnedAgents.includes(a.id) ? 0 : 1;
            const pb = pinnedAgents.includes(b.id) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return displayName(a).localeCompare(displayName(b));
        });

        list.innerHTML = sorted.map(c => {
            const active = c.id === currentCascadeId;
            const isOffline = c._offline;
            const name = displayName(c);
            const isPinned = pinnedAgents.includes(c.id);
            const color = isOffline ? (c.color || '') : (agentColors[c.id] || '');
            const status = getStatusLabel(c.id, isOffline);
            const stats = perAgentStats[c.id];
            const statsHtml = stats ? `<span class="fleet-stats">📤${stats.sent || 0} ✅${stats.completed || 0}</span>` : '';

            if (isOffline) {
                const folderDisplay = c.folder ? `<div class="fleet-preview" title="${escHtml(c.folder)}">📁 ${escHtml(shortPath(c.folder))}</div>` : '';
                return `<div class="fleet-card ${isPinned ? 'pinned' : ''} offline"
                    onclick="window.AG.showEditAgent('${c.host}',${c.port})">
                    ${color ? `<div class="fleet-card-color" style="background:${color}"></div>` : ''}
                    <div class="fleet-dot offline"></div>
                    <div class="fleet-info">
                        <div class="fleet-name">${escHtml(name)} ${getRoleBadge(isOffline ? `pending-${c.host}-${c.port}` : c.id)}</div>
                        <div class="fleet-status">${status.icon} ${status.text}</div>
                        <div class="fleet-preview">${c.host}:${c.port}</div>
                        ${folderDisplay}
                    </div>
                    <div class="fleet-actions">
                        <button class="fleet-run-btn" onclick="event.stopPropagation();window.AG.launchAgent('${c.host}',${c.port},'${escHtml((c.name || '').replace(/\\/g, '\\\\'))}','${escHtml((c.folder || '').replace(/\\/g, '\\\\'))}')" title="Launch Antigravity">▶</button>
                        <button class="fleet-remove-btn" onclick="event.stopPropagation();window.AG.removePending('${c.host}',${c.port})" title="Remove">✕</button>
                    </div>
                </div>`;
            }

            return `<div class="fleet-card ${active ? 'active' : ''} ${isPinned ? 'pinned' : ''} ${status.cls}"
                onclick="window.AG.selectAgent('${c.id}')"
                oncontextmenu="event.preventDefault();window.AG.showCtxMenu(event,'${c.id}')">
                ${color ? `<div class="fleet-card-color" style="background:${color}"></div>` : ''}
                <div class="fleet-dot ${status.cls}"></div>
                <div class="fleet-info">
                    <div class="fleet-name">${escHtml(name)} ${statsHtml} ${getRoleBadge(c.id)}</div>
                    <div class="fleet-status">${status.icon} ${status.text}</div>
                    <div class="fleet-preview">${c.window || 'Port ' + (c.port || '9000')}</div>
                </div>
            </div>`;
        }).join('');

        updateFleetSummary();
    }

    function displayName(c) {
        return agentNicknames[c.id] || shortTitle(c.title);
    }

    function getRoleBadge(agentId) {
        const role = agentRoles[agentId];
        if (!role || !ROLES[role]) return '';
        const r = ROLES[role];
        return `<span class="role-badge" style="--role-color:${r.color}">${r.icon} ${r.label}</span>`;
    }

    function updateFleetSummary() {
        // Count live cascades + unique pending agents
        const liveIds = new Set(cascades.map(c => c.id));
        const livePorts = new Set(cascades.map(c => (c.port || '').toString()));
        const uniquePending = pendingAgents.filter(p => !liveIds.has(p.id) && !livePorts.has(p.port.toString()));
        const total = cascades.length + uniquePending.length;
        const online = cascades.filter(c => getPhase(c.id) !== 'offline').length;
        const pending = Object.keys(approvalMap).length;
        const setVal = (id, val) => { const el = $(id); if (el) el.textContent = val; };
        setVal('fs-total', total);
        setVal('fs-online', online);
        setVal('fs-pending', pending);
    }

    function filterFleet(query) {
        const q = query.toLowerCase();
        document.querySelectorAll('.fleet-card').forEach(card => {
            const name = card.querySelector('.fleet-name')?.textContent?.toLowerCase() || '';
            const meta = card.querySelector('.fleet-preview')?.textContent?.toLowerCase() || '';
            card.style.display = (name.includes(q) || meta.includes(q)) ? '' : 'none';
        });
    }

    function shortTitle(title) {
        if (!title) return 'Untitled';
        // Extract workspace/project name from Antigravity title
        const parts = title.split(' - ');
        return parts[0].replace('[Antigravity]', '').trim() || parts[0] || title;
    }

    function shortPath(folderPath) {
        if (!folderPath) return '';
        // Show last 2 segments: .../parent/project
        const sep = folderPath.includes('\\') ? '\\' : '/';
        const parts = folderPath.split(sep).filter(Boolean);
        if (parts.length <= 2) return folderPath;
        return '📁 ' + parts.slice(-2).join(sep);
    }

    // ── Agent Selection ─────────────────────────────
    function selectAgent(id) {
        currentCascadeId = id;
        renderFleet();
        loadAgent(id);
        updateAgentSettings(id);
        // Close sidebar on mobile
        document.querySelector('.sidebar')?.classList.remove('open');
    }

    async function loadAgent(id) {
        const c = cascades.find(x => x.id === id);
        const name = c ? displayName(c) : 'AG Mission Control';
        $('topbarTitle').textContent = name;
        $('topbarSubtitle').textContent = c ? (c.window || `Port ${c.port || '9000'}`) : 'Select an agent';

        // Update phase badge
        const phase = getPhase(id);
        const badge = $('statusBadge');
        const text = $('statusText');
        if (badge) badge.className = `status-badge ${phase}`;
        const labels = { idle: '💤 Idle', streaming: '⚡ Streaming', complete: '✅ Complete', approval: '⚠️ Approval' };
        if (text) text.textContent = labels[phase] || phase;

        // Check for approval
        checkApproval(id);

        try {
            const sr = await fetch(`/styles/${id}`);
            if (sr.ok) {
                const sd = await sr.json();
                const el = $('cascadeStyle');
                if (el) el.textContent = sd.css;
            }
            await updateChat(id);
        } catch (e) { console.error(e); }
    }

    let scrollLocked = true; // auto-scroll ON by default
    let chatMessages = []; // { type:'sent'|'received', text, time }

    async function updateChat(id) {
        try {
            const res = await fetch(`/snapshot/${id}`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            const chatArea = $('chatArea');
            const chatContent = $('chatContent');
            if (!chatArea || !chatContent) return;

            // Build chat content: sent bubbles + mirrored IDE
            let bubblesHtml = '';
            const sentForAgent = chatMessages.filter(m => m.type === 'sent' && m.target === id);
            bubblesHtml = sentForAgent.map(m => {
                const time = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return `<div class="chat-sent-msg">
                    <div class="chat-sent-bubble">
                        ${escHtml(m.text)}
                        <div class="chat-sent-time">${time}</div>
                    </div>
                </div>`;
            }).join('');

            // In-chat approval card (inline in message stream)
            let approvalCardHtml = '';
            if (approvalMap[id]) {
                const ap = approvalMap[id];
                const ago = timeAgo(ap.time);
                approvalCardHtml = `<div class="chat-approval-card">
                    <div class="chat-approval-header">
                        <span class="chat-approval-icon">⚠️</span>
                        <div class="chat-approval-info">
                            <div class="chat-approval-title">Approval Required</div>
                            <div class="chat-approval-text">${escHtml(ap.text)}</div>
                            <div class="chat-approval-time">${ago}</div>
                        </div>
                    </div>
                    <div class="chat-approval-screenshot" id="chatApprovalScreenshot-${id}"></div>
                    <div class="chat-approval-actions">
                        <button class="chat-approval-btn accept" onclick="window.AG.acceptConfirmation()">✅ Accept</button>
                        <button class="chat-approval-btn accept-all" onclick="window.AG.acceptAllConfirmations()">✅ All</button>
                        <button class="chat-approval-btn deny" onclick="window.AG.denyConfirmation()">❌ Deny</button>
                        <button class="chat-approval-btn preview-btn" onclick="window.AG.loadApprovalScreenshot('${id}')">📸</button>
                    </div>
                </div>`;
            }

            chatContent.innerHTML = bubblesHtml + `<div class="chat-mirror">${data.html}</div>` + approvalCardHtml;

            // Update message count
            updateChatMsgCount(sentForAgent.length);

            // Auto-scroll if not locked
            if (scrollLocked) {
                requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
            }
        } catch { }
    }

    function updateChatMsgCount(sentCount) {
        const el = $('chatMsgCount');
        if (el) el.textContent = `${sentCount} sent`;
    }

    function toggleScrollLock() {
        scrollLocked = !scrollLocked;
        const btn = $('scrollLockBtn');
        if (btn) {
            btn.textContent = scrollLocked ? '🔒 Auto-scroll' : '🔓 Scroll free';
            btn.classList.toggle('active', scrollLocked);
        }
        if (scrollLocked) scrollToBottom();
    }

    function scrollToBottom() {
        const chatArea = $('chatArea');
        if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
    }

    function exportChat() {
        if (!currentCascadeId) { showToast('❌ No agent selected'); return; }
        const sentForAgent = chatMessages.filter(m => m.type === 'sent' && m.target === currentCascadeId);
        if (sentForAgent.length === 0) { showToast('ℹ️ No messages to export'); return; }
        const c = cascades.find(x => x.id === currentCascadeId);
        const name = c ? displayName(c) : 'Unknown';
        const lines = [`# Chat Export: ${name}`, `# ${new Date().toISOString()}`, ''];
        sentForAgent.forEach(m => {
            const time = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lines.push(`[${time}] You: ${m.text}`);
        });
        navigator.clipboard.writeText(lines.join('\n')).then(
            () => showToast('📋 Chat exported to clipboard'),
            () => showToast('❌ Clipboard not available')
        );
    }

    function clearChat() {
        if (!currentCascadeId) return;
        chatMessages = chatMessages.filter(m => m.target !== currentCascadeId);
        const chatContent = $('chatContent');
        if (chatContent) chatContent.innerHTML = '';
        updateChatMsgCount(0);
        showToast('🗑️ Chat cleared');
    }

    function updateCharCount() {
        const input = $('messageInput');
        const counter = $('charCount');
        if (input && counter) counter.textContent = input.value.length;
    }

    function updateTypingIndicator(phase) {
        const el = $('typingIndicator');
        if (!el) return;
        if (phase === 'streaming') {
            el.style.display = '';
            const txt = el.querySelector('.typing-text');
            if (txt) txt.textContent = 'Agent is working...';
        } else {
            el.style.display = 'none';
        }
    }

    // ── Phase ──────────────────────────────────────
    function updatePhase(phase, cascadeId, title) {
        if (cascadeId) {
            phaseMap[cascadeId] = phase;
            // Track timestamps for status-first display
            const prev = phaseTimestamps[cascadeId];
            if (!prev || prev.phase !== phase) {
                phaseTimestamps[cascadeId] = { phase, since: Date.now(), title: title || prev?.title };
            }
        }
        if (!cascadeId || cascadeId === currentCascadeId) {
            const badge = $('statusBadge');
            const text = $('statusText');
            if (badge) badge.className = `status-badge ${phase}`;
            const labels = { idle: '💤 Idle', streaming: '⚡ Streaming', complete: '✅ Complete', approval: '⚠️ Approval' };
            if (text) text.textContent = labels[phase] || phase;
            updateTypingIndicator(phase);
        }
        renderFleet();
        // Also inject/update in-chat approval card when phase changes
        if (cascadeId === currentCascadeId) {
            updateChat(currentCascadeId);
        }
        if (phase === 'complete') {
            tasksCompleted++;
            const name = title || shortTitle((cascades.find(c => c.id === cascadeId) || {}).title) || 'Antigravity';
            showToast(`✅ ${name} — Task complete`);
            logActivity(cascadeId, 'complete', `${name} finished task`);
            playSound();
            if (notificationsEnabled && document.hidden) {
                new Notification('AG Mission Control', { body: `✅ ${name} — Task complete`, tag: 'ag-' + cascadeId });
            }
            if (cascadeId) {
                if (!perAgentStats[cascadeId]) perAgentStats[cascadeId] = { sent: 0, completed: 0 };
                perAgentStats[cascadeId].completed++;
                saveAgentStats();
            }
            const historyTask = taskHistory.find(t => t.cascadeId === cascadeId && t.status === 'running');
            if (historyTask) {
                historyTask.status = 'complete';
                historyTask.completedAt = new Date().toISOString();
                saveHistory();
                renderHistory();
            }
            updateAgentSettings(currentCascadeId);
        }
        if (phase === 'streaming' && cascadeId === currentCascadeId) showToast('⚡ Agent started...');
        startAutoRefresh();
    }

    function timeAgo(ts) {
        const sec = Math.round((Date.now() - ts) / 1000);
        if (sec < 5) return 'just now';
        if (sec < 60) return `${sec}s ago`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
        return `${Math.floor(sec / 3600)}h ago`;
    }

    function getStatusLabel(cascadeId, isOffline) {
        if (isOffline) return { icon: '⏳', text: 'Waiting to connect...', cls: 'offline' };
        const hasApproval = approvalMap[cascadeId];
        if (hasApproval) return { icon: '⚠️', text: 'Needs approval', cls: 'approval' };
        const phase = getPhase(cascadeId);
        const ts = phaseTimestamps[cascadeId];
        const ago = ts ? timeAgo(ts.since) : '';
        switch (phase) {
            case 'streaming': return { icon: '⚡', text: `Working... (${ago})`, cls: 'streaming' };
            case 'complete': return { icon: '✅', text: `Done ${ago}`, cls: 'complete' };
            case 'stalled': return { icon: '🤔', text: `Thinking... (${ago})`, cls: 'stalled' };
            default: return { icon: '💤', text: 'Ready', cls: 'idle' };
        }
    }

    // ── Approval Detection ──────────────────────────
    // ── Approval Detection (Rich) ──────────────────
    async function checkApproval(cascadeId) {
        try {
            const res = await fetch(`/api/v1/instances/${cascadeId}/approval`);
            if (!res.ok) return;
            const data = await res.json();
            const banner = $('approvalBanner');
            if (data.hasApproval) {
                approvalMap[cascadeId] = {
                    text: data.message || 'Confirmation dialog detected',
                    time: approvalMap[cascadeId]?.time || Date.now()
                };
                if (cascadeId === currentCascadeId && banner) {
                    banner.style.display = '';
                    const txt = $('approvalText');
                    if (txt) txt.textContent = data.message || 'Confirmation dialog detected';
                    const timeEl = $('approvalTime');
                    if (timeEl) {
                        const ago = Math.round((Date.now() - approvalMap[cascadeId].time) / 1000);
                        timeEl.textContent = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
                    }
                }
            } else {
                delete approvalMap[cascadeId];
                if (banner && cascadeId === currentCascadeId) banner.style.display = 'none';
            }
            renderFleet();
        } catch { }
    }

    async function acceptConfirmation() {
        if (!currentCascadeId) return;
        const approvalText = approvalMap[currentCascadeId]?.text || 'unknown';
        showToast('✅ Accepting...');
        try {
            await fetch(`/api/v1/instances/${currentCascadeId}/approve`, { method: 'POST' });
            logApproval(currentCascadeId, 'accepted', approvalText);
            logActivity(currentCascadeId, 'accept', approvalText.substring(0, 80));
            delete approvalMap[currentCascadeId];
            const banner = $('approvalBanner');
            if (banner) banner.style.display = 'none';
            renderFleet();
            showToast('✅ Accepted');
        } catch { showToast('❌ Accept failed'); }
    }

    async function acceptAllConfirmations() {
        const pending = Object.keys(approvalMap);
        if (pending.length === 0) { showToast('ℹ️ No pending approvals'); return; }
        showToast(`✅ Accepting ${pending.length} approval(s)...`);
        let ok = 0;
        for (const cid of pending) {
            try {
                await fetch(`/api/v1/instances/${cid}/approve`, { method: 'POST' });
                logApproval(cid, 'accepted (bulk)', approvalMap[cid]?.text || 'unknown');
                delete approvalMap[cid];
                ok++;
            } catch { }
        }
        const banner = $('approvalBanner');
        if (banner) banner.style.display = 'none';
        renderFleet();
        showToast(`✅ Accepted ${ok}/${pending.length} approvals`);
    }

    async function denyConfirmation() {
        if (!currentCascadeId) return;
        const approvalText = approvalMap[currentCascadeId]?.text || 'unknown';
        showToast('❌ Denying...');
        try {
            await fetch(`/api/v1/instances/${currentCascadeId}/deny`, { method: 'POST' });
            logApproval(currentCascadeId, 'denied', approvalText);
            logActivity(currentCascadeId, 'deny', approvalText.substring(0, 80));
            delete approvalMap[currentCascadeId];
            const banner = $('approvalBanner');
            if (banner) banner.style.display = 'none';
            renderFleet();
            showToast('❌ Denied');
        } catch { showToast('❌ Deny failed'); }
    }

    function logApproval(cascadeId, action, text) {
        const name = shortTitle((cascades.find(c => c.id === cascadeId) || {}).title) || 'Unknown';
        approvalLog.unshift({
            cascadeId, action, text: text.substring(0, 100), name,
            time: new Date().toISOString()
        });
        if (approvalLog.length > 50) approvalLog = approvalLog.slice(0, 50);
        localStorage.setItem('ag-approval-log', JSON.stringify(approvalLog));
        renderApprovalLog();
    }

    function renderApprovalLog() {
        const el = $('as-approval-log');
        if (!el) return;
        const relevant = currentCascadeId
            ? approvalLog.filter(l => l.cascadeId === currentCascadeId).slice(0, 10)
            : approvalLog.slice(0, 10);
        if (relevant.length === 0) {
            el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">No approvals yet</span>';
            return;
        }
        el.innerHTML = relevant.map(l => {
            const icon = l.action.startsWith('accepted') ? '✅' : '❌';
            const t = new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<div class="approval-log-entry">
                <span class="approval-log-icon">${icon}</span>
                <span class="approval-log-text">${escHtml(l.text)}</span>
                <span class="approval-log-time">${t}</span>
            </div>`;
        }).join('');
    }

    async function toggleApprovalPreview() {
        const preview = $('approvalPreview');
        const img = $('approvalScreenshot');
        if (!preview || !currentCascadeId) return;
        if (preview.style.display !== 'none') {
            preview.style.display = 'none';
            return;
        }
        try {
            const res = await fetch(`/screenshot/${currentCascadeId}`);
            if (res.ok) {
                const blob = await res.blob();
                img.src = URL.createObjectURL(blob);
                preview.style.display = '';
            }
        } catch { showToast('❌ Screenshot failed'); }
    }

    // ── Send ───────────────────────────────────────
    async function sendMessage() {
        if (isSending) return;
        const input = $('messageInput');
        const btn = $('sendBtn');
        if (!input) { showToast('❌ Input not found'); return; }
        if (!currentCascadeId) { showToast('❌ No agent selected'); return; }
        const text = input.value.trim();
        if (!text) return;
        isSending = true;
        if (btn) btn.disabled = true;
        showToast('📤 Sending...');
        try {
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission().catch(() => { });
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            // Use Gateway API for unified routing
            const res = await fetch('/api/v1/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: text, target: currentCascadeId, source: 'dashboard' }),
                signal: controller.signal
            });
            clearTimeout(timeout);
            const data = await res.json();
            if (data.ok) {
                messagesSent++;
                const projectName = shortTitle((cascades.find(c => c.id === currentCascadeId) || {}).title) || 'Unknown';
                addToHistory(text, currentCascadeId, projectName);
                // Track sent message for chat view
                chatMessages.push({ type: 'sent', text, target: currentCascadeId, time: Date.now() });
                // Update per-agent stats
                if (!perAgentStats[currentCascadeId]) perAgentStats[currentCascadeId] = { sent: 0, completed: 0 };
                perAgentStats[currentCascadeId].sent++;
                saveAgentStats();
                updateAgentSettings(currentCascadeId);
                input.value = '';
                input.style.height = 'auto';
                updateCharCount();
                showToast('✅ Sent!');
                logActivity(currentCascadeId, 'send', text.substring(0, 80));
                // Track token cost (ClawWork-inspired economics)
                trackTokenCost(currentCascadeId, text);
            } else if (data.queued) {
                showToast(`📋 Queued (position ${data.position || '?'})`);
            } else {
                showToast(`❌ ${data.reason || 'Send failed'}`);
            }
        } catch (err) {
            const msg = err.name === 'AbortError' ? 'Request timed out (15s)' : (err.message || 'Connection error');
            showToast('❌ ' + msg);
        }
        if (btn) btn.disabled = false;
        isSending = false;
    }

    // ── Token Cost Tracking (ClawWork-inspired) ────
    function estimateTokens(text) {
        // Rule of thumb: ~4 chars per token for English
        return Math.ceil(text.length / 4);
    }

    function trackTokenCost(cascadeId, text) {
        const tokens = estimateTokens(text);
        // Assume ~$0.003 per 1K input tokens (Claude-like pricing)
        const costPer1K = 0.003;
        const cost = (tokens / 1000) * costPer1K;
        if (!agentTokens[cascadeId]) agentTokens[cascadeId] = { tokens: 0, cost: 0 };
        agentTokens[cascadeId].tokens += tokens;
        agentTokens[cascadeId].cost += cost;
        localStorage.setItem('ag-tokens', JSON.stringify(agentTokens));
        updateAgentSettings(currentCascadeId);
    }

    // ── Broadcast Prompt ─────────────────────────────
    async function broadcastPrompt() {
        const input = $('messageInput');
        if (!input) { showToast('❌ Input not found'); return; }
        const text = input.value.trim();
        if (!text) { showToast('❌ Type a prompt first'); return; }

        const onlineAgents = cascades.filter(c => getPhase(c.id) !== 'offline');
        if (onlineAgents.length === 0) { showToast('❌ No online agents'); return; }

        showToast(`📡 Broadcasting to ${onlineAgents.length} agent(s)...`);

        let sent = 0;
        let failed = 0;
        for (const c of onlineAgents) {
            try {
                const res = await fetch('/api/v1/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: text, target: c.id, source: 'dashboard-broadcast' })
                });
                const data = await res.json();
                if (data.ok || data.queued) {
                    sent++;
                    chatMessages.push({ type: 'sent', text: `[📡 Broadcast] ${text}`, target: c.id, time: Date.now() });
                    const projectName = shortTitle(c.title) || 'Unknown';
                    addToHistory(`[📡 Broadcast] ${text}`, c.id, projectName);
                    if (!perAgentStats[c.id]) perAgentStats[c.id] = { sent: 0, completed: 0 };
                    perAgentStats[c.id].sent++;
                    trackTokenCost(c.id, text);
                    logActivity(c.id, 'send', `[Broadcast] ${text.substring(0, 60)}`);
                } else {
                    failed++;
                }
            } catch {
                failed++;
            }
        }

        saveAgentStats();
        input.value = '';
        input.style.height = 'auto';
        updateCharCount();
        showToast(`📡 Broadcast: ${sent} sent, ${failed} failed`);
        renderFleet();
    }

    // ── Task History ──────────────────────────────
    function addToHistory(message, cascadeId, projectName) {
        taskHistory.unshift({
            id: Date.now(),
            message: message.substring(0, 500),
            cascadeId,
            project: projectName,
            status: 'running',
            sentAt: new Date().toISOString(),
            completedAt: null
        });
        if (taskHistory.length > 50) taskHistory = taskHistory.slice(0, 50);
        saveHistory();
        renderHistory();
    }

    function saveHistory() {
        localStorage.setItem('ag-task-history', JSON.stringify(taskHistory));
    }

    function saveAgentStats() {
        localStorage.setItem('ag-agent-stats', JSON.stringify(perAgentStats));
    }

    function renderHistory() {
        const list = $('historyList');
        if (!list) return;
        if (taskHistory.length === 0) {
            list.innerHTML = `<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">
                📋 Task history will appear here as you send prompts</p>`;
            return;
        }
        list.innerHTML = taskHistory.map(t => {
            const time = new Date(t.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const statusIcon = { running: '⚡', complete: '✅', error: '❌' }[t.status] || '❓';
            const duration = t.completedAt ? formatDuration(new Date(t.completedAt) - new Date(t.sentAt)) : '';
            return `<div class="ws-item" style="flex-direction:column;gap:4px;cursor:pointer" onclick="document.getElementById('messageInput').value='${t.message.replace(/'/g, "\\'").replace(/\n/g, ' ')}';AG.switchNav('fleet')">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span class="ws-name" style="font-size:12px">${statusIcon} ${escHtml(t.project)}</span>
                    <span class="ws-meta">${time} ${duration ? '• ' + duration : ''}</span>
                </div>
                <div class="ws-meta" style="font-size:11px;opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.message)}</div>
            </div>`;
        }).join('');
    }

    function formatDuration(ms) {
        if (ms < 1000) return '';
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        return `${m}m${s % 60}s`;
    }

    function escHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Agent Settings Panel ───────────────────────
    function toggleAgentSettings() {
        const panel = $('agentSettingsPanel');
        if (panel) panel.classList.toggle('open');
        if (panel?.classList.contains('open') && currentCascadeId) {
            updateAgentSettings(currentCascadeId);
            fetchAutoAcceptStats();
            renderApprovalLog();
            loadAgentCronJobs(currentCascadeId);
        }
    }

    function updateAgentSettings(cascadeId) {
        if (!cascadeId) return;
        const c = cascades.find(x => x.id === cascadeId);
        if (!c) return;

        const name = displayName(c);
        const stats = perAgentStats[cascadeId] || { sent: 0, completed: 0 };

        const setVal = (id, val) => { const el = $(id); if (el) el.textContent = val; };
        setVal('as-name', name);
        setVal('as-host', c.host || '127.0.0.1');
        setVal('as-port', c.port || '9000');
        setVal('as-phase', getPhase(cascadeId));
        setVal('as-sent', stats.sent);
        setVal('as-completed', stats.completed);

        // Session uptime
        const upMs = Date.now() - sessionStart;
        const upMin = Math.floor(upMs / 60000);
        const upHr = Math.floor(upMin / 60);
        setVal('as-uptime', upHr > 0 ? `${upHr}h ${upMin % 60}m` : `${upMin}m`);

        // Token cost (ClawWork-inspired economics)
        const tk = agentTokens[cascadeId] || { tokens: 0, cost: 0 };
        setVal('as-tokens', tk.tokens > 1000 ? `${(tk.tokens / 1000).toFixed(1)}K` : tk.tokens);
        setVal('as-cost', `$${tk.cost.toFixed(4)}`);

        // Per-agent auto-accept toggle state
        const aaToggle = $('as-autoaccept');
        if (aaToggle) aaToggle.classList.toggle('on', !!perAgentAutoAccept[cascadeId]);

        // Global auto-accept toggle state
        const gaaToggle = $('as-global-autoaccept');
        if (gaaToggle) gaaToggle.classList.toggle('on', autoAcceptEnabled);

        // Auto-accept stats
        const ciClicks = autoAcceptStats.clicksPerInstance?.[cascadeId] || 0;
        setVal('as-autoclicks', ciClicks);
        setVal('as-lastclick', autoAcceptStats.lastClick
            ? new Date(autoAcceptStats.lastClick).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '–');
    }

    // ── Per-Agent Auto-Accept ─────────────────────
    async function toggleAgentAutoAccept() {
        if (!currentCascadeId) return;
        const isOn = !perAgentAutoAccept[currentCascadeId];
        perAgentAutoAccept[currentCascadeId] = isOn;
        localStorage.setItem('ag-per-agent-aa', JSON.stringify(perAgentAutoAccept));
        const toggle = $('as-autoaccept');
        if (toggle) toggle.classList.toggle('on', isOn);
        showToast(isOn ? `🤖 Auto-accept ON for this agent` : `⏸️ Auto-accept OFF for this agent`);
        try {
            // Set server to 'instance' mode if any per-agent rules exist
            const anyEnabled = Object.values(perAgentAutoAccept).some(v => v);
            if (anyEnabled && !autoAcceptEnabled) {
                await fetch('/api/v1/auto-accept/mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'instance' })
                });
            }
            await fetch(`/api/v1/auto-accept/instance/${currentCascadeId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: isOn })
            });
        } catch { }
    }

    // ── Global Auto-Accept ──────────────────────────
    async function toggleAutoAccept() {
        autoAcceptEnabled = !autoAcceptEnabled;
        localStorage.setItem('ag-auto-accept', autoAcceptEnabled);
        const badge = $('autoAcceptBadge');
        if (badge) badge.textContent = autoAcceptEnabled ? '🟢 ON' : '🔴 OFF';
        const gaaToggle = $('as-global-autoaccept');
        if (gaaToggle) gaaToggle.classList.toggle('on', autoAcceptEnabled);
        showToast(autoAcceptEnabled ? '🤖 Global Auto-Accept ON' : '⏸️ Global Auto-Accept OFF');
        try {
            await fetch('/api/v1/auto-accept/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: autoAcceptEnabled ? 'all' : 'off' })
            });
        } catch { }
    }

    // ── Auto-Accept Stats Sync ────────────────────
    async function fetchAutoAcceptStats() {
        try {
            const res = await fetch('/api/v1/auto-accept');
            if (res.ok) {
                const data = await res.json();
                autoAcceptStats = {
                    totalClicks: data.totalClicks || 0,
                    lastClick: data.lastClick || null,
                    clicksPerInstance: data.clicksPerInstance || {}
                };
                if (currentCascadeId) updateAgentSettings(currentCascadeId);
            }
        } catch { }
    }

    // ── Agent Cron Jobs (filtered to current agent) ──
    async function loadAgentCronJobs(cascadeId) {
        const el = $('as-cron-list');
        if (!el) return;
        try {
            const res = await fetch('/api/v1/cron');
            const data = await res.json();
            const jobs = (data.jobs || []).filter(j => !j.instance || j.instance === cascadeId);
            if (jobs.length === 0) {
                el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">No cron jobs for this agent</span>';
                return;
            }
            el.innerHTML = jobs.map(j => `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:12px;font-weight:500">${j.enabled !== false ? '🟢' : '🔴'} ${escHtml(j.name)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${j.schedule}</div>
            </div>`).join('');
        } catch {
            el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Failed to load</span>';
        }
    }

    // ── Agent Screenshot Preview ──────────────────
    async function captureAgentPreview() {
        if (!currentCascadeId) return;
        showToast('📷 Capturing...');
        try {
            const res = await fetch(`/screenshot/${currentCascadeId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const preview = $('as-preview');
                if (preview) preview.innerHTML = `<img src="${url}" alt="Agent screenshot" />`;
                showToast('📷 Preview updated');
            }
        } catch { showToast('❌ Screenshot failed'); }
    }

    // ── Quick Prompt Helper ────────────────────────
    function quickPrompt(text) {
        const input = $('messageInput');
        if (input) input.value = text;
        const panel = $('agentSettingsPanel');
        if (panel) panel.classList.remove('open');
        input?.focus();
    }

    // ── Actions ────────────────────────────────────
    async function takeScreenshot() {
        if (!currentCascadeId) return;
        showToast('📸 Capturing...');
        try {
            const res = await fetch(`/screenshot/${currentCascadeId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const w = window.open('', '_blank', 'width=800,height=600');
                w.document.write(`<img src="${url}" style="max-width:100%;height:auto">`);
                showToast('📸 Screenshot ready');
            }
        } catch { showToast('❌ Screenshot failed'); }
    }

    async function stopAgent() {
        if (!currentCascadeId) return;
        try {
            await fetch(`/api/v1/stop/${currentCascadeId}`, { method: 'POST' });
            showToast('🛑 Stop signal sent');
        } catch { showToast('❌ Stop failed'); }
    }

    // ── Add/Edit Agent Modal ────────────────────────
    function showAddAgent() {
        editingAgent = null;
        const modal = $('addAgentModal');
        if (modal) modal.classList.add('open');
        // Reset to add mode
        const title = $('addAgentTitle');
        const subtitle = $('addAgentSubtitle');
        const submitBtn = $('addAgentSubmitBtn');
        if (title) title.textContent = 'Add Agent';
        if (subtitle) subtitle.textContent = 'Register a project \u2014 it will connect when Antigravity starts';
        if (submitBtn) submitBtn.textContent = 'Add Project';
        selectedColor = '#7c5cfc';
        $$('.color-dot').forEach(d => d.classList.toggle('selected', d.dataset.color === selectedColor));
        // Clear form
        if ($('agentName')) $('agentName').value = '';
        if ($('agentFolder')) $('agentFolder').value = '';
        if ($('agentHost')) $('agentHost').value = 'localhost';
        if ($('agentPort')) $('agentPort').value = '9001';
        if ($('agentRole')) $('agentRole').value = '';
    }

    function showEditAgent(host, port) {
        const agent = pendingAgents.find(p => p.host === host && p.port === port);
        if (!agent) return showAddAgent();
        editingAgent = `${host}:${port}`;
        const modal = $('addAgentModal');
        if (modal) modal.classList.add('open');
        // Edit mode labels
        const title = $('addAgentTitle');
        const subtitle = $('addAgentSubtitle');
        const submitBtn = $('addAgentSubmitBtn');
        if (title) title.textContent = '\u270f\ufe0f Edit Agent';
        if (subtitle) subtitle.textContent = `Editing ${agent.name || agent.host + ':' + agent.port}`;
        if (submitBtn) submitBtn.textContent = 'Save Changes';
        // Pre-fill form
        if ($('agentName')) $('agentName').value = agent.name || '';
        if ($('agentFolder')) $('agentFolder').value = agent.folder || '';
        if ($('agentHost')) $('agentHost').value = agent.host || 'localhost';
        if ($('agentPort')) $('agentPort').value = agent.port || '9001';
        if ($('agentRole')) $('agentRole').value = agentRoles[`pending-${host}-${port}`] || '';
        selectedColor = agent.color || '#7c5cfc';
        $$('.color-dot').forEach(d => d.classList.toggle('selected', d.dataset.color === selectedColor));
    }

    function closeAddAgent() {
        editingAgent = null;
        const modal = $('addAgentModal');
        if (modal) modal.classList.remove('open');
    }
    function pickColor(el) {
        selectedColor = el.dataset.color;
        $$('.color-dot').forEach(d => d.classList.toggle('selected', d === el));
    }
    async function addAgent() {
        const name = $('agentName')?.value?.trim() || '';
        const folder = $('agentFolder')?.value?.trim() || '';
        const host = $('agentHost')?.value?.trim() || 'localhost';
        const port = parseInt($('agentPort')?.value) || 9001;
        const color = selectedColor !== '#7c5cfc' ? selectedColor : '';
        const role = $('agentRole')?.value || '';

        // If editing, remove the old entry first
        if (editingAgent) {
            const [oldHost, oldPort] = editingAgent.split(':');
            pendingAgents = pendingAgents.filter(p => !(p.host === oldHost && p.port === parseInt(oldPort)));
            deleteProjectFromServer(oldHost, parseInt(oldPort));
            logActivity(null, 'edit', `Edited project ${name || host + ':' + port}`);
        }

        closeAddAgent();

        // Upsert pending agent
        const pendingId = `pending-${host}-${port}`;
        pendingAgents = pendingAgents.filter(p => !(p.host === host && p.port === port));
        pendingAgents.push({
            id: pendingId,
            title: name || `${host}:${port}`,
            name: name,
            folder: folder,
            host: host,
            port: port,
            color: color
        });
        localStorage.setItem('ag-pending-agents', JSON.stringify(pendingAgents));
        if (name) { agentNicknames[pendingId] = name; localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames)); }
        // Save role
        if (role) {
            agentRoles[pendingId] = role;
        } else {
            delete agentRoles[pendingId];
        }
        localStorage.setItem('ag-roles', JSON.stringify(agentRoles));
        saveProjectToServer({ name, host, port, folder, color });
        renderFleet();

        if (!editingAgent) {
            logActivity(null, 'add', `Added project ${name || host + ':' + port}`);
        }

        // Tell backend to scan + auto-launch
        try {
            const res = await fetch('/workspace/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, name, folder })
            });
            const data = await res.json();
            if (data.ok) {
                if (data.launched) {
                    showToast(`🚀 Launching ${name || 'Antigravity'} on port ${port}...`);
                } else if (folder) {
                    showToast(`✅ Project ${editingAgent ? 'updated' : 'added'} — launch Antigravity manually on port ${port}`);
                } else {
                    showToast(`✅ ${editingAgent ? 'Updated' : 'Added'} — scanning port ${port}`);
                }
                const saved = JSON.parse(localStorage.getItem('ag-extra-ports') || '[]');
                if (!saved.find(s => s.host === host && s.port === port)) {
                    saved.push({ host, port, name, folder });
                    localStorage.setItem('ag-extra-ports', JSON.stringify(saved));
                }
                if (color) {
                    const pendingColors = JSON.parse(localStorage.getItem('ag-pending-colors') || '{}');
                    pendingColors[`${host}:${port}`] = selectedColor;
                    localStorage.setItem('ag-pending-colors', JSON.stringify(pendingColors));
                }
                if (name) {
                    const pendingNames = JSON.parse(localStorage.getItem('ag-pending-names') || '{}');
                    pendingNames[`${host}:${port}`] = name;
                    localStorage.setItem('ag-pending-names', JSON.stringify(pendingNames));
                }
            }
        } catch (err) {
            showToast(`⚠️ Backend error — project saved locally, will connect when Antigravity starts`);
        }
        // Clear form
        if ($('agentName')) $('agentName').value = '';
        if ($('agentFolder')) $('agentFolder').value = '';
        if ($('agentPort')) $('agentPort').value = '9001';
    }

    // ── Approval Screenshot in Chat ─────────────────
    async function loadApprovalScreenshot(cascadeId) {
        const container = $(`chatApprovalScreenshot-${cascadeId}`);
        if (!container) return;
        if (container.innerHTML) { container.innerHTML = ''; return; } // toggle
        container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">📷 Loading...</span>';
        try {
            const res = await fetch(`/screenshot/${cascadeId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                container.innerHTML = `<img src="${url}" alt="Agent screenshot" style="width:100%;border-radius:8px;margin-top:8px" />`;
            } else {
                container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">❌ No screenshot available</span>';
            }
        } catch {
            container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">❌ Screenshot failed</span>';
        }
    }

    // ── Activity Log ────────────────────────────────
    function logActivity(cascadeId, type, text) {
        activityLog.unshift({
            cascadeId: cascadeId || 'system',
            type, // 'add', 'edit', 'remove', 'send', 'complete', 'approval', 'accept', 'deny', 'error'
            text,
            time: new Date().toISOString()
        });
        if (activityLog.length > 100) activityLog = activityLog.slice(0, 100);
        localStorage.setItem('ag-activity-log', JSON.stringify(activityLog));
    }

    function getActivityLog(cascadeId) {
        if (!cascadeId) return activityLog;
        return activityLog.filter(e => e.cascadeId === cascadeId || e.cascadeId === 'system');
    }

    // ── Activity Log UI ────────────────────────────────
    const activityIcons = {
        send: '📤', complete: '✅', accept: '👍', deny: '👎',
        add: '➕', edit: '✏️', remove: '🗑️', error: '❌',
        approval: '⏳', launch: '🚀'
    };
    const activityLabels = {
        send: 'Sent', complete: 'Completed', accept: 'Accepted', deny: 'Denied',
        add: 'Added', edit: 'Edited', remove: 'Removed', error: 'Error',
        approval: 'Approval', launch: 'Launched'
    };
    const activityColors = {
        send: '#7c5cfc', complete: '#22c55e', accept: '#22c55e', deny: '#ef4444',
        add: '#3b82f6', edit: '#f59e0b', remove: '#ef4444', error: '#ef4444',
        approval: '#f59e0b', launch: '#06b6d4'
    };

    function renderActivityLog() {
        const list = $('activityList');
        if (!list) return;

        // Update stats
        const totalEl = $('act-total');
        const sendEl = $('act-send');
        const completeEl = $('act-complete');
        const approveEl = $('act-approve');
        if (totalEl) totalEl.textContent = activityLog.length;
        if (sendEl) sendEl.textContent = activityLog.filter(e => e.type === 'send').length;
        if (completeEl) completeEl.textContent = activityLog.filter(e => e.type === 'complete').length;
        if (approveEl) approveEl.textContent = activityLog.filter(e => e.type === 'accept').length;

        // Get filter
        const filterEl = $('activityFilter');
        const filter = filterEl ? filterEl.value : 'all';
        let entries = filter === 'all' ? [...activityLog] : activityLog.filter(e => e.type === filter);

        if (entries.length === 0) {
            list.innerHTML = `<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">
                📊 ${filter === 'all' ? 'No activity yet' : `No "${activityLabels[filter] || filter}" events`}
            </p>`;
            return;
        }

        // Group by date
        const groups = {};
        entries.forEach(e => {
            const d = new Date(e.time);
            const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!groups[key]) groups[key] = [];
            groups[key].push(e);
        });

        let html = '';
        for (const [date, items] of Object.entries(groups)) {
            html += `<div class="activity-date-group">
                <div class="activity-date-label">${date}</div>`;
            for (const e of items) {
                const icon = activityIcons[e.type] || '📝';
                const label = activityLabels[e.type] || e.type;
                const color = activityColors[e.type] || '#888';
                const time = new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                const agentName = resolveAgentName(e.cascadeId);
                const textPreview = escHtml((e.text || '').substring(0, 60)) + ((e.text || '').length > 60 ? '…' : '');

                html += `<div class="activity-item" style="--accent:${color}">
                    <div class="activity-icon" style="background:${color}20;color:${color}">${icon}</div>
                    <div class="activity-body">
                        <div class="activity-header">
                            <span class="activity-label">${label}</span>
                            <span class="activity-time">${time}</span>
                        </div>
                        ${agentName !== 'System' ? `<div class="activity-agent">${escHtml(agentName)}</div>` : ''}
                        ${textPreview ? `<div class="activity-text">${textPreview}</div>` : ''}
                    </div>
                </div>`;
            }
            html += '</div>';
        }
        list.innerHTML = html;
    }

    function resolveAgentName(cascadeId) {
        if (!cascadeId || cascadeId === 'system') return 'System';
        // Try nickname first
        if (agentNicknames[cascadeId]) return agentNicknames[cascadeId];
        // Try cascade title
        const c = cascades.find(c => c.id === cascadeId);
        if (c) return shortTitle(c.title) || 'Agent';
        // Pending agent by port
        const p = pendingAgents.find(p => `${p.host}:${p.port}` === cascadeId);
        if (p) return p.name || `${p.host}:${p.port}`;
        return cascadeId.substring(0, 12) + '…';
    }

    function clearActivityLog() {
        activityLog = [];
        localStorage.removeItem('ag-activity-log');
        renderActivityLog();
        showToast('🗑️ Activity log cleared');
    }

    // ── Launch / Remove Pending Agents ────────────────
    async function launchAgent(host, port, name, folder) {
        showToast(`🚀 Launching ${name || 'Antigravity'} on port ${port}...`);
        try {
            const res = await fetch('/workspace/launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port: parseInt(port), name, folder })
            });
            const data = await res.json();
            if (data.ok) {
                showToast(`✅ ${data.message}`);
            } else {
                showToast(`❌ ${data.message}`);
            }
        } catch (err) {
            showToast(`❌ Launch failed: ${err.message}`);
        }
    }

    function removePending(host, port) {
        pendingAgents = pendingAgents.filter(p => !(p.host === host && p.port === port));
        localStorage.setItem('ag-pending-agents', JSON.stringify(pendingAgents));
        // Also remove from extra ports
        const saved = JSON.parse(localStorage.getItem('ag-extra-ports') || '[]');
        const filtered = saved.filter(s => !(s.host === host && s.port === port));
        localStorage.setItem('ag-extra-ports', JSON.stringify(filtered));
        deleteProjectFromServer(host, port);
        logActivity(null, 'remove', `Removed ${host}:${port}`);
        renderFleet();
        showToast(`🗑️ Removed ${host}:${port}`);
    }

    // ── Bulk Scan ──────────────────────────────────
    async function bulkScan() {
        const host = prompt('Host to scan:', 'localhost');
        if (!host) return;
        const startPort = parseInt(prompt('Start port:', '9000')) || 9000;
        const endPort = parseInt(prompt('End port:', '9003')) || 9003;
        const range = endPort - startPort + 1;
        showToast(`🔍 Scanning ${host}:${startPort}-${endPort} (${range} ports)...`);
        let found = 0;
        for (let p = startPort; p <= endPort; p++) {
            try {
                const res = await fetch('/workspace/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host, port: p })
                });
                const data = await res.json();
                if (data.ok && data.isNew) found++;
            } catch { }
        }
        showToast(found > 0 ? `✅ Found ${found} new agent(s)` : `ℹ️ No new agents found`);
    }

    // ── Context Menu ──────────────────────────────
    function showCtxMenu(e, cascadeId) {
        ctxTargetId = cascadeId;
        const menu = $('agentContextMenu');
        if (!menu) return;
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('open');
    }
    function hideCtxMenu() {
        const menu = $('agentContextMenu');
        if (menu) menu.classList.remove('open');
        ctxTargetId = null;
    }

    function ctxRename() {
        hideCtxMenu();
        if (!ctxTargetId) return;
        renameTargetId = ctxTargetId;
        const c = cascades.find(x => x.id === renameTargetId);
        const input = $('renameAgentInput');
        if (input) input.value = displayName(c || {});
        const modal = $('renameAgentModal');
        if (modal) modal.classList.add('open');
    }
    function closeRename() {
        const modal = $('renameAgentModal');
        if (modal) modal.classList.remove('open');
        renameTargetId = null;
    }
    function saveRename() {
        if (!renameTargetId) return;
        const name = $('renameAgentInput')?.value?.trim();
        if (name) {
            agentNicknames[renameTargetId] = name;
            localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames));
            renderFleet();
            if (renameTargetId === currentCascadeId) updateAgentSettings(currentCascadeId);
            showToast(`✏️ Renamed to "${name}"`);
        }
        closeRename();
    }

    function ctxPin() {
        hideCtxMenu();
        if (!ctxTargetId) return;
        const idx = pinnedAgents.indexOf(ctxTargetId);
        if (idx >= 0) {
            pinnedAgents.splice(idx, 1);
            showToast('📌 Unpinned');
        } else {
            pinnedAgents.push(ctxTargetId);
            showToast('📌 Pinned to top');
        }
        localStorage.setItem('ag-pinned', JSON.stringify(pinnedAgents));
        renderFleet();
    }

    async function ctxRescan() {
        hideCtxMenu();
        if (!ctxTargetId) return;
        const c = cascades.find(x => x.id === ctxTargetId);
        if (c) {
            showToast(`🔄 Re-scanning ${c.host || 'localhost'}:${c.port || '9000'}...`);
            try {
                await fetch('/workspace/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host: c.host || 'localhost', port: c.port || 9000 })
                });
                showToast('✅ Re-scan complete');
            } catch { showToast('❌ Re-scan failed'); }
        }
    }

    async function ctxScreenshot() {
        hideCtxMenu();
        if (!ctxTargetId) return;
        showToast('📸 Capturing...');
        try {
            const res = await fetch(`/screenshot/${ctxTargetId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank', 'width=800,height=600');
                showToast('📸 Screenshot ready');
            }
        } catch { showToast('❌ Screenshot failed'); }
    }

    function ctxRemove() {
        hideCtxMenu();
        if (!ctxTargetId) return;
        removeTargetId = ctxTargetId;
        const c = cascades.find(x => x.id === removeTargetId);
        const nameEl = $('removeAgentName');
        if (nameEl) nameEl.textContent = `Remove "${displayName(c || {})}"?`;
        const modal = $('removeAgentModal');
        if (modal) modal.classList.add('open');
    }
    function closeRemove() {
        const modal = $('removeAgentModal');
        if (modal) modal.classList.remove('open');
        removeTargetId = null;
    }
    function confirmRemove() {
        if (!removeTargetId) return;
        const c = cascades.find(x => x.id === removeTargetId);
        // Remove from saved ports
        let saved = JSON.parse(localStorage.getItem('ag-extra-ports') || '[]');
        if (c) {
            saved = saved.filter(s => !(s.host === (c.host || 'localhost') && s.port === (c.port || 9000)));
            localStorage.setItem('ag-extra-ports', JSON.stringify(saved));
        }
        // Clean up per-agent data
        delete agentNicknames[removeTargetId];
        delete agentColors[removeTargetId];
        delete perAgentAutoAccept[removeTargetId];
        delete perAgentStats[removeTargetId];
        const pidx = pinnedAgents.indexOf(removeTargetId);
        if (pidx >= 0) pinnedAgents.splice(pidx, 1);
        localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames));
        localStorage.setItem('ag-colors', JSON.stringify(agentColors));
        localStorage.setItem('ag-per-agent-aa', JSON.stringify(perAgentAutoAccept));
        localStorage.setItem('ag-agent-stats', JSON.stringify(perAgentStats));
        localStorage.setItem('ag-pinned', JSON.stringify(pinnedAgents));
        // Remove from cascades in memory
        cascades = cascades.filter(x => x.id !== removeTargetId);
        if (currentCascadeId === removeTargetId) {
            currentCascadeId = cascades.length > 0 ? cascades[0].id : null;
        }
        renderFleet();
        if (currentCascadeId) selectAgent(currentCascadeId);
        showToast('🗑️ Agent removed');
        closeRemove();
    }

    // Restore saved extra ports on load
    function restoreSavedPorts() {
        const saved = JSON.parse(localStorage.getItem('ag-extra-ports') || '[]');
        for (const s of saved) {
            fetch('/workspace/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: s.host, port: s.port })
            }).catch(() => { });
        }
    }

    // Apply pending nickname/color when cascades are discovered
    function applyPendingMeta() {
        const pendingColors = JSON.parse(localStorage.getItem('ag-pending-colors') || '{}');
        const pendingNames = JSON.parse(localStorage.getItem('ag-pending-names') || '{}');
        let changed = false;
        for (const c of cascades) {
            const key = `${c.host || 'localhost'}:${c.port || 9000}`;
            if (pendingColors[key] && !agentColors[c.id]) {
                agentColors[c.id] = pendingColors[key];
                delete pendingColors[key];
                changed = true;
            }
            if (pendingNames[key] && !agentNicknames[c.id]) {
                agentNicknames[c.id] = pendingNames[key];
                delete pendingNames[key];
                changed = true;
            }
        }
        if (changed) {
            localStorage.setItem('ag-pending-colors', JSON.stringify(pendingColors));
            localStorage.setItem('ag-pending-names', JSON.stringify(pendingNames));
            localStorage.setItem('ag-colors', JSON.stringify(agentColors));
            localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames));
            renderFleet();
        }
    }

    // ── Nav ────────────────────────────────────────
    function switchNav(panel) {
        activePanel = panel;
        $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.panel === panel));
        $$('.sidebar-section').forEach(s => {
            s.style.display = s.dataset.panel === panel ? 'block' : 'none';
        });
        // Load data for panels
        if (panel === 'health') refreshHealth();
        if (panel === 'cron') loadCron();
        if (panel === 'remotes') loadRemotes();
        if (panel === 'activity') renderActivityLog();
        // On mobile, open sidebar when clicking nav items
        if (window.innerWidth <= 768) {
            document.querySelector('.sidebar')?.classList.add('open');
        }
    }

    // ── Health Panel ──────────────────────────────
    let healthTimer = null;
    async function refreshHealth() {
        try {
            const res = await fetch('/api/v1/health');
            const d = await res.json();
            const hv = (id, val, cls) => {
                const el = $(id);
                if (el) { el.textContent = val; el.className = 'health-value' + (cls ? ' ' + cls : ''); }
            };
            hv('h-status', d.ok ? '✅ OK' : '❌ Down', d.ok ? 'ok' : 'bad');
            hv('h-instances', d.instances?.total ?? 0);
            hv('h-queue', `${d.queue?.pending ?? 0}/${d.queue?.running ?? 0}`);
            hv('h-uptime', d.uptimeHuman || '–');
            hv('h-autoaccept', d.autoAccept?.mode ?? 'off', d.autoAccept?.mode === 'all' ? 'ok' : '');
            hv('h-cron', `${d.cron?.activeJobs ?? 0}/${d.cron?.jobs ?? 0}`);
            hv('h-remotes', `${d.remotes?.connected ?? 0}/${d.remotes?.total ?? 0}`);
            hv('h-stream', d.streamClients ?? 0);

            // Instance list
            const list = $('healthInstances');
            if (list && d.instances?.list?.length > 0) {
                list.innerHTML = '<div class="health-label" style="margin-bottom:8px">AGENTS</div>' +
                    d.instances.list.map(i => `<div class="cron-card">
                        <div class="cron-name">${escHtml(i.title || 'Unknown')}</div>
                        <div class="cron-meta">${i.host}:${i.port} • ${i.phase || 'idle'}</div>
                    </div>`).join('');
            } else if (list) {
                list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:8px">No agents connected</div>';
            }
        } catch { }
        if (healthTimer) clearInterval(healthTimer);
        if (activePanel === 'health') {
            healthTimer = setInterval(refreshHealth, 10000);
        }
    }

    // ── Cron Panel ───────────────────────────────
    async function loadCron() {
        const panel = $('cronPanel');
        if (!panel) return;
        try {
            const res = await fetch('/api/v1/cron');
            const data = await res.json();
            const jobs = data.jobs || [];
            if (jobs.length === 0) {
                panel.innerHTML = '<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">⏰ No cron jobs configured</p>';
                return;
            }
            panel.innerHTML = jobs.map(j => `<div class="cron-card">
                <div class="cron-name">${j.enabled !== false ? '🟢' : '🔴'} ${escHtml(j.name)}</div>
                <div class="cron-meta">${j.schedule} • ${j.instance || 'any'}</div>
                <div class="cron-meta" style="margin-top:2px">${escHtml((j.prompt || '').substring(0, 80))}</div>
                <div class="cron-actions">
                    <button class="mini-btn" onclick="AG.triggerCron('${j.name}')">&#9654; Trigger</button>
                    <button class="mini-btn" onclick="AG.toggleCronJob('${j.name}', ${j.enabled === false})">${j.enabled !== false ? '⏸ Disable' : '▶ Enable'}</button>
                </div>
            </div>`).join('');
        } catch {
            panel.innerHTML = '<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">❌ Failed to load cron jobs</p>';
        }
    }

    async function triggerCron(name) {
        showToast(`⏰ Triggering "${name}"...`);
        try {
            const res = await fetch(`/api/v1/cron/${name}/trigger`, { method: 'POST' });
            const data = await res.json();
            showToast(data.ok ? `✅ "${name}" triggered` : `❌ ${data.reason}`);
            loadCron();
        } catch { showToast('❌ Trigger failed'); }
    }

    async function toggleCronJob(name, enable) {
        try {
            await fetch(`/api/v1/cron/${name}/enabled`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enable })
            });
            showToast(enable ? `▶ "${name}" enabled` : `⏸ "${name}" disabled`);
            loadCron();
        } catch { showToast('❌ Toggle failed'); }
    }

    // ── Remotes Panel ─────────────────────────────
    async function loadRemotes() {
        const panel = $('remotesPanel');
        if (!panel) return;
        try {
            const res = await fetch('/api/v1/remotes');
            const data = await res.json();
            const remotes = data.remotes || [];
            if (remotes.length === 0) {
                panel.innerHTML = '<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">🌐 No remote instances configured</p>';
                return;
            }
            panel.innerHTML = remotes.map(r => {
                const statusIcon = { connected: '🟢', disconnected: '🔴', error: '⚠️', unknown: '❓' }[r.status] || '❓';
                return `<div class="remote-card">
                    <div class="remote-name">${statusIcon} ${escHtml(r.name)}</div>
                    <div class="remote-meta">${r.type} • ${r.host || r.project || ''}</div>
                    ${r.lastCheck ? `<div class="remote-meta">🕒 ${new Date(r.lastCheck).toLocaleTimeString()}</div>` : ''}
                </div>`;
            }).join('');
        } catch {
            panel.innerHTML = '<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px">❌ Failed to load remotes</p>';
        }
    }

    // ── Toast ──────────────────────────────────────
    function showToast(msg) {
        const container = $('toastContainer');
        if (!container) return;
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        container.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ── Auto Refresh ───────────────────────────────
    function startAutoRefresh() {
        stopAutoRefresh();
        const p = getPhase(currentCascadeId);
        refreshTimer = setInterval(() => {
            if (currentCascadeId) {
                updateChat(currentCascadeId);
                // Periodically check for approvals
                checkApproval(currentCascadeId);
            }
        }, p === 'streaming' ? 2000 : 5000);
    }
    function stopAutoRefresh() { if (refreshTimer) clearInterval(refreshTimer); }

    // ── Mobile ─────────────────────────────────────
    function toggleSidebar() {
        document.querySelector('.sidebar')?.classList.toggle('open');
    }
    function closeSidebarMobile() {
        if (window.innerWidth <= 768) {
            document.querySelector('.sidebar')?.classList.remove('open');
        }
    }

    // ── Server-side project sync ──────────────────
    async function loadServerProjects() {
        try {
            const res = await fetch('/api/v1/projects');
            if (!res.ok) return;
            const { projects } = await res.json();
            if (!projects || projects.length === 0) {
                // If server has no projects but localStorage does, push local to server
                if (pendingAgents.length > 0) {
                    for (const p of pendingAgents) {
                        saveProjectToServer(p);
                    }
                }
                return;
            }
            // Merge server projects into pendingAgents (server is source of truth)
            const localByPort = new Map(pendingAgents.map(p => [`${p.host || 'localhost'}:${p.port}`, p]));
            for (const sp of projects) {
                const key = `${sp.host || 'localhost'}:${sp.port}`;
                if (!localByPort.has(key)) {
                    const pendingId = `pending-${sp.host || 'localhost'}-${sp.port}`;
                    pendingAgents.push({
                        id: pendingId,
                        title: sp.name || `${sp.host}:${sp.port}`,
                        name: sp.name || '',
                        folder: sp.folder || '',
                        host: sp.host || 'localhost',
                        port: sp.port,
                        color: sp.color || ''
                    });
                    if (sp.name) {
                        agentNicknames[pendingId] = sp.name;
                    }
                }
            }
            localStorage.setItem('ag-pending-agents', JSON.stringify(pendingAgents));
            localStorage.setItem('ag-nicknames', JSON.stringify(agentNicknames));
            renderFleet();
        } catch (e) {
            console.warn('Could not load server projects:', e);
        }
    }

    function saveProjectToServer(agent) {
        fetch('/api/v1/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: agent.name || '',
                host: agent.host || 'localhost',
                port: agent.port,
                folder: agent.folder || '',
                color: agent.color || ''
            })
        }).catch(e => console.warn('Failed to save project:', e));
    }

    function deleteProjectFromServer(host, port) {
        fetch(`/api/v1/projects/${port}?host=${encodeURIComponent(host || 'localhost')}`, {
            method: 'DELETE'
        }).catch(e => console.warn('Failed to delete project:', e));
    }

    // ── Init ───────────────────────────────────────
    function init() {
        initTheme();
        requestNotifications();
        loadServerProjects().then(() => {
            restoreSavedPorts();
            connect();
            startAutoRefresh();
        });
        renderHistory();
        // Update auto-accept badge
        const badge = $('autoAcceptBadge');
        if (badge) badge.textContent = autoAcceptEnabled ? '🟢 ON' : '🔴 OFF';

        // Event listeners
        const sendBtn = $('sendBtn');
        const msgInput = $('messageInput');
        if (sendBtn) {
            sendBtn.addEventListener('click', sendMessage);
        }
        if (msgInput) {
            msgInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
            });
            msgInput.addEventListener('input', function () {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
        }

        // Expose API
        window.AG = {
            selectAgent, sendMessage, toggleTheme, takeScreenshot, stopAgent,
            showAddAgent, closeAddAgent, addAgent, launchAgent, removePending,
            showEditAgent,
            toggleAgentSettings, switchNav, toggleSidebar,
            toggleAutoAccept, toggleAgentAutoAccept,
            refreshHealth, triggerCron, toggleCronJob,
            acceptConfirmation, denyConfirmation, acceptAllConfirmations,
            toggleApprovalPreview, captureAgentPreview, quickPrompt,
            loadApprovalScreenshot,
            renderActivityLog, clearActivityLog,
            broadcastPrompt,
            filterFleet, bulkScan, pickColor,
            showCtxMenu, ctxRename, ctxPin, ctxRescan, ctxScreenshot, ctxRemove,
            closeRename, saveRename, closeRemove, confirmRemove,
            toggleScrollLock, scrollToBottom, exportChat, clearChat, updateCharCount,
            clearHistory: () => { taskHistory = []; saveHistory(); renderHistory(); showToast('🗑️ History cleared'); }
        };

        // Close context menu on click outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu')) hideCtxMenu();
        });

        // Apply pending names/colors to new cascades
        applyPendingMeta();
    }

    document.addEventListener('DOMContentLoaded', init);

    // PWA Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    }
})();
