(function () {
  const API = '/api';
  let token = localStorage.getItem('lc_admin_token');
  let me = null;
  let socket = null;
  let agentsCache = [];
  let departmentsCache = [];
  let activeConversationId = null;
  let activeConversationStatus = null;
  let pendingAttachment = null; // { url, name, type } staged for the next chat message

  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const pageRoot = document.getElementById('page-root');

  // ---------------- Mobile sidebar toggle ----------------
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const navToggle = document.getElementById('mobile-nav-toggle');
  function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('open'); }
  navToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); backdrop.classList.toggle('open'); });
  backdrop.addEventListener('click', closeSidebar);
  document.getElementById('nav').addEventListener('click', (e) => { if (e.target.tagName === 'A') closeSidebar(); });

  // ---------------- PWA service worker + push notifications ----------------
  let swRegistration = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/admin/sw.js').then(reg => { swRegistration = reg; }).catch(() => {});
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  async function enableNotifications() {
    if (!('Notification' in window) || !swRegistration) {
      alert('Push notifications are not supported in this browser.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    try {
      const { publicKey } = await api('/push/vapid-public-key');
      if (!publicKey) return;
      const sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      document.getElementById('notif-btn').textContent = '🔔 Notifications on';
      document.getElementById('notif-btn').disabled = true;
    } catch (e) {
      console.error('Push subscribe failed', e);
    }
  }
  document.getElementById('notif-btn').addEventListener('click', enableNotifications);

  // ---------------- Notification sound ----------------
  const SOUND_PREF_KEY = 'lc_sound_enabled';
  const soundToggle = document.getElementById('sound-toggle');
  soundToggle.checked = localStorage.getItem(SOUND_PREF_KEY) !== 'off'; // default ON
  soundToggle.addEventListener('change', () => {
    localStorage.setItem(SOUND_PREF_KEY, soundToggle.checked ? 'on' : 'off');
  });

  function playNotificationSound() {
    if (localStorage.getItem(SOUND_PREF_KEY) === 'off') return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.36);
      // second, slightly higher tone right after for a pleasant two-note "ding"
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1175, ctx.currentTime + 0.12);
      gain2.gain.setValueAtTime(0.001, ctx.currentTime + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.14);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc2.start(ctx.currentTime + 0.12);
      osc2.stop(ctx.currentTime + 0.46);
    } catch (e) { /* Web Audio not available — silently skip */ }
  }

  // ---------------- PWA "Install App" prompt ----------------
  // Hides the browser address bar once installed (manifest.json already sets display:standalone) —
  // this just makes the install option visible/discoverable instead of relying on a hidden browser menu.
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferredInstallPrompt = null;

  if (!isStandalone) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      document.getElementById('install-banner-login').classList.remove('hidden');
      document.getElementById('install-btn-sidebar').classList.remove('hidden');
    });

    if (isIOS) {
      // iOS Safari never fires beforeinstallprompt — show manual "Add to Home Screen" steps instead.
      document.getElementById('ios-install-banner-login').classList.remove('hidden');
    }
  }

  async function triggerInstall() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('install-banner-login').classList.add('hidden');
    document.getElementById('install-btn-sidebar').classList.add('hidden');
  }
  document.getElementById('install-btn-login').addEventListener('click', triggerInstall);
  document.getElementById('install-btn-sidebar').addEventListener('click', triggerInstall);

  window.addEventListener('appinstalled', () => {
    document.getElementById('install-banner-login').classList.add('hidden');
    document.getElementById('install-btn-sidebar').classList.add('hidden');
  });

  // ---------------- API helper ----------------
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------------- Auth ----------------
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      token = data.token;
      me = data.agent;
      localStorage.setItem('lc_admin_token', token);
      boot();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);

  function logout() {
    token = null;
    localStorage.removeItem('lc_admin_token');
    if (socket) socket.disconnect();
    app.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }

  async function boot() {
    try {
      me = await api('/auth/me');
    } catch (e) { return logout(); }
    document.getElementById('me-name').textContent = `${me.name} · ${me.role.replace('_', ' ')}`;
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');

    // Agents only get chat-handling pages — admin-only sections (Agents, Departments,
    // Bot Flow, Widget Customizer, Settings) are for super_admin/manager only.
    const isAdminRole = ['super_admin', 'manager'].includes(me.role);
    if (!isAdminRole) {
      document.querySelectorAll('[data-admin-only]').forEach(el => el.remove());
    }

    connectSocket();
    await refreshLookups();
    window.addEventListener('hashchange', route);
    route();
    // Mark self online
    api(`/agents/${me.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'online' }) }).catch(() => {});
  }

  function connectSocket() {
    socket = io('/agent', { auth: { token } });
    socket.on('queue:new', () => { refreshConvListSilently(); flashNav('inbox'); flashNav('queue'); playNotificationSound(); });
    socket.on('queue:updated', () => { refreshConvListSilently(); });
    socket.on('agent:new_message', ({ conversationId, message }) => {
      if (conversationId === activeConversationId) appendMessageToPanel(message);
      if (['inbox', 'queue', 'assigned'].includes(currentPage)) refreshConvListSilently();
      if (message.sender_type === 'visitor') playNotificationSound();
    });
    socket.on('agent:status_changed', () => { agentsCache = null; if (currentPage === 'agents') renderAgents(); });
    socket.on('agent:visitor_typing', ({ conversationId }) => {
      if (conversationId === activeConversationId) {
        const el = document.getElementById('typing-indicator');
        if (el) { el.textContent = 'Visitor is typing…'; clearTimeout(window.__typTimeout); window.__typTimeout = setTimeout(() => (el.textContent = ''), 2000); }
      }
    });
  }

  function flashNav(page) {
    const a = document.querySelector(`nav a[data-page="${page}"]`);
    if (a) { a.style.color = '#4ade80'; setTimeout(() => (a.style.color = ''), 1200); }
  }

  async function refreshLookups() {
    agentsCache = await api('/agents');
    departmentsCache = await api('/departments');
  }

  // ---------------- Router ----------------
  let currentPage = 'dashboard';
  const ADMIN_PAGES = new Set(['agents', 'departments', 'bot-flow', 'customizer', 'settings']);
  const pages = {
    dashboard: renderDashboard,
    inbox: () => renderConversationsPage('active', 'Inbox'),
    queue: () => renderConversationsPage('waiting'),
    assigned: () => renderConversationsPage('assigned'),
    closed: () => renderConversationsPage('closed'),
    visitors: renderVisitors,
    agents: renderAgents,
    departments: renderDepartments,
    'bot-flow': renderBotFlow,
    customizer: renderWidgetCustomizer,
    settings: renderSettings,
    account: renderAccount,
  };

  function route() {
    const hash = (location.hash || '#dashboard').slice(1);
    let target = pages[hash] ? hash : 'dashboard';
    const isAdminRole = ['super_admin', 'manager'].includes(me.role);
    if (ADMIN_PAGES.has(target) && !isAdminRole) target = 'dashboard'; // server also enforces this; this just avoids a confusing blank/403 page
    currentPage = target;
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === currentPage));
    activeConversationId = null;
    pages[currentPage]();
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function timeAgo(iso) {
    const d = new Date(iso + 'Z');
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---------------- Dashboard ----------------
  async function renderDashboard() {
    pageRoot.innerHTML = `<h1 class="page-title">Dashboard</h1><p class="page-sub">Live overview of your support operation.</p><div class="cards" id="summary-cards">Loading…</div>`;
    const s = await api('/dashboard/summary');
    document.getElementById('summary-cards').innerHTML = `
      <div class="card"><div class="num">${s.waiting}</div><div class="label">Waiting in queue</div></div>
      <div class="card"><div class="num">${s.assigned}</div><div class="label">Active assigned chats</div></div>
      <div class="card"><div class="num">${s.closedToday}</div><div class="label">Closed today</div></div>
      <div class="card"><div class="num">${s.onlineAgents} / ${s.totalAgents}</div><div class="label">Agents online</div></div>
      <div class="card"><div class="num">${s.totalVisitorsToday}</div><div class="label">New visitors today</div></div>
    `;
  }

  // ---------------- Conversations (queue / assigned / closed) ----------------
  async function renderConversationsPage(status, customTitle) {
    const titles = { active: 'Inbox', waiting: 'Waiting Queue', assigned: 'Assigned Chats', closed: 'Closed Chats' };
    const subs = {
      active: 'Every open conversation — bot, waiting, and assigned. Reply directly, then assign to an agent whenever you like.',
      waiting: 'Conversations that finished the bot flow and need an agent.',
      assigned: 'Conversations currently being handled by an agent.',
      closed: 'Resolved conversations.',
    };
    pageRoot.innerHTML = `
      <h1 class="page-title">${customTitle || titles[status]}</h1>
      <p class="page-sub">${subs[status]}</p>
      <div class="two-col">
        <div class="conv-list" id="conv-list">Loading…</div>
        <div id="chat-panel-wrap"></div>
      </div>
    `;
    await loadConvList(status);
    document.getElementById('chat-panel-wrap').innerHTML = `<div class="chat-panel"><div class="empty-state">Select a conversation to view the chat</div></div>`;
  }

  async function loadConvList(status) {
    const list = await api('/conversations?status=' + status);
    const listEl = document.getElementById('conv-list');
    if (!list.length) { listEl.innerHTML = `<div class="empty-state" style="padding:30px 10px;">Nothing here right now.</div>`; return; }
    listEl.innerHTML = list.map(c => `
      <div class="conv-item ${c.id === activeConversationId ? 'active' : ''}" data-id="${c.id}">
        <div class="name">${escapeHtml(c.visitor_name || 'Visitor')}</div>
        <div class="preview">${escapeHtml(c.category || 'General inquiry')}${c.department_name ? ' · ' + escapeHtml(c.department_name) : ''}</div>
        <div class="meta">
          <span class="badge ${c.status}">${c.status}</span>
          <span style="font-size:11px;color:#94a3b8;">${timeAgo(c.updated_at)}</span>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.conv-item').forEach(el => {
      el.addEventListener('click', () => openConversation(el.dataset.id, status));
    });
  }

  async function refreshConvListSilently() {
    const statusMap = { inbox: 'active', queue: 'waiting', assigned: 'assigned', closed: 'closed' };
    const status = statusMap[currentPage];
    if (status && document.getElementById('conv-list')) await loadConvList(status);
  }

  async function openConversation(id, status) {
    activeConversationId = id;
    activeConversationStatus = status;
    document.querySelectorAll('.conv-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    if (socket) socket.emit('agent:join_conversation', { conversationId: id });

    const conv = await api('/conversations/' + id);
    const agentOptions = agentsCache.map(a => `<option value="${a.id}" ${a.id === conv.agent_id ? 'selected' : ''}>${escapeHtml(a.name)} (${a.status})</option>`).join('');

    document.getElementById('chat-panel-wrap').innerHTML = `
      <div class="chat-panel">
        <div class="chat-panel-header">
          <div>
            <div class="title">${escapeHtml(conv.visitor_name || 'Visitor')}</div>
            <div class="sub">${escapeHtml(conv.visitor_contact || 'No contact provided')} · ${escapeHtml(conv.category || '')}</div>
            ${conv.short_code ? `
              <div style="margin-top:4px; display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; color:var(--ink-soft);">Telegram code:</span>
                <code style="font-size:11px; background:#f1f5f9; padding:2px 6px; border-radius:4px;">#${escapeHtml(conv.short_code)}</code>
                <button class="btn copy-shortcode-btn" data-code="${escapeHtml(conv.short_code)}" style="padding:2px 8px; font-size:10.5px;" title="Copy code to reply from Telegram">📋 Copy</button>
              </div>` : ''}
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${status !== 'closed' ? `<select id="assign-select" class="btn"><option value="">Assign to…</option>${agentOptions}</select>` : ''}
            ${status !== 'closed' ? `<button class="btn" id="close-conv-btn">Close chat</button>` : ''}
          </div>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div id="typing-indicator" style="font-size:11px;color:#94a3b8;padding:0 16px;min-height:14px;"></div>
        ${status !== 'closed' ? `
        <label class="note-toggle"><input type="checkbox" id="note-toggle"> Send as internal note (not visible to visitor)</label>
        <div id="pending-attachment-preview"></div>
        <div class="chat-input-bar">
          <button class="attach-btn" id="attach-btn" title="Attach a file">📎</button>
          <input type="file" id="attach-file-input" style="display:none;" />
          <input id="chat-input" placeholder="Type a reply…" autocomplete="off" />
          <button id="chat-send-btn">Send</button>
        </div>` : ''}
      </div>
    `;

    (conv.messages || []).forEach(appendMessageToPanel);

    const copyCodeBtn = document.getElementById('chat-panel-wrap').querySelector('.copy-shortcode-btn');
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText('#' + copyCodeBtn.dataset.code);
        const original = copyCodeBtn.textContent;
        copyCodeBtn.textContent = '✓ Copied';
        setTimeout(() => (copyCodeBtn.textContent = original), 1500);
      });
    }

    if (status !== 'closed') {
      document.getElementById('assign-select').addEventListener('change', async (e) => {
        const agentId = e.target.value;
        if (!agentId) return;
        await api(`/conversations/${id}/assign`, { method: 'POST', body: JSON.stringify({ agentId }) });
        refreshConvListSilently();
      });
      document.getElementById('close-conv-btn').addEventListener('click', async () => {
        await api(`/conversations/${id}/close`, { method: 'POST' });
        route();
      });
      const input = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send-btn');
      const noteToggle = document.getElementById('note-toggle');
      const attachBtn = document.getElementById('attach-btn');
      const fileInput = document.getElementById('attach-file-input');
      const previewEl = document.getElementById('pending-attachment-preview');
      pendingAttachment = null;

      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        previewEl.innerHTML = `<div style="font-size:11.5px;color:#64748b;padding:0 12px 6px;">Uploading ${escapeHtml(file.name)}…</div>`;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const res = await fetch(API + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          pendingAttachment = data;
          previewEl.innerHTML = `<div style="font-size:11.5px;color:#16a34a;padding:0 12px 6px;">📎 ${escapeHtml(data.name)} ready to send <button id="clear-attach" style="border:none;background:none;color:#ef4444;cursor:pointer;">✕</button></div>`;
          document.getElementById('clear-attach').addEventListener('click', () => { pendingAttachment = null; previewEl.innerHTML = ''; fileInput.value = ''; });
        } catch (err) {
          previewEl.innerHTML = `<div style="font-size:11.5px;color:#ef4444;padding:0 12px 6px;">${escapeHtml(err.message)}</div>`;
        }
      });

      function send() {
        const text = input.value.trim();
        if (!text && !pendingAttachment) return;
        socket.emit('agent:message', { conversationId: id, text, isInternalNote: noteToggle.checked, attachment: pendingAttachment });
        input.value = '';
        pendingAttachment = null;
        previewEl.innerHTML = '';
        fileInput.value = '';
      }
      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); else socket.emit('agent:typing', { conversationId: id }); });
    }
  }

  function attachmentHtml(msg) {
    if (!msg.attachment_url) return '';
    const isImage = (msg.attachment_type || '').startsWith('image/');
    if (isImage) {
      return `<img class="msg-attachment-img" src="${msg.attachment_url}" alt="${escapeHtml(msg.attachment_name || 'attachment')}" onclick="window.open('${msg.attachment_url}', '_blank')" />`;
    }
    return `<a class="msg-attachment-file" href="${msg.attachment_url}" target="_blank" rel="noopener">📎 ${escapeHtml(msg.attachment_name || 'Download attachment')}</a>`;
  }

  function appendMessageToPanel(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const row = document.createElement('div');
    let cls = 'in';
    if (msg.sender_type === 'agent' && msg.is_internal_note) cls = 'note';
    else if (msg.sender_type === 'agent') cls = 'out';
    else if (msg.sender_type === 'system') cls = 'sys';
    row.className = 'msg-row ' + cls;
    const textHtml = msg.text ? `<div>${escapeHtml(msg.text)}</div>` : '';
    row.innerHTML = `<div class="msg-bubble">${textHtml}${attachmentHtml(msg)}</div>`;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  // ---------------- Visitors ----------------
  async function renderVisitors() {
    pageRoot.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <div>
          <h1 class="page-title">Visitors</h1>
          <p class="page-sub">Everyone who has opened the chat widget.</p>
        </div>
        <a class="btn primary" href="#" id="export-csv-link">⬇️ Export CSV</a>
      </div>
      <div id="visitors-table">Loading…</div>`;
    // Auth header can't be set on a plain link click, so fetch with header then trigger download via blob
    document.getElementById('export-csv-link').addEventListener('click', async (e) => {
      e.preventDefault();
      const res = await fetch(API + '/visitors/export.csv', { headers: { Authorization: 'Bearer ' + token } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visitors-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
    const visitors = await api('/visitors');
    document.getElementById('visitors-table').innerHTML = visitors.length ? `
      <table><thead><tr><th>Name</th><th>Mobile</th><th>Email</th><th>Interested In</th><th>Consent</th><th>Page</th><th>First seen</th></tr></thead>
      <tbody>${visitors.map(v => {
        const services = v.interested_services ? JSON.parse(v.interested_services) : [];
        return `<tr>
          <td>${escapeHtml(v.name || '—')}</td>
          <td>${escapeHtml(v.mobile || v.contact || '—')}</td>
          <td>${escapeHtml(v.email || '—')}</td>
          <td>${services.length ? escapeHtml(services.join(', ')) : '—'}</td>
          <td>${v.consent_given ? '✅' : (v.lead_captured_at ? '❌' : '—')}</td>
          <td>${escapeHtml(v.page_url || '—')}</td>
          <td>${timeAgo(v.first_seen)}</td>
        </tr>`;
      }).join('')}</tbody></table>
    ` : `<div class="empty-state">No visitors yet.</div>`;
  }

  // ---------------- Agents ----------------
  async function renderAgents() {
    agentsCache = await api('/agents');
    pageRoot.innerHTML = `
      <h1 class="page-title">Agents</h1><p class="page-sub">Manage your support team, roles, and availability.</p>
      <table style="margin-bottom:24px;"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Active chats</th></tr></thead>
      <tbody>${agentsCache.map(a => `
        <tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.email)}</td><td>${a.role.replace('_',' ')}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td><td>${a.active_chats} / ${a.max_chats}</td></tr>
      `).join('')}</tbody></table>
      <h1 class="page-title" style="font-size:16px;">Add agent</h1>
      <form id="add-agent-form" class="form-grid">
        <label>Name</label><input name="name" required />
        <label>Email</label><input name="email" type="email" required />
        <label>Password</label><input name="password" type="password" required />
        <label>Role</label>
        <select name="role">
          <option value="agent">Agent</option>
          <option value="department_admin">Department Admin</option>
          <option value="manager">Manager</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <label>Department</label>
        <select name="department_id"><option value="">None</option>${departmentsCache.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select>
        <button class="btn primary" type="submit">Add agent</button>
        <div id="add-agent-error" style="color:#ef4444;font-size:12.5px;"></div>
      </form>
    `;
    document.getElementById('add-agent-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/agents', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
        renderAgents();
      } catch (err) {
        document.getElementById('add-agent-error').textContent = err.message;
      }
    });
  }

  // ---------------- Departments ----------------
  async function renderDepartments() {
    departmentsCache = await api('/departments');
    pageRoot.innerHTML = `
      <h1 class="page-title">Departments</h1><p class="page-sub">Used for skill-based routing from the AI bot.</p>
      <table style="margin-bottom:24px;"><thead><tr><th>Name</th></tr></thead>
      <tbody>${departmentsCache.map(d => `<tr><td>${escapeHtml(d.name)}</td></tr>`).join('')}</tbody></table>
      <form id="add-dept-form" class="form-grid" style="max-width:320px;">
        <label>New department name</label><input name="name" required />
        <button class="btn primary" type="submit">Add department</button>
      </form>
    `;
    document.getElementById('add-dept-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/departments', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      renderDepartments();
    });
  }

  // ---------------- Settings ----------------
  async function renderSettings() {
    const company = await api('/company');
    const tg = await api('/telegram/status');
    const emailCfg = await api('/email/config');
    const sheetsCfg = await api('/sheets/config');
    pageRoot.innerHTML = `
      <h1 class="page-title">Settings</h1><p class="page-sub">Company name and optional integrations. For widget look, colors, icon, and button position, see Widget Customizer.</p>
      <form id="settings-form" class="form-grid">
        <label>Company name</label><input name="name" value="${escapeHtml(company.name)}" />
        <button class="btn primary" type="submit">Save settings</button>
        <div id="settings-saved" style="color:#16a34a;font-size:12.5px;"></div>
      </form>

      <h1 class="page-title" style="font-size:16px; margin-top:32px;">🔵 Telegram Integration <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(optional)</span></h1>
      <p class="page-sub">Let agents reply to chats directly from Telegram once you assign a conversation to them — replies show up in this dashboard exactly like an in-app reply.</p>
      <div id="telegram-settings-box">
        ${tg.configured ? `
          <div class="card" style="max-width:480px; margin-bottom:16px;">
            <div class="label">Connected bot</div>
            <div class="num" style="font-size:16px;">@${escapeHtml(tg.botUsername)}</div>
            <div class="label" style="margin-top:8px;">${tg.linkedAgentsCount} agent(s) linked</div>
          </div>
          <div style="max-width:480px; margin-bottom:16px; padding:12px 14px; border-radius:8px; background:${tg.webhookOk ? '#f0fdf4' : '#fef2f2'}; border:1px solid ${tg.webhookOk ? '#bbf7d0' : '#fecaca'};">
            <div style="font-size:12.5px; font-weight:700; color:${tg.webhookOk ? '#15803d' : '#b91c1c'};">
              ${tg.webhookOk ? '✅ Webhook is correctly registered — Telegram replies will work' : '⚠️ Webhook is NOT registered correctly'}
            </div>
            ${!tg.webhookOk ? `<div style="font-size:11.5px; color:#7f1d1d; margin-top:4px;">${escapeHtml(tg.webhookError || 'Unknown issue')}</div>
              <button class="btn" id="telegram-retry-webhook-btn" style="margin-top:8px;">🔄 Retry webhook registration</button>` : ''}
          </div>
          <button class="btn" id="telegram-disconnect-btn">Disconnect Telegram</button>
        ` : `
          <form id="telegram-config-form" class="form-grid" style="max-width:480px;">
            <label>Bot token (from @BotFather on Telegram)</label>
            <input name="botToken" placeholder="123456789:AAExampleTokenFromBotFather" required />
            <button class="btn primary" type="submit">Connect Telegram bot</button>
            <div id="telegram-config-error" style="color:#ef4444; font-size:12.5px;"></div>
          </form>
          <p class="page-sub" style="margin-top:10px; max-width:480px;">
            Don't have a bot yet? Open Telegram, message <strong>@BotFather</strong>, send <code>/newbot</code>,
            follow the prompts, and paste the token it gives you above. Your server must be reachable over
            HTTPS for Telegram to deliver messages (see the deployment guide).
          </p>
        `}
      </div>

      <h1 class="page-title" style="font-size:16px; margin-top:32px;">📧 Email Notifications <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(optional, via SMTP)</span></h1>
      <p class="page-sub">Get emailed when a new lead comes in, and let agents get emailed when a chat is assigned to them.</p>
      <div id="email-settings-box">
        <form id="email-config-form" class="form-grid" style="max-width:480px;">
          <label>SMTP host</label><input name="smtp_host" placeholder="smtp.gmail.com" value="${escapeHtml(emailCfg.smtp_host || '')}" required />
          <label>SMTP port</label><input name="smtp_port" type="number" placeholder="587" value="${emailCfg.smtp_port || 587}" required />
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" name="smtp_secure" style="width:auto;" ${emailCfg.smtp_secure ? 'checked' : ''} /> Use SSL (usually only for port 465)</label>
          <label>SMTP username</label><input name="smtp_user" value="${escapeHtml(emailCfg.smtp_user || '')}" required />
          <label>SMTP password ${emailCfg.configured ? '<span style="font-weight:400;color:var(--ink-soft);">(leave blank to keep current)</span>' : ''}</label><input name="smtp_pass" type="password" ${emailCfg.configured ? '' : 'required'} />
          <label>"From" email</label><input name="from_email" type="email" value="${escapeHtml(emailCfg.from_email || '')}" required />
          <label>"From" name</label><input name="from_name" value="${escapeHtml(emailCfg.from_name || 'Live Chat CRM')}" />
          <label>Send new-lead alerts to</label><input name="admin_notify_email" type="email" placeholder="admin@yourcompany.com" value="${escapeHtml(emailCfg.admin_notify_email || '')}" />
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" name="notify_on_new_lead" style="width:auto;" ${emailCfg.notify_on_new_lead !== false ? 'checked' : ''} /> Email me on every new lead</label>
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" name="notify_agent_on_assign" style="width:auto;" ${emailCfg.notify_agent_on_assign !== false ? 'checked' : ''} /> Email agents when a chat is assigned to them</label>
          <div style="display:flex; gap:8px;">
            <button class="btn primary" type="submit">Save</button>
            <button class="btn" type="button" id="email-test-btn">Send test email</button>
          </div>
          <div id="email-config-msg" style="font-size:12.5px;"></div>
        </form>
        ${emailCfg.configured ? `<button class="btn" id="email-disconnect-btn" style="margin-top:10px; color:#ef4444;">Remove email settings</button>` : ''}
      </div>

      <h1 class="page-title" style="font-size:16px; margin-top:32px;">📊 Google Sheets Sync <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(optional)</span></h1>
      <p class="page-sub">
        Automatically mirrors your leads (and optionally agents/departments/widgets/stats) into a Google Sheet as a live backup.
        The database here stays the source of truth — the Sheet is a one-way export, not something the app reads from on load.
        <strong>For security, agent passwords are never included in this sync.</strong>
      </p>
      <div id="sheets-settings-box">
        <form id="sheets-config-form" class="form-grid" style="max-width:480px;">
          <label>Apps Script Web App URL</label>
          <input name="webhook_url" placeholder="https://script.google.com/macros/s/AKfycb.../exec" value="${escapeHtml(sheetsCfg.webhook_url || '')}" required />
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" name="sync_leads" style="width:auto;" ${sheetsCfg.sync_leads !== false ? 'checked' : ''} /> Sync new leads/visitors automatically</label>
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" name="sync_admin_data" style="width:auto;" ${sheetsCfg.sync_admin_data !== false ? 'checked' : ''} /> Include agents (no passwords), departments, widgets & stats on manual sync</label>
          <div style="display:flex; gap:8px;">
            <button class="btn primary" type="submit">Save</button>
            ${sheetsCfg.configured ? `<button class="btn" type="button" id="sheets-sync-now-btn">🔄 Sync Now</button>` : ''}
          </div>
          <div id="sheets-config-msg" style="font-size:12.5px;"></div>
        </form>
        ${sheetsCfg.configured ? `
          <p style="font-size:11.5px; color:var(--ink-soft); margin-top:10px;">
            Last synced: ${sheetsCfg.last_synced_at ? timeAgo(sheetsCfg.last_synced_at) : 'never'}
            ${sheetsCfg.last_sync_status ? ' · ' + escapeHtml(sheetsCfg.last_sync_status) : ''}
          </p>
          <button class="btn" id="sheets-disconnect-btn" style="margin-top:6px; color:#ef4444;">Remove Sheets sync</button>
        ` : `
          <p class="page-sub" style="margin-top:10px; max-width:480px;">
            Don't have this set up yet? The <strong>google-apps-script/</strong> folder in your download package has the
            script code and a step-by-step Hinglish guide (Admin → Widget Customizer → any widget → Download .zip, or see the main package).
          </p>
        `}
      </div>
    `;
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/company', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(fd)) });
      document.getElementById('settings-saved').textContent = 'Saved!';
    });

    // ---- Email config wiring ----
    document.getElementById('email-config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      payload.smtp_secure = fd.get('smtp_secure') === 'on';
      payload.notify_on_new_lead = fd.get('notify_on_new_lead') === 'on';
      payload.notify_agent_on_assign = fd.get('notify_agent_on_assign') === 'on';
      const msgEl = document.getElementById('email-config-msg');
      try {
        await api('/email/config', { method: 'POST', body: JSON.stringify(payload) });
        msgEl.style.color = '#16a34a';
        msgEl.textContent = 'Saved!';
        renderSettings();
      } catch (err) {
        msgEl.style.color = '#ef4444';
        msgEl.textContent = err.message;
      }
    });
    document.getElementById('email-test-btn').addEventListener('click', async () => {
      const fd = new FormData(document.getElementById('email-config-form'));
      const payload = Object.fromEntries(fd);
      payload.smtp_secure = fd.get('smtp_secure') === 'on';
      payload.sendTest = true;
      const msgEl = document.getElementById('email-config-msg');
      msgEl.style.color = '#64748b';
      msgEl.textContent = 'Sending test email…';
      try {
        await api('/email/config', { method: 'POST', body: JSON.stringify(payload) });
        msgEl.style.color = '#16a34a';
        msgEl.textContent = 'Test email sent — check your inbox!';
      } catch (err) {
        msgEl.style.color = '#ef4444';
        msgEl.textContent = err.message;
      }
    });
    if (emailCfg.configured) {
      document.getElementById('email-disconnect-btn').addEventListener('click', async () => {
        if (!confirm('Remove email notification settings?')) return;
        await api('/email/config', { method: 'DELETE' });
        renderSettings();
      });
    }

    // ---- Sheets config wiring ----
    document.getElementById('sheets-config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        webhook_url: fd.get('webhook_url'),
        sync_leads: fd.get('sync_leads') === 'on',
        sync_admin_data: fd.get('sync_admin_data') === 'on',
      };
      const msgEl = document.getElementById('sheets-config-msg');
      try {
        await api('/sheets/config', { method: 'POST', body: JSON.stringify(payload) });
        msgEl.style.color = '#16a34a';
        msgEl.textContent = 'Saved!';
        renderSettings();
      } catch (err) {
        msgEl.style.color = '#ef4444';
        msgEl.textContent = err.message;
      }
    });
    const syncNowBtn = document.getElementById('sheets-sync-now-btn');
    if (syncNowBtn) {
      syncNowBtn.addEventListener('click', async () => {
        syncNowBtn.disabled = true;
        syncNowBtn.textContent = 'Syncing…';
        const msgEl = document.getElementById('sheets-config-msg');
        try {
          await api('/sheets/sync-now', { method: 'POST' });
          msgEl.style.color = '#16a34a';
          msgEl.textContent = 'Synced!';
        } catch (err) {
          msgEl.style.color = '#ef4444';
          msgEl.textContent = err.message;
        }
        renderSettings();
      });
    }
    const sheetsDisconnectBtn = document.getElementById('sheets-disconnect-btn');
    if (sheetsDisconnectBtn) {
      sheetsDisconnectBtn.addEventListener('click', async () => {
        if (!confirm('Remove Google Sheets sync?')) return;
        await api('/sheets/config', { method: 'DELETE' });
        renderSettings();
      });
    }

    if (tg.configured) {
      document.getElementById('telegram-disconnect-btn').addEventListener('click', async () => {
        if (!confirm('Disconnect Telegram? Agents will no longer be able to reply from Telegram.')) return;
        await api('/telegram/config', { method: 'DELETE' });
        renderSettings();
      });
      const retryBtn = document.getElementById('telegram-retry-webhook-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = 'Retrying…';
          try {
            const result = await api('/telegram/retry-webhook', { method: 'POST' });
            if (!result.ok) alert('Still failing: ' + (result.message || 'unknown error'));
          } catch (err) {
            alert(err.message);
          }
          renderSettings();
        });
      }
    } else {
      document.getElementById('telegram-config-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errEl = document.getElementById('telegram-config-error');
        errEl.textContent = 'Validating token…';
        try {
          await api('/telegram/config', { method: 'POST', body: JSON.stringify({ botToken: fd.get('botToken') }) });
          renderSettings();
        } catch (err) {
          errEl.textContent = err.message;
        }
      });
    }
  }

  // ---------------- Widget Customizer (multiple widgets) ----------------
  const ICON_PRESETS = ['💬', '🗨️', '💭', '📞', '🎧', '❓', '🤖', '👋', '✉️', '⭐'];
  const POSITION_OPTIONS = [
    { value: 'bottom-right', label: 'Bottom Right', short: 'default' },
    { value: 'bottom-left', label: 'Bottom Left' },
    { value: 'top-right', label: 'Top Right' },
    { value: 'top-left', label: 'Top Left' },
  ];
  const POSITION_LABELS = Object.fromEntries(POSITION_OPTIONS.map(p => [p.value, p.label]));

  function positionPreviewStyle(pos) {
    const styles = {
      'bottom-right': 'bottom:10px; right:10px;',
      'bottom-left': 'bottom:10px; left:10px;',
      'top-right': 'top:10px; right:10px;',
      'top-left': 'top:10px; left:10px;',
    };
    return styles[pos] || styles['bottom-right'];
  }

  async function renderWidgetCustomizer() {
    const widgets = await api('/widgets');
    pageRoot.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <div>
          <h1 class="page-title">Widget Customizer</h1>
          <p class="page-sub">Run one widget per website — each gets its own name, look, position, and embed code. Changes apply live, no code edits needed.</p>
        </div>
        <button class="btn primary" id="add-widget-btn">+ Add new widget</button>
      </div>
      <div id="widgets-list"></div>
    `;
    const listEl = document.getElementById('widgets-list');
    widgets.forEach(w => listEl.appendChild(buildWidgetCard(w, widgets.length)));

    document.getElementById('add-widget-btn').addEventListener('click', async () => {
      const name = prompt('Name this widget (e.g. "Main Website", "Support Portal"):');
      if (!name || !name.trim()) return;
      await api('/widgets', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      renderWidgetCustomizer();
    });
  }

  function buildWidgetCard(widget, totalWidgetCount) {
    let selectedPosition = widget.widget_position || 'bottom-right';
    let selectedColor = widget.brand_color || '#16a34a';
    let selectedIconType = widget.icon_type || 'emoji';
    let selectedIconValue = widget.icon_value || '💬';
    const origin = location.origin;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; margin-top:20px;';
    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <input class="widget-name-input" value="${escapeHtml(widget.name)}" style="font-size:16px; font-weight:700; border:none; background:transparent; padding:4px 0; border-bottom:1px dashed transparent;" />
        ${totalWidgetCount > 1 ? `<button class="btn delete-widget-btn" style="color:#ef4444;">🗑️ Delete widget</button>` : ''}
      </div>

      <div class="two-col" style="grid-template-columns: 1fr 300px;">
        <div>
          <div style="font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;">BUTTON POSITION</div>
          <div class="position-options" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px; max-width:380px; margin-bottom:20px;">
            ${POSITION_OPTIONS.map(p => `
              <button type="button" class="btn position-choice" data-pos="${p.value}" style="text-align:left; padding:10px;">
                <strong>${p.label}</strong>${p.short ? ` <span style="color:#94a3b8;font-size:11px;">(${p.short})</span>` : ''}
              </button>
            `).join('')}
          </div>

          <div style="font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;">BRAND COLOR</div>
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:20px;">
            <input type="color" class="color-input" value="${selectedColor}" style="width:50px; height:36px; border:1px solid var(--border); border-radius:6px; cursor:pointer;" />
            <input type="text" class="color-text" value="${selectedColor}" style="width:100px; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:12.5px; font-family:monospace;" />
          </div>

          <div style="font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;">FLOATING BUTTON ICON</div>
          <div style="display:flex; gap:6px; margin-bottom:10px;">
            <button type="button" class="btn icon-type-btn" data-type="emoji" style="flex:1;">😀 Emoji</button>
            <button type="button" class="btn icon-type-btn" data-type="image" style="flex:1;">🖼️ Upload image</button>
          </div>
          <div class="emoji-picker-wrap" style="display:flex; flex-wrap:wrap; gap:6px; max-width:380px; margin-bottom:10px;">
            ${ICON_PRESETS.map(icon => `<button type="button" class="btn icon-choice" data-icon="${icon}" style="font-size:18px; width:40px; height:40px; padding:0;">${icon}</button>`).join('')}
          </div>
          <div class="emoji-picker-wrap" style="display:flex; align-items:center; gap:10px; margin-bottom:20px;">
            <label style="font-size:12px; color:var(--ink-soft); font-weight:600;">Or custom emoji/symbol:</label>
            <input type="text" class="icon-text-input" value="${selectedIconType === 'emoji' ? escapeHtml(selectedIconValue) : ''}" maxlength="4" style="width:50px; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:15px; text-align:center;" />
          </div>
          <div class="image-picker-wrap" style="display:none; align-items:center; gap:10px; margin-bottom:20px;">
            <input type="file" class="icon-image-input" accept="image/*" style="font-size:12px;" />
            <span class="icon-upload-status" style="font-size:11.5px; color:var(--ink-soft);"></span>
          </div>

          <div style="margin-top:8px;">
            <button class="btn primary save-widget-btn">Save changes</button>
            <span class="save-status" style="color:#16a34a; font-size:12.5px; margin-left:10px;"></span>
          </div>

          <div style="margin-top:24px; padding-top:20px; border-top:1px solid var(--border);">
            <div style="font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;">EMBED CODE FOR "${escapeHtml(widget.name)}"</div>
            <div class="embed-box" style="font-size:12px;">&lt;script src="${origin}/widget.js" data-company="${widget.widget_key}"&gt;&lt;/script&gt;</div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <button class="btn copy-embed-btn">📋 Copy code</button>
              <button class="btn download-zip-btn">⬇️ Download code + guide (.zip)</button>
            </div>
          </div>

          <div style="margin-top:24px; padding-top:20px; border-top:1px solid var(--border);">
            <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; font-weight:700; color:var(--ink-soft); margin-bottom:10px;">
              <input type="checkbox" class="lead-form-toggle" ${widget.lead_form_enabled ? 'checked' : ''} style="width:auto;" />
              LEAD CAPTURE FORM — ask for Name / Mobile / Email before chat starts
            </label>
            <div class="lead-form-fields" style="${widget.lead_form_enabled ? '' : 'display:none;'} max-width:420px;">
              <label style="font-size:12px; font-weight:600; color:var(--ink-soft);">"Interested in..." options (one per line)</label>
              <textarea class="lead-form-services-input" rows="4" style="width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:12.5px; margin-top:4px; box-sizing:border-box;">${(JSON.parse(widget.lead_form_services || '["General Inquiry"]')).join('\n')}</textarea>
              <label style="font-size:12px; font-weight:600; color:var(--ink-soft); margin-top:10px; display:block;">Consent checkbox text</label>
              <input type="text" class="lead-form-consent-input" value="${escapeHtml(widget.lead_form_consent_text || 'I agree to be contacted regarding my inquiry.')}" style="width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:12.5px; margin-top:4px; box-sizing:border-box;" />
              <p style="font-size:11px; color:var(--ink-soft); margin-top:8px;">Name, Mobile, and Email are always mandatory fields on this form. Once submitted, visitors won't be asked their name/contact again in the bot flow.</p>
            </div>
          </div>
        </div>

        <div>
          <div style="font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;">LIVE PREVIEW</div>
          <div class="preview-box" style="position:relative; height:280px; background:#f1f5f9; border:1px solid var(--border); border-radius:12px; overflow:hidden;">
            <div style="position:absolute; top:10px; left:10px; right:10px; height:8px; background:#e2e8f0; border-radius:4px;"></div>
            <div style="position:absolute; top:26px; left:10px; width:60%; height:8px; background:#e2e8f0; border-radius:4px;"></div>
            <button class="preview-fab" style="position:absolute; width:48px; height:48px; border-radius:50%; border:none; color:#fff; font-size:20px; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 20px rgba(0,0,0,0.18); cursor:default; overflow:hidden;"></button>
          </div>
        </div>
      </div>
    `;

    const previewFab = wrap.querySelector('.preview-fab');
    const colorInput = wrap.querySelector('.color-input');
    const colorText = wrap.querySelector('.color-text');
    const iconTextInput = wrap.querySelector('.icon-text-input');
    const emojiPickerWraps = wrap.querySelectorAll('.emoji-picker-wrap');
    const imagePickerWrap = wrap.querySelector('.image-picker-wrap');
    const iconImageInput = wrap.querySelector('.icon-image-input');
    const iconUploadStatus = wrap.querySelector('.icon-upload-status');

    function updatePreview() {
      previewFab.style.top = previewFab.style.bottom = previewFab.style.left = previewFab.style.right = '';
      positionPreviewStyle(selectedPosition).split(';').filter(Boolean).forEach(rule => {
        const [prop, val] = rule.split(':').map(s => s.trim());
        previewFab.style[prop] = val;
      });
      previewFab.style.background = selectedColor;
      if (selectedIconType === 'image' && selectedIconValue) {
        previewFab.innerHTML = `<img src="${selectedIconValue}" style="width:100%;height:100%;object-fit:cover;" />`;
      } else {
        previewFab.textContent = selectedIconValue;
      }

      wrap.querySelectorAll('.position-choice').forEach(btn => btn.classList.toggle('primary', btn.dataset.pos === selectedPosition));
      wrap.querySelectorAll('.icon-choice').forEach(btn => btn.classList.toggle('primary', selectedIconType === 'emoji' && btn.dataset.icon === selectedIconValue));
      wrap.querySelectorAll('.icon-type-btn').forEach(btn => btn.classList.toggle('primary', btn.dataset.type === selectedIconType));
      emojiPickerWraps.forEach(el => el.style.display = selectedIconType === 'emoji' ? 'flex' : 'none');
      imagePickerWrap.style.display = selectedIconType === 'image' ? 'flex' : 'none';
    }

    wrap.querySelectorAll('.position-choice').forEach(btn => {
      btn.addEventListener('click', () => { selectedPosition = btn.dataset.pos; updatePreview(); });
    });
    wrap.querySelectorAll('.icon-choice').forEach(btn => {
      btn.addEventListener('click', () => { selectedIconType = 'emoji'; selectedIconValue = btn.dataset.icon; iconTextInput.value = selectedIconValue; updatePreview(); });
    });
    wrap.querySelectorAll('.icon-type-btn').forEach(btn => {
      btn.addEventListener('click', () => { selectedIconType = btn.dataset.type; updatePreview(); });
    });
    colorInput.addEventListener('input', () => { selectedColor = colorInput.value; colorText.value = colorInput.value; updatePreview(); });
    colorText.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(colorText.value)) { selectedColor = colorText.value; colorInput.value = colorText.value; updatePreview(); }
    });
    iconTextInput.addEventListener('input', () => { selectedIconType = 'emoji'; selectedIconValue = iconTextInput.value || '💬'; updatePreview(); });

    iconImageInput.addEventListener('change', async () => {
      const file = iconImageInput.files[0];
      if (!file) return;
      iconUploadStatus.textContent = 'Uploading…';
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(API + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        selectedIconType = 'image';
        selectedIconValue = data.url;
        iconUploadStatus.textContent = '✓ ' + data.name;
        updatePreview();
      } catch (err) {
        iconUploadStatus.textContent = err.message;
      }
    });

    wrap.querySelector('.lead-form-toggle').addEventListener('change', (e) => {
      wrap.querySelector('.lead-form-fields').style.display = e.target.checked ? '' : 'none';
    });

    wrap.querySelector('.save-widget-btn').addEventListener('click', async () => {
      const name = wrap.querySelector('.widget-name-input').value.trim() || widget.name;
      const leadFormEnabled = wrap.querySelector('.lead-form-toggle').checked;
      const services = wrap.querySelector('.lead-form-services-input').value.split('\n').map(s => s.trim()).filter(Boolean);
      const consentText = wrap.querySelector('.lead-form-consent-input').value.trim();
      await api(`/widgets/${widget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          brand_color: selectedColor,
          widget_position: selectedPosition,
          icon_type: selectedIconType,
          icon_value: selectedIconValue,
          lead_form_enabled: leadFormEnabled,
          lead_form_services: JSON.stringify(services.length ? services : ['General Inquiry']),
          lead_form_consent_text: consentText || 'I agree to be contacted regarding my inquiry.',
        }),
      });
      const statusEl = wrap.querySelector('.save-status');
      statusEl.textContent = 'Saved! Live on your website now.';
      setTimeout(() => (statusEl.textContent = ''), 3000);
    });

    if (wrap.querySelector('.delete-widget-btn')) {
      wrap.querySelector('.delete-widget-btn').addEventListener('click', async () => {
        if (!confirm(`Delete widget "${widget.name}"? Any website using its embed code will stop showing the chat button.`)) return;
        try {
          await api(`/widgets/${widget.id}`, { method: 'DELETE' });
          renderWidgetCustomizer();
        } catch (err) {
          alert(err.message);
        }
      });
    }

    wrap.querySelector('.copy-embed-btn').addEventListener('click', () => {
      const code = `<script src="${origin}/widget.js" data-company="${widget.widget_key}"></script>`;
      navigator.clipboard.writeText(code);
      const btn = wrap.querySelector('.copy-embed-btn');
      const original = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => (btn.textContent = original), 1500);
    });

    wrap.querySelector('.download-zip-btn').addEventListener('click', async () => {
      const btn = wrap.querySelector('.download-zip-btn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      try {
        const res = await fetch(API + `/widgets/${widget.id}/export-zip`, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('Failed to generate ZIP');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-widget-embed-${widget.widget_key}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    updatePreview();
    return wrap;
  }

  // ---------------- Bot Flow builder ----------------
  async function renderBotFlow() {
    const questions = await api('/bot-questions');
    pageRoot.innerHTML = `
      <h1 class="page-title">Bot Flow</h1>
      <p class="page-sub">These are the questions your bot asks a visitor, in order, before handing off to an agent. "Multiple choice" questions can also route the chat to a department.</p>
      <div id="questions-list">${questions.map(renderQuestionCard).join('') || '<div class="empty-state">No questions yet — add one below.</div>'}</div>

      <h1 class="page-title" style="font-size:16px; margin-top:24px;">Add a question</h1>
      <form id="add-question-form" class="form-grid" style="max-width:520px;">
        <label>Field key (internal name, e.g. "budget", "company_size")</label>
        <input name="field_key" placeholder="e.g. budget" required />
        <label>Question text (what the visitor sees)</label>
        <input name="question_text" placeholder="e.g. What is your budget?" required />
        <label>Type</label>
        <select name="type" id="q-type-select">
          <option value="text">Free text answer</option>
          <option value="choice">Multiple choice (buttons)</option>
        </select>
        <div id="choices-wrap" class="hidden">
          <label>Options (each can optionally route to a department)</label>
          <div id="choices-rows"></div>
          <button type="button" class="btn" id="add-choice-row" style="margin-top:4px;">+ Add option</button>
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
          <input type="checkbox" name="required" style="width:auto;" /> Required (visitor must answer, "skip" not allowed)
        </label>
        <label id="routing-label" class="hidden" style="display:flex; align-items:center; gap:6px; font-weight:400;">
          <input type="checkbox" name="is_category_routing" style="width:auto;" /> Use this question's answer to route to a department
        </label>
        <button class="btn primary" type="submit">Add question</button>
        <div id="add-question-error" style="color:#ef4444;font-size:12.5px;"></div>
      </form>
    `;

    document.querySelectorAll('.q-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this question?')) return;
        await api('/bot-questions/' + btn.dataset.id, { method: 'DELETE' });
        renderBotFlow();
      });
    });
    document.querySelectorAll('.q-move-up, .q-move-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ids = questions.map(q => q.id);
        const idx = ids.indexOf(btn.dataset.id);
        const swapWith = btn.classList.contains('q-move-up') ? idx - 1 : idx + 1;
        if (swapWith < 0 || swapWith >= ids.length) return;
        [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
        await api('/bot-questions/reorder', { method: 'POST', body: JSON.stringify({ orderedIds: ids }) });
        renderBotFlow();
      });
    });

    const typeSelect = document.getElementById('q-type-select');
    const choicesWrap = document.getElementById('choices-wrap');
    const routingLabel = document.getElementById('routing-label');
    const choicesRows = document.getElementById('choices-rows');

    function addChoiceRow() {
      const row = document.createElement('div');
      row.className = 'choice-row';
      row.innerHTML = `
        <input placeholder="Value (e.g. 1)" class="choice-value" style="max-width:70px;" />
        <input placeholder="Label (e.g. Sales)" class="choice-label" />
        <select class="choice-dept"><option value="">No routing</option>${departmentsCache.map(d => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select>
        <button type="button" class="btn choice-remove">✕</button>
      `;
      row.querySelector('.choice-remove').addEventListener('click', () => row.remove());
      choicesRows.appendChild(row);
    }

    typeSelect.addEventListener('change', () => {
      const isChoice = typeSelect.value === 'choice';
      choicesWrap.classList.toggle('hidden', !isChoice);
      routingLabel.classList.toggle('hidden', !isChoice);
      if (isChoice && !choicesRows.children.length) { addChoiceRow(); addChoiceRow(); }
    });
    document.getElementById('add-choice-row').addEventListener('click', addChoiceRow);

    document.getElementById('add-question-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        field_key: fd.get('field_key').trim(),
        question_text: fd.get('question_text').trim(),
        type: fd.get('type'),
        required: fd.get('required') === 'on',
        is_category_routing: fd.get('is_category_routing') === 'on',
      };
      if (payload.type === 'choice') {
        const rows = [...choicesRows.querySelectorAll('.choice-row')];
        const choices = rows.map(r => ({
          value: r.querySelector('.choice-value').value.trim(),
          label: r.querySelector('.choice-label').value.trim(),
          department: r.querySelector('.choice-dept').value || null,
        })).filter(c => c.value && c.label);
        payload.choices = JSON.stringify(choices);
      }
      try {
        await api('/bot-questions', { method: 'POST', body: JSON.stringify(payload) });
        renderBotFlow();
      } catch (err) {
        document.getElementById('add-question-error').textContent = err.message;
      }
    });
  }

  function renderQuestionCard(q, index, arr) {
    const choices = q.choices ? JSON.parse(q.choices) : null;
    return `
      <div class="question-card">
        <div>
          <div class="qtext">${index + 1}. ${escapeHtml(q.question_text)}</div>
          <div class="qmeta">
            field: <code>${escapeHtml(q.field_key)}</code> ·
            ${q.type === 'choice' ? 'multiple choice' : 'free text'}
            ${q.required ? ' · required' : ''}
            ${q.is_category_routing ? ' · routes to department' : ''}
          </div>
          ${choices ? `<div class="qmeta">options: ${choices.map(c => escapeHtml(c.label) + (c.department ? ` → ${escapeHtml(c.department)}` : '')).join(', ')}</div>` : ''}
        </div>
        <div class="qactions">
          <button class="btn q-move-up" data-id="${q.id}" title="Move up">↑</button>
          <button class="btn q-move-down" data-id="${q.id}" title="Move down">↓</button>
          <button class="btn q-delete-btn" data-id="${q.id}" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }

  // ---------------- My Account ----------------
  async function renderAccount() {
    const tg = await api('/telegram/status');
    pageRoot.innerHTML = `
      <h1 class="page-title">My Account</h1>
      <p class="page-sub">Update your name, email, or password.</p>
      <form id="account-form" class="form-grid">
        <label>Name</label><input name="name" value="${escapeHtml(me.name)}" />
        <label>Email</label><input name="email" type="email" value="${escapeHtml(me.email)}" />
        <label>Current password (required only if changing password)</label><input name="currentPassword" type="password" />
        <label>New password (leave blank to keep current)</label><input name="newPassword" type="password" />
        <button class="btn primary" type="submit">Save changes</button>
        <div id="account-msg" style="font-size:12.5px;"></div>
      </form>

      <h1 class="page-title" style="font-size:16px; margin-top:32px;">🔵 Telegram <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(optional)</span></h1>
      <div id="telegram-account-box" style="max-width:420px;">
        ${!tg.configured ? `
          <p class="page-sub">Your admin hasn't set up Telegram for this workspace yet.</p>
        ` : tg.myTelegramLinked ? `
          <p class="page-sub">✅ Your Telegram is linked. When a chat is assigned to you, you'll get it on Telegram and can reply from there.</p>
          <button class="btn" id="telegram-unlink-btn">Unlink Telegram</button>
        ` : `
          <p class="page-sub">Link your Telegram to receive and reply to assigned chats without opening this dashboard.</p>
          <button class="btn primary" id="telegram-get-code-btn">Get my link code</button>
          <div id="telegram-link-instructions" style="margin-top:12px;"></div>
        `}
      </div>
    `;
    document.getElementById('account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd);
      if (!payload.newPassword) delete payload.newPassword;
      if (!payload.currentPassword) delete payload.currentPassword;
      const msgEl = document.getElementById('account-msg');
      try {
        const updated = await api('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) });
        me = { ...me, ...updated };
        document.getElementById('me-name').textContent = `${me.name} · ${me.role.replace('_', ' ')}`;
        msgEl.style.color = '#16a34a';
        msgEl.textContent = 'Saved!';
        e.target.currentPassword.value = '';
        e.target.newPassword.value = '';
      } catch (err) {
        msgEl.style.color = '#ef4444';
        msgEl.textContent = err.message;
      }
    });

    if (tg.configured && !tg.myTelegramLinked) {
      document.getElementById('telegram-get-code-btn').addEventListener('click', async () => {
        const { code, botUsername } = await api('/telegram/link-code', { method: 'POST' });
        document.getElementById('telegram-link-instructions').innerHTML = `
          <div class="card">
            <p style="font-size:13px; margin:0 0 10px;">1. Open Telegram and go to <strong>@${escapeHtml(botUsername)}</strong></p>
            <p style="font-size:13px; margin:0 0 10px;">2. Send this message to the bot:</p>
            <div class="embed-box" style="font-size:14px;">/start ${escapeHtml(code)}</div>
            <p style="font-size:11.5px; color:var(--ink-soft); margin:10px 0 0;">This code expires once used. Refresh this page after linking to see the confirmed status.</p>
          </div>
        `;
      });
    }
    if (tg.myTelegramLinked) {
      document.getElementById('telegram-unlink-btn').addEventListener('click', async () => {
        await api('/telegram/link', { method: 'DELETE' });
        renderAccount();
      });
    }
  }

  // ---------------- Boot ----------------
  if (token) boot(); else { loginScreen.classList.remove('hidden'); }
})();
