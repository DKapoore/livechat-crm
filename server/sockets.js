const db = require('./db');
const { verifyToken } = require('./auth');
const { handleVisitorMessage, startConversation, startConversationFromLead, autoAssign, saveMessage } = require('./bot/flow');
const { notifyCompanyAgents, notifyAgent } = require('./push');
const telegram = require('./telegram');
const email = require('./email');
const sheets = require('./sheets');

function conversationRoom(id) {
  return `conv:${id}`;
}
function companyRoom(id) {
  return `company:${id}`;
}

// The widget connects directly from the visitor's browser to OUR server's socket.io endpoint,
// so the handshake host/proto reflect our own server — unlike the widget's embedding page,
// which could be any third-party site. This gives us a reliable absolute base URL for building
// links (e.g. attachment URLs, email "open in dashboard" links) that we forward elsewhere.
function getOriginFromSocket(socket) {
  const headers = socket.handshake.headers || {};
  const proto = headers['x-forwarded-proto'] || (socket.handshake.secure ? 'https' : 'http');
  const host = headers['x-forwarded-host'] || headers.host || 'localhost';
  return `${proto}://${host}`;
}

function serializeConversation(convId) {
  return db.prepare(`
    SELECT c.*, v.name as visitor_name, v.contact as visitor_contact,
           a.name as agent_name, d.name as department_name
    FROM conversations c
    JOIN visitors v ON v.id = c.visitor_id
    LEFT JOIN agents a ON a.id = c.agent_id
    LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.id = ?`).get(convId);
}

function buildWidgetConfig(company, widget) {
  return {
    name: company.name,
    brandColor: widget.brand_color,
    position: widget.widget_position || 'bottom-right',
    iconType: widget.icon_type || 'emoji',
    iconValue: widget.icon_value || '💬',
    iconDisplayMode: widget.icon_display_mode || 'icon',
    buttonAnimation: widget.button_animation || 'none',
    buttonLabelEnabled: !!widget.button_label_enabled,
    buttonLabelText: widget.button_label_text || '',
    buttonOutlineColor: widget.button_outline_color || '',
    buttonOutlineWidth: widget.button_outline_width || 0,
    buttonSize: widget.button_size || 60,
  };
}

