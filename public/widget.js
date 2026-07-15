/**
 * Live Chat CRM — Embeddable Widget
 * Usage: <script src="https://your-domain.com/widget.js" data-company="WIDGET_KEY"></script>
 */
(function () {
  const scriptEl = document.currentScript;
  const WIDGET_KEY = scriptEl.getAttribute('data-company');
  if (!WIDGET_KEY) {
    console.error('[LiveChat] Missing data-company attribute on widget script tag.');
    return;
  }
  // Manual position override — see the "WIDGET POSITION" comment block below for details.
  // If not set here, the position chosen in Admin → Widget Customizer is used instead.
  const POSITION_OVERRIDE = scriptEl.getAttribute('data-position'); // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  const VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  const ORIGIN = new URL(scriptEl.src).origin;
  const STORAGE_KEY = 'livechat_conv_' + WIDGET_KEY;

  // ---------- Load socket.io client from the backend ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ---------- Inject styles ----------
  const style = document.createElement('style');
  style.textContent = `
    /* ============================================================
       📍 WIDGET POSITION — floating button ka corner yahan se control hota hai
       ============================================================
       Normally this is set from Admin → Widget Customizer (no code needed).
       To override for just this website, add data-position to the <script> tag:
         <script src="....widget.js" data-company="KEY" data-position="top-left"></script>
       Valid values: bottom-right (default), bottom-left, top-right, top-left

       Har position class do cheezein set karta hai:
       1) #lc-fab (floating bubble) ka corner
       2) #lc-window (chat box) ka corner — bubble ke jitna hi paas khulta hai
       ============================================================ */
    #lc-fab {
      position: fixed; width: 60px; height: 60px;
      border-radius: 50%; background: var(--lc-brand, #16a34a); color: #fff; border: none;
      box-shadow: 0 10px 25px rgba(22,163,74,0.4); cursor: pointer; display: flex;
      align-items: center; justify-content: center; font-size: 26px; z-index: 999999;
      transition: transform .2s ease;
    }
    #lc-fab.lc-pos-bottom-right { bottom: 24px; right: 24px; }
    #lc-fab.lc-pos-bottom-left  { bottom: 24px; left: 24px; }
    #lc-fab.lc-pos-top-right    { top: 24px; right: 24px; }
    #lc-fab.lc-pos-top-left     { top: 24px; left: 24px; }
    #lc-fab:hover { transform: scale(1.08); }
    #lc-fab.hidden { display: none; }
    #lc-badge {
      position: absolute; top: -2px; right: -2px; background: #ef4444; color: #fff;
      font-size: 11px; font-weight: 700; min-width: 20px; height: 20px; border-radius: 20px;
      display: none; align-items: center; justify-content: center; border: 2px solid #fff;
    }
    #lc-window {
      position: fixed; width: 360px; height: 580px;
      max-height: calc(100vh - 120px); background: #fff; border-radius: 20px;
      box-shadow: 0 20px 45px rgba(0,0,0,0.18); display: none; flex-direction: column;
      overflow: hidden; z-index: 999999; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
      border: 1px solid #e2e8f0;
    }
    /* Chat window opens just above/below its corresponding fab button */
    #lc-window.lc-pos-bottom-right { bottom: 96px; right: 24px; }
    #lc-window.lc-pos-bottom-left  { bottom: 96px; left: 24px; }
    #lc-window.lc-pos-top-right    { top: 96px; right: 24px; }
    #lc-window.lc-pos-top-left     { top: 96px; left: 24px; }
    #lc-window.open { display: flex; }
    #lc-window.dark { background: #1e293b; border-color: #334155; }
    @media (max-width: 480px) {
      #lc-window.open { bottom: 0; top: auto; right: 0; left: 0; width: 100%; height: 100%; max-height: 100%; border-radius: 0; }
      #lc-fab.lc-pos-bottom-right, #lc-fab.lc-pos-top-right { right: 20px; }
      #lc-fab.lc-pos-bottom-left, #lc-fab.lc-pos-top-left { left: 20px; }
      #lc-fab.lc-pos-bottom-right, #lc-fab.lc-pos-bottom-left { bottom: 20px; top: auto; }
      #lc-fab.lc-pos-top-right, #lc-fab.lc-pos-top-left { top: 20px; bottom: auto; }
    }
    #lc-header {
      display: flex; align-items: center; justify-content: space-between; padding: 14px 16px;
      background: var(--lc-brand, #16a34a); color: #fff; flex-shrink: 0;
    }
    #lc-header .lc-title { font-weight: 700; font-size: 15px; }
    #lc-header .lc-sub { font-size: 11px; opacity: .9; }
    #lc-header button { background: transparent; border: none; color: #fff; font-size: 18px; cursor: pointer; padding: 4px 8px; }
    #lc-messages { flex: 1; overflow-y: auto; padding: 14px; background: #f8fafc; }
    #lc-window.dark #lc-messages { background: #0f172a; }
    .lc-row { display: flex; margin-bottom: 10px; }
    .lc-row.out { justify-content: flex-end; }
    .lc-bubble { max-width: 78%; padding: 9px 12px; border-radius: 14px; font-size: 13.5px; line-height: 1.4; white-space: pre-wrap; }
    .lc-row.in .lc-bubble { background: #fff; color: #0f172a; border-bottom-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .lc-row.out .lc-bubble { background: var(--lc-brand, #16a34a); color: #fff; border-bottom-right-radius: 4px; }
    .lc-row.sys { justify-content: center; }
    .lc-row.sys .lc-bubble { background: #e2e8f0; color: #475569; font-size: 11.5px; border-radius: 10px; }
    #lc-window.dark .lc-row.in .lc-bubble { background: #334155; color: #f1f5f9; }
    #lc-typing { font-size: 11px; color: #64748b; padding: 0 14px 6px; min-height: 16px; }
    #lc-inputbar { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e2e8f0; flex-shrink: 0; }
    #lc-window.dark #lc-inputbar { border-color: #334155; }
    #lc-input {
      flex: 1; border: 1px solid #e2e8f0; border-radius: 20px; padding: 9px 14px; font-size: 13.5px;
      outline: none; background: #fff; color: #0f172a;
    }
    #lc-window.dark #lc-input { background: #1e293b; color: #f1f5f9; border-color: #334155; }
    #lc-send {
      background: var(--lc-brand, #16a34a); border: none; color: #fff; width: 38px; height: 38px;
      border-radius: 50%; cursor: pointer; flex-shrink: 0; font-size: 15px;
    }
    .lc-attach-btn { background: transparent; border: none; font-size: 19px; cursor: pointer; padding: 0 4px; flex-shrink: 0; }
    .lc-quick-replies { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
    .lc-quick-replies button {
      border: 1px solid var(--lc-brand, #16a34a); color: var(--lc-brand, #16a34a); background: #fff;
      border-radius: 14px; padding: 6px 10px; font-size: 12px; cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  // ---------- Inject DOM ----------
  const root = document.createElement('div');
  root.innerHTML = `
    <button id="lc-fab" aria-label="Open chat"><span id="lc-fab-icon">💬</span><span id="lc-badge"></span></button>
    <div id="lc-window" role="dialog" aria-label="Live chat">
      <div id="lc-header">
        <div>
          <div class="lc-title">Chat with us</div>
          <div class="lc-sub" id="lc-status">Connecting…</div>
        </div>
        <div>
          <button id="lc-dark-toggle" title="Toggle dark mode">🌙</button>
          <button id="lc-close" title="Close" aria-label="Close chat">✕</button>
        </div>
      </div>
      <div id="lc-lead-form" class="hidden"></div>
      <div id="lc-messages"></div>
      <div id="lc-typing"></div>
      <div id="lc-attach-preview" style="font-size:11px;color:#64748b;padding:0 14px 6px;"></div>
      <div id="lc-inputbar">
        <button id="lc-attach-btn" class="lc-attach-btn" title="Attach a file" type="button">📎</button>
        <input type="file" id="lc-attach-file" style="display:none;" />
        <input id="lc-input" type="text" placeholder="Type a message…" autocomplete="off" />
        <button id="lc-send" aria-label="Send">➤</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // ---------- Lead form styles ----------
  const leadFormStyle = document.createElement('style');
  leadFormStyle.textContent = `
    #lc-lead-form { padding: 16px; overflow-y: auto; flex: 1; background: #f8fafc; }
    #lc-lead-form.hidden { display: none; }
    #lc-lead-form h3 { margin: 0 0 4px; font-size: 15px; color: #0f172a; }
    #lc-lead-form p.lc-lf-sub { margin: 0 0 14px; font-size: 12px; color: #64748b; }
    #lc-lead-form label { display: block; font-size: 12px; font-weight: 600; color: #475569; margin: 12px 0 4px; }
    #lc-lead-form input[type="text"], #lc-lead-form input[type="tel"], #lc-lead-form input[type="email"] {
      width: 100%; padding: 9px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13.5px; box-sizing: border-box;
    }
    .lc-lf-dropdown { position: relative; }
    .lc-lf-dropdown-btn {
      width: 100%; text-align: left; padding: 9px 12px; border: 1px solid #e2e8f0; border-radius: 8px;
      font-size: 13.5px; background: #fff; cursor: pointer; color: #0f172a;
    }
    .lc-lf-dropdown-panel {
      display: none; position: absolute; top: 100%; left: 0; right: 0; background: #fff; border: 1px solid #e2e8f0;
      border-radius: 8px; margin-top: 4px; max-height: 160px; overflow-y: auto; z-index: 10; box-shadow: 0 8px 20px rgba(0,0,0,.1);
    }
    .lc-lf-dropdown-panel.open { display: block; }
    .lc-lf-dropdown-panel label {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin: 0; font-weight: 400; font-size: 13px; cursor: pointer;
    }
    .lc-lf-dropdown-panel label:hover { background: #f1f5f9; }
    .lc-lf-consent { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; font-size: 11.5px; color: #64748b; font-weight: 400; }
    .lc-lf-consent input { margin-top: 2px; }
    #lc-lead-form button[type="submit"] {
      width: 100%; margin-top: 16px; padding: 10px; border: none; border-radius: 8px; background: var(--lc-brand, #16a34a);
      color: #fff; font-weight: 700; font-size: 13.5px; cursor: pointer;
    }
    #lc-lead-form button[type="submit"]:disabled { opacity: .5; cursor: not-allowed; }
    #lc-lead-form .lc-lf-error { color: #ef4444; font-size: 11.5px; margin-top: 8px; min-height: 14px; }
  `;
  document.head.appendChild(leadFormStyle);

  const fab = document.getElementById('lc-fab');
  const fabIcon = document.getElementById('lc-fab-icon');
  const windowEl = document.getElementById('lc-window');
  const messagesEl = document.getElementById('lc-messages');
  const inputEl = document.getElementById('lc-input');
  const sendBtn = document.getElementById('lc-send');
  const closeBtn = document.getElementById('lc-close');
  const darkToggle = document.getElementById('lc-dark-toggle');
  const statusEl = document.getElementById('lc-status');
  const badgeEl = document.getElementById('lc-badge');
  const typingEl = document.getElementById('lc-typing');
  const attachBtn = document.getElementById('lc-attach-btn');
  const fileInputEl = document.getElementById('lc-attach-file');
  const attachPreviewEl = document.getElementById('lc-attach-preview');

  // Apply default position immediately (avoids a layout flash before the server responds).
  // Priority: data-position override on the <script> tag > company setting from the server.
  function applyPosition(position) {
    const pos = VALID_POSITIONS.includes(position) ? position : 'bottom-right';
    ['lc-pos-bottom-right', 'lc-pos-bottom-left', 'lc-pos-top-right', 'lc-pos-top-left'].forEach(cls => {
      fab.classList.remove(cls);
      windowEl.classList.remove(cls);
    });
    fab.classList.add('lc-pos-' + pos);
    windowEl.classList.add('lc-pos-' + pos);
  }
  applyPosition(POSITION_OVERRIDE || 'bottom-right');

  let unread = 0;
  let isOpen = false;
  let socket = null;
  let renderedIds = new Set();

  function openChat() {
    windowEl.classList.add('open');
    isOpen = true;
    unread = 0;
    badgeEl.style.display = 'none';
    setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; inputEl.focus(); }, 50);
  }
  function closeChat() {
    windowEl.classList.remove('open');
    isOpen = false;
  }
  fab.addEventListener('click', () => (isOpen ? closeChat() : openChat()));
  closeBtn.addEventListener('click', closeChat);
  darkToggle.addEventListener('click', () => {
    windowEl.classList.toggle('dark');
    darkToggle.textContent = windowEl.classList.contains('dark') ? '☀️' : '🌙';
  });

  function renderMessage(msg) {
    if (renderedIds.has(msg.id)) return;
    renderedIds.add(msg.id);
    if (msg.is_internal_note) return; // never show internal notes to visitors
    const row = document.createElement('div');
    const type = msg.sender_type === 'visitor' ? 'out' : (msg.sender_type === 'system' ? 'sys' : 'in');
    row.className = 'lc-row ' + type;
    const bubble = document.createElement('div');
    bubble.className = 'lc-bubble';
    if (msg.text) {
      const textEl = document.createElement('div');
      textEl.textContent = msg.text;
      bubble.appendChild(textEl);
    }
    if (msg.attachment_url) {
      const isImage = (msg.attachment_type || '').startsWith('image/');
      const absoluteUrl = msg.attachment_url.startsWith('http') ? msg.attachment_url : ORIGIN + msg.attachment_url;
      if (isImage) {
        const img = document.createElement('img');
        img.src = absoluteUrl;
        img.style.cssText = 'max-width:100%;border-radius:10px;margin-top:6px;display:block;cursor:pointer;';
        img.onclick = () => window.open(absoluteUrl, '_blank');
        bubble.appendChild(img);
      } else {
        const link = document.createElement('a');
        link.href = absoluteUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '📎 ' + (msg.attachment_name || 'Download attachment');
        link.style.cssText = 'display:block;margin-top:6px;font-size:12px;text-decoration:underline;color:inherit;';
        bubble.appendChild(link);
      }
    }
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (!isOpen && type !== 'out') {
      unread++;
      badgeEl.textContent = unread;
      badgeEl.style.display = 'flex';
    }
  }

  function renderQuickReplies(quickReplies) {
    const existing = document.querySelector('.lc-quick-replies');
    if (existing) existing.remove();
    if (!quickReplies || !quickReplies.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'lc-quick-replies';
    quickReplies.forEach(({ value, label }) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => sendMessage(value);
      wrap.appendChild(b);
    });
    messagesEl.parentElement.insertBefore(wrap, typingEl);
  }

  function sendMessage(overrideText) {
    const text = overrideText !== undefined ? overrideText : inputEl.value.trim();
    if ((!text && !pendingAttachment) || !socket) return;
    socket.emit('widget:message', { text, attachment: pendingAttachment });
    if (overrideText === undefined) inputEl.value = '';
    pendingAttachment = null;
    attachPreviewEl.innerHTML = '';
    renderQuickReplies(null);
  }
  sendBtn.addEventListener('click', () => sendMessage());
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
  inputEl.addEventListener('input', () => { if (socket) socket.emit('widget:typing'); });

  // ---------- Attachments ----------
  let pendingAttachment = null;
  attachBtn.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', async () => {
    const file = fileInputEl.files[0];
    if (!file) return;
    attachPreviewEl.textContent = 'Uploading ' + file.name + '…';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('widgetKey', WIDGET_KEY);
    try {
      const res = await fetch(ORIGIN + '/api/widget-upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      pendingAttachment = data;
      attachPreviewEl.innerHTML = `📎 ${data.name} ready <button id="lc-clear-attach" style="border:none;background:none;color:#ef4444;cursor:pointer;">✕</button>`;
      document.getElementById('lc-clear-attach').onclick = () => { pendingAttachment = null; attachPreviewEl.innerHTML = ''; fileInputEl.value = ''; };
    } catch (e) {
      attachPreviewEl.textContent = 'Upload failed: ' + e.message;
    }
  });

  // ---------- Lead capture form ----------
  const leadFormEl = document.getElementById('lc-lead-form');
  const chatUiEls = [messagesEl, typingEl, attachPreviewEl, document.getElementById('lc-inputbar')];

  function showChatUi(show) {
    leadFormEl.classList.toggle('hidden', show);
    chatUiEls.forEach(el => { if (el) el.style.display = show ? '' : 'none'; });
  }

  function renderLeadForm({ services, consentText, brandColor }) {
    showChatUi(false);
    const dropdownId = 'lc-lf-services-' + Math.random().toString(36).slice(2, 7);
    leadFormEl.innerHTML = `
      <h3>Let's get you connected</h3>
      <p class="lc-lf-sub">Just a few details before we start — someone from our team will be with you shortly.</p>
      <form id="lc-lead-form-el">
        <label>Full name *</label>
        <input type="text" id="lc-lf-name" required maxlength="80" />
        <label>Mobile number *</label>
        <input type="tel" id="lc-lf-mobile" required maxlength="20" />
        <label>Email *</label>
        <input type="email" id="lc-lf-email" required maxlength="120" />
        <label>You are interested in...</label>
        <div class="lc-lf-dropdown">
          <button type="button" class="lc-lf-dropdown-btn" id="${dropdownId}-btn">Select service(s) ▾</button>
          <div class="lc-lf-dropdown-panel" id="${dropdownId}-panel">
            ${services.map((s, i) => `
              <label><input type="checkbox" class="lc-lf-service-cb" value="${escapeAttr(s)}" /> ${escapeHtml(s)}</label>
            `).join('')}
          </div>
        </div>
        <label class="lc-lf-consent">
          <input type="checkbox" id="lc-lf-consent" required />
          <span>${escapeHtml(consentText || 'I agree to be contacted regarding my inquiry.')}</span>
        </label>
        <button type="submit" id="lc-lf-submit-btn">Start chat</button>
        <div class="lc-lf-error" id="lc-lf-error"></div>
      </form>
    `;

    const dropBtn = document.getElementById(dropdownId + '-btn');
    const dropPanel = document.getElementById(dropdownId + '-panel');
    dropBtn.addEventListener('click', () => dropPanel.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.lc-lf-dropdown')) dropPanel.classList.remove('open');
    });
    function updateDropdownLabel() {
      const checked = [...leadFormEl.querySelectorAll('.lc-lf-service-cb:checked')].map(cb => cb.value);
      dropBtn.textContent = (checked.length ? checked.join(', ') : 'Select service(s)') + ' ▾';
    }
    leadFormEl.querySelectorAll('.lc-lf-service-cb').forEach(cb => cb.addEventListener('change', updateDropdownLabel));

    document.getElementById('lc-lead-form-el').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('lc-lf-name').value.trim();
      const mobile = document.getElementById('lc-lf-mobile').value.trim();
      const emailVal = document.getElementById('lc-lf-email').value.trim();
      const consent = document.getElementById('lc-lf-consent').checked;
      const interestedServices = [...leadFormEl.querySelectorAll('.lc-lf-service-cb:checked')].map(cb => cb.value);
      const errEl = document.getElementById('lc-lf-error');

      if (!name || !mobile || !emailVal || !consent) {
        errEl.textContent = 'Please fill in all required fields and accept the consent checkbox.';
        return;
      }
      if (!/^\S+@\S+\.\S+$/.test(emailVal)) {
        errEl.textContent = 'Please enter a valid email address.';
        return;
      }
      errEl.textContent = '';
      document.getElementById('lc-lf-submit-btn').disabled = true;
      document.getElementById('lc-lf-submit-btn').textContent = 'Starting…';

      socket.emit('widget:lead_form_submit', {
        pageUrl: location.href, name, mobile, email: emailVal, interestedServices, consent,
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;');
  }

  // ---------- Connect ----------
  loadScript(ORIGIN + '/socket.io/socket.io.js').then(() => {
    socket = io(ORIGIN + '/widget', { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      const savedConvId = localStorage.getItem(STORAGE_KEY);
      socket.emit('widget:init', {
        widgetKey: WIDGET_KEY,
        pageUrl: location.href,
        conversationId: savedConvId || null,
      });
    });

    socket.on('widget:show_lead_form', (data) => {
      renderLeadForm(data);
    });

    socket.on('widget:ready', (data) => {
      showChatUi(true);
      if (data.company && data.company.brandColor) {
        document.documentElement.style.setProperty('--lc-brand', data.company.brandColor);
        root.style.setProperty('--lc-brand', data.company.brandColor);
      }
      // Manual data-position on the script tag always wins over the admin-configured setting.
      applyPosition(POSITION_OVERRIDE || (data.company && data.company.position) || 'bottom-right');
      if (data.company && data.company.iconType === 'image' && data.company.iconValue) {
        const imgSrc = data.company.iconValue.startsWith('http') ? data.company.iconValue : ORIGIN + data.company.iconValue;
        fabIcon.innerHTML = `<img src="${imgSrc}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" />`;
      } else if (data.company && data.company.iconValue) {
        fabIcon.textContent = data.company.iconValue;
      }
      localStorage.setItem(STORAGE_KEY, data.conversationId);
      statusEl.textContent = data.status === 'assigned' ? 'Connected with an agent' :
                              data.status === 'waiting' ? 'Waiting for an agent…' :
                              data.status === 'closed' ? 'Conversation closed' : 'Online';
      messagesEl.innerHTML = '';
      renderedIds = new Set();
      (data.messages || []).forEach(renderMessage);
      const last = (data.messages || [])[data.messages.length - 1];
      if (last && last.meta && last.meta.quickReplies) {
        renderQuickReplies(last.meta.quickReplies);
      }
    });

    socket.on('widget:new_message', (msg) => {
      renderMessage(msg);
      if (msg.meta && msg.meta.quickReplies) {
        renderQuickReplies(msg.meta.quickReplies);
      } else if (msg.sender_type !== 'bot' || !msg.meta) {
        renderQuickReplies(null);
      }
    });

    socket.on('widget:status', (data) => {
      statusEl.textContent = data.status === 'assigned'
        ? `Chatting with ${data.agentName || 'an agent'}`
        : data.status;
    });

    socket.on('widget:agent_typing', () => {
      typingEl.textContent = 'Agent is typing…';
      clearTimeout(window.__lcTypingTimeout);
      window.__lcTypingTimeout = setTimeout(() => (typingEl.textContent = ''), 2000);
    });

    socket.on('widget:error', (e) => {
      statusEl.textContent = 'Connection error';
      console.error('[LiveChat]', e.message);
      const lfError = document.getElementById('lc-lf-error');
      const lfSubmitBtn = document.getElementById('lc-lf-submit-btn');
      if (lfError && lfSubmitBtn) {
        lfError.textContent = e.message || 'Something went wrong. Please try again.';
        lfSubmitBtn.disabled = false;
        lfSubmitBtn.textContent = 'Start chat';
      }
    });

    socket.on('disconnect', () => { statusEl.textContent = 'Reconnecting…'; });
  }).catch(() => {
    console.error('[LiveChat] Failed to load socket.io client from', ORIGIN);
  });
})();
