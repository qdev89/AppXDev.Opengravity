/* AG Mission Control — Fleet Agent Dashboard v3.4 (Phase 4) */
(function () {
    // ── State ──────────────────────────────────────
    let cascades = [];
    let currentCascadeId = null;
    let ws = null;
    let phaseMap = {};
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
    const sessionStart = Date.now();

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

        if (cascades.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:30px">
                <div class="icon">🔍</div>
                <h3>No agents found</h3>
                <p>Launch Antigravity with<br><code>--remote-debugging-port=9000</code></p>
            </div>`;
            updateFleetSummary();
            return;
        }

        // Sort: pinned first, then by name
        const sorted = [...cascades].sort((a, b) => {
            const pa = pinnedAgents.includes(a.id) ? 0 : 1;
            const pb = pinnedAgents.includes(b.id) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return displayName(a).localeCompare(displayName(b));
        });

        list.innerHTML = sorted.map(c => {
            const active = c.id === currentCascadeId;
            const phase = getPhase(c.id);
            const hasApproval = approvalMap[c.id];
            const displayPhase = hasApproval ? 'approval' : phase;
            const name = displayName(c);
            const isPinned = pinnedAgents.includes(c.id);
            const color = agentColors[c.id] || '';

            const phaseLabels = {
                idle: 'Ready',
                streaming: 'Working...',
                complete: 'Done',
                approval: '⚠️ Needs approval',
                stalled: 'Thinking...'
            };
            const phaseLabel = phaseLabels[displayPhase] || displayPhase;

            return `<div class="fleet-card ${active ? 'active' : ''} ${isPinned ? 'pinned' : ''}"
                onclick="window.AG.selectAgent('${c.id}')"
                oncontextmenu="event.preventDefault();window.AG.showCtxMenu(event,'${c.id}')">
                ${color ? `<div class="fleet-card-color" style="background:${color}"></div>` : ''}
                <div class="fleet-dot ${displayPhase}"></div>
                <div class="fleet-info">
                    <div class="fleet-name">${escHtml(name)}</div>
                    <div class="fleet-meta">
                        ${phaseLabel}
                        ${hasApproval ? '<span class="fleet-approval-badge">⚠ Approval</span>' : ''}
                    </div>
                    <div class="fleet-preview">${c.window || 'Port ' + (c.port || '9000')}</div>
                </div>
            </div>`;
        }).join('');

        updateFleetSummary();
    }

    function displayName(c) {
        return agentNicknames[c.id] || shortTitle(c.title);
    }

    function updateFleetSummary() {
        const total = cascades.length;
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

            chatContent.innerHTML = bubblesHtml + `<div class="chat-mirror">${data.html}</div>`;

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
        if (cascadeId) phaseMap[cascadeId] = phase;
        if (!cascadeId || cascadeId === currentCascadeId) {
            const badge = $('statusBadge');
            const text = $('statusText');
            if (badge) badge.className = `status-badge ${phase}`;
            const labels = { idle: '💤 Idle', streaming: '⚡ Streaming', complete: '✅ Complete', approval: '⚠️ Approval' };
            if (text) text.textContent = labels[phase] || phase;
            updateTypingIndicator(phase);
        }
        renderFleet();
        if (phase === 'complete') {
            tasksCompleted++;
            const name = title || shortTitle((cascades.find(c => c.id === cascadeId) || {}).title) || 'Antigravity';
            showToast(`✅ ${name} — Task complete`);
            playSound();
            if (notificationsEnabled && document.hidden) {
                new Notification('AG Mission Control', { body: `✅ ${name} — Task complete`, tag: 'ag-' + cascadeId });
            }
            // Update per-agent stats
            if (cascadeId) {
                if (!perAgentStats[cascadeId]) perAgentStats[cascadeId] = { sent: 0, completed: 0 };
                perAgentStats[cascadeId].completed++;
                saveAgentStats();
            }
            // Update task history — mark latest task for this cascade as complete
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

    // ── Add Agent Modal ────────────────────────────
    function showAddAgent() {
        const modal = $('addAgentModal');
        if (modal) modal.classList.add('open');
        selectedColor = '#7c5cfc';
        $$('.color-dot').forEach(d => d.classList.toggle('selected', d.dataset.color === selectedColor));
    }
    function closeAddAgent() {
        const modal = $('addAgentModal');
        if (modal) modal.classList.remove('open');
    }
    function pickColor(el) {
        selectedColor = el.dataset.color;
        $$('.color-dot').forEach(d => d.classList.toggle('selected', d === el));
    }
    async function addAgent() {
        const name = $('agentName')?.value?.trim() || '';
        const host = $('agentHost')?.value?.trim() || 'localhost';
        const port = parseInt($('agentPort')?.value) || 9001;
        closeAddAgent();
        showToast(`🔍 Scanning ${host}:${port}...`);
        try {
            const res = await fetch('/workspace/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, name })
            });
            const data = await res.json();
            if (data.ok) {
                showToast(data.isNew ? `✅ Added ${host}:${port}` : `ℹ️ Already scanning ${host}:${port}`);
                // Save to localStorage for persistence
                const saved = JSON.parse(localStorage.getItem('ag-extra-ports') || '[]');
                if (!saved.find(s => s.host === host && s.port === port)) {
                    saved.push({ host, port, name });
                    localStorage.setItem('ag-extra-ports', JSON.stringify(saved));
                }
                // Save color if assigned
                if (name || selectedColor !== '#7c5cfc') {
                    // We'll assign color when the cascade shows up
                    const pendingColors = JSON.parse(localStorage.getItem('ag-pending-colors') || '{}');
                    pendingColors[`${host}:${port}`] = selectedColor;
                    localStorage.setItem('ag-pending-colors', JSON.stringify(pendingColors));
                }
                // Save nickname if provided
                if (name) {
                    const pendingNames = JSON.parse(localStorage.getItem('ag-pending-names') || '{}');
                    pendingNames[`${host}:${port}`] = name;
                    localStorage.setItem('ag-pending-names', JSON.stringify(pendingNames));
                }
            } else {
                showToast(`❌ ${data.reason || 'Failed to add'}`);
            }
        } catch (err) {
            showToast('❌ ' + (err.message || 'Connection error'));
        }
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

    // ── Init ───────────────────────────────────────
    function init() {
        initTheme();
        requestNotifications();
        restoreSavedPorts();
        connect();
        startAutoRefresh();
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
            showAddAgent, closeAddAgent, addAgent,
            toggleAgentSettings, switchNav, toggleSidebar,
            toggleAutoAccept, toggleAgentAutoAccept,
            refreshHealth, triggerCron, toggleCronJob,
            acceptConfirmation, denyConfirmation, acceptAllConfirmations,
            toggleApprovalPreview, captureAgentPreview, quickPrompt,
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