function setupSockets(io) {
  const widgetNsp = io.of('/widget');
  const agentNsp = io.of('/agent');

  // Shared by both "bot flow finished naturally" and "lead form skipped straight to queue" —
  // handles putting a conversation in front of agents and attempting auto-assign.
  function enterQueue(conversation, visitor, origin) {
    io.of('/agent').to(companyRoom(conversation.company_id)).emit('queue:new', serializeConversation(conversation.id));
    notifyCompanyAgents(conversation.company_id, {
      title: 'New chat waiting',
      body: `${visitor.name || 'A visitor'} needs help${conversation.category ? ' — ' + conversation.category : ''}`,
      url: '/admin/#inbox',
    });
    const assignResult = autoAssign(conversation);
    if (assignResult) {
      widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', assignResult.sysMsg);
      widgetNsp.to(conversationRoom(conversation.id)).emit('widget:status', { status: 'assigned', agentName: assignResult.agent.name });
      io.of('/agent').to(companyRoom(conversation.company_id)).emit('queue:updated', serializeConversation(conversation.id));
      notifyAgent(assignResult.agent.id, {
        title: 'Chat assigned to you',
        body: `${visitor.name || 'A visitor'} — ${conversation.category || 'General inquiry'}`,
        url: '/admin/#assigned',
      });
      const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(conversation.company_id);
      const freshConv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversation.id);
      telegram.notifyAgentAssigned(company, assignResult.agent, freshConv, visitor);
      email.notifyAgentAssigned(conversation.company_id, { agent: assignResult.agent, visitor, conversation: freshConv, origin });
    }
  }

  // ---------------- Widget namespace (visitor-facing) ----------------
  widgetNsp.on('connection', (socket) => {
    let currentConversationId = null;
    let currentCompanyId = null;
    let pendingWidget = null; // set while waiting on a lead form submission

    socket.on('widget:init', ({ widgetKey, pageUrl, conversationId }) => {
      // Each embedded <script data-company="KEY"> maps to a row in `widgets`, not directly
      // to a company — this is what lets one business run several differently-branded
      // widgets across different websites.
      const widget = db.prepare(`SELECT * FROM widgets WHERE widget_key = ?`).get(widgetKey);
      if (!widget) {
        socket.emit('widget:error', { message: 'Invalid widget key' });
        return;
      }
      const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(widget.company_id);
      currentCompanyId = company.id;

      // Try to resume an existing open conversation — the lead form (if any) is always skipped
      // on resume, since we already have the visitor's info from the first time.
      let conversation = null;
      if (conversationId) {
        conversation = db.prepare(`SELECT * FROM conversations WHERE id = ? AND company_id = ? AND status != 'closed'`)
          .get(conversationId, company.id);
      }

      if (conversation) {
        const visitor = db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(conversation.visitor_id);
        const messages = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND is_internal_note = 0 ORDER BY created_at ASC`).all(conversation.id)
          .map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
        currentConversationId = conversation.id;
        socket.join(conversationRoom(conversation.id));
        socket.emit('widget:ready', {
          company: buildWidgetConfig(company, widget),
          conversationId: conversation.id, visitor, messages, status: conversation.status,
        });
        return;
      }

      // No resumable conversation — if this widget requires the lead capture form first,
      // ask for it and wait; otherwise start the normal bot-question flow immediately.
      if (widget.lead_form_enabled) {
        pendingWidget = widget;
        socket.emit('widget:show_lead_form', {
          services: JSON.parse(widget.lead_form_services || '[]'),
          consentText: widget.lead_form_consent_text,
          brandColor: widget.brand_color,
        });
        return;
      }

      const started = startConversation(company.id, pageUrl, widget.id);
      currentConversationId = started.conversation.id;
      socket.join(conversationRoom(started.conversation.id));
      socket.emit('widget:ready', {
        company: buildWidgetConfig(company, widget),
        conversationId: started.conversation.id, visitor: started.visitor, messages: started.messages, status: started.conversation.status,
      });
    });

    socket.on('widget:lead_form_submit', ({ pageUrl, name, mobile, email: visitorEmail, interestedServices, consent }) => {
      const widget = pendingWidget;
      if (!widget) return; // lead form wasn't requested for this session — ignore stray submits
      if (!name || !name.trim() || !mobile || !mobile.trim() || !visitorEmail || !visitorEmail.trim() || !consent) {
        socket.emit('widget:error', { message: 'Name, mobile, email, and consent are required.' });
        return;
      }

      const started = startConversationFromLead(widget.company_id, pageUrl, widget.id, {
        name: name.trim(), mobile: mobile.trim(), email: visitorEmail.trim(),
        interestedServices: Array.isArray(interestedServices) ? interestedServices : [],
        consent: !!consent,
      });
      pendingWidget = null;
      currentConversationId = started.conversation.id;
      currentCompanyId = widget.company_id;
      socket.join(conversationRoom(started.conversation.id));

      const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(widget.company_id);
      socket.emit('widget:ready', {
        company: buildWidgetConfig(company, widget),
        conversationId: started.conversation.id, visitor: started.visitor, messages: started.messages, status: started.conversation.status,
      });

      // The lead is captured regardless of whether more bot questions follow — notify now.
      const origin = getOriginFromSocket(socket);
      email.notifyNewLead(widget.company_id, { visitor: started.visitor, conversation: started.conversation, widget, origin });
      sheets.pushLead(widget.company_id, started.visitor, started.conversation, widget);

      if (started.conversation.status === 'waiting') {
        enterQueue(started.conversation, started.visitor, origin);
      }
    });

    socket.on('widget:message', ({ text, attachment }) => {
      if (!currentConversationId || (!text || !text.trim()) && !attachment) return;
      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(currentConversationId);
      if (!conversation || conversation.status === 'closed') return;
      const visitor = db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(conversation.visitor_id);

      const visitorMsg = saveMessage(conversation.id, 'visitor', text || '', visitor.name, null, null, attachment || null);
      widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', visitorMsg);
      io.of('/agent').to(companyRoom(conversation.company_id)).emit('agent:new_message', { conversationId: conversation.id, message: visitorMsg });

      if (conversation.status === 'assigned' && conversation.agent_id) {
        const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(conversation.company_id);
        const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(conversation.agent_id);
        if (company && agent) telegram.forwardVisitorMessage(company, agent, conversation, visitorMsg, getOriginFromSocket(socket));
      }

      if (conversation.status === 'bot' && text && text.trim()) {
        const botMsgs = handleVisitorMessage(conversation, visitor, text);
        for (const m of botMsgs) {
          widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', m);
        }
        const updatedConv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversation.id);
        if (updatedConv.status === 'waiting') {
          enterQueue(updatedConv, visitor, getOriginFromSocket(socket));
        }
      }
    });

    socket.on('widget:typing', () => {
      if (!currentConversationId) return;
      io.of('/agent').to(companyRoom(currentCompanyId)).emit('agent:visitor_typing', { conversationId: currentConversationId });
    });

    socket.on('disconnect', () => {});
  });

  // ---------------- Agent namespace (admin dashboard) ----------------
  agentNsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error('unauthorized'));
    socket.auth = payload;
    next();
  });

  agentNsp.on('connection', (socket) => {
    socket.join(companyRoom(socket.auth.companyId));
    socket.join(`agent:${socket.auth.agentId}`);

    socket.on('agent:join_conversation', ({ conversationId }) => {
      socket.join(conversationRoom(conversationId));
    });

    socket.on('agent:leave_conversation', ({ conversationId }) => {
      socket.leave(conversationRoom(conversationId));
    });

    socket.on('agent:message', ({ conversationId, text, isInternalNote, attachment }) => {
      if ((!text || !text.trim()) && !attachment) return;
      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ? AND company_id = ?`)
        .get(conversationId, socket.auth.companyId);
      if (!conversation) return;
      const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(socket.auth.agentId);

      const msg = saveMessage(conversationId, 'agent', text || '', agent.name, agent.id, null, attachment || null);
      if (isInternalNote) {
        db.prepare(`UPDATE messages SET is_internal_note = 1 WHERE id = ?`).run(msg.id);
        msg.is_internal_note = 1;
        agentNsp.to(companyRoom(socket.auth.companyId)).emit('agent:new_message', { conversationId, message: msg });
      } else {
        agentNsp.to(companyRoom(socket.auth.companyId)).emit('agent:new_message', { conversationId, message: msg });
        io.of('/widget').to(conversationRoom(conversationId)).emit('widget:new_message', msg);
      }
    });

    socket.on('agent:typing', ({ conversationId }) => {
      io.of('/widget').to(conversationRoom(conversationId)).emit('widget:agent_typing', {});
    });

    socket.on('agent:status', ({ status }) => {
      if (!['online', 'offline', 'away'].includes(status)) return;
      db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(status, socket.auth.agentId);
      agentNsp.to(companyRoom(socket.auth.companyId)).emit('agent:status_changed', { agentId: socket.auth.agentId, status });
    });

    socket.on('disconnect', () => {});
  });
}

module.exports = { setupSockets };
