const db = require('./db');
const { verifyToken } = require('./auth');
const { handleVisitorMessage, startConversation, autoAssign, saveMessage } = require('./bot/flow');
const { notifyCompanyAgents, notifyAgent } = require('./push');
const telegram = require('./telegram');

function conversationRoom(id) {
  return `conv:${id}`;
}
function companyRoom(id) {
  return `company:${id}`;
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

function setupSockets(io) {
  // ---------------- Widget namespace (visitor-facing) ----------------
  const widgetNsp = io.of('/widget');

  widgetNsp.on('connection', (socket) => {
    let currentConversationId = null;
    let currentCompanyId = null;

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

      let conversation, visitor, messages;

      // Try to resume an existing open conversation
      if (conversationId) {
        conversation = db.prepare(`SELECT * FROM conversations WHERE id = ? AND company_id = ? AND status != 'closed'`)
          .get(conversationId, company.id);
      }

      if (conversation) {
        visitor = db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(conversation.visitor_id);
        messages = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND is_internal_note = 0 ORDER BY created_at ASC`).all(conversation.id)
          .map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
      } else {
        const started = startConversation(company.id, pageUrl, widget.id);
        conversation = started.conversation;
        visitor = started.visitor;
        messages = started.messages;
      }

      currentConversationId = conversation.id;
      socket.join(conversationRoom(conversation.id));

      socket.emit('widget:ready', {
        company: {
          name: company.name,
          brandColor: widget.brand_color,
          position: widget.widget_position || 'bottom-right',
          iconType: widget.icon_type || 'emoji',
          iconValue: widget.icon_value || '💬',
        },
        conversationId: conversation.id,
        visitor,
        messages,
        status: conversation.status,
      });
    });

    socket.on('widget:message', ({ text, attachment }) => {
      if (!currentConversationId || (!text || !text.trim()) && !attachment) return;
      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(currentConversationId);
      if (!conversation || conversation.status === 'closed') return;
      const visitor = db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(conversation.visitor_id);

      // Always store the visitor's raw message (attachment-only messages get a placeholder text)
      const visitorMsg = saveMessage(conversation.id, 'visitor', text || '', visitor.name, null, null, attachment || null);
      widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', visitorMsg);
      io.of('/agent').to(companyRoom(conversation.company_id)).emit('agent:new_message', { conversationId: conversation.id, message: visitorMsg });

      // If this chat is already assigned and the agent has Telegram linked, forward the
      // visitor's message there too so they can keep chatting without opening the dashboard.
      if (conversation.status === 'assigned' && conversation.agent_id) {
        const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(conversation.company_id);
        const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(conversation.agent_id);
        if (company && agent) telegram.forwardVisitorMessage(company, agent, conversation, visitorMsg);
      }

      if (conversation.status === 'bot' && text && text.trim()) {
        const botMsgs = handleVisitorMessage(conversation, visitor, text);
        for (const m of botMsgs) {
          widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', m);
        }
        const updatedConv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversation.id);
        if (updatedConv.status === 'waiting') {
          io.of('/agent').to(companyRoom(conversation.company_id)).emit('queue:new', serializeConversation(conversation.id));
          notifyCompanyAgents(conversation.company_id, {
            title: 'New chat waiting',
            body: `${visitor.name || 'A visitor'} needs help${updatedConv.category ? ' — ' + updatedConv.category : ''}`,
            url: '/admin/#inbox',
          });
          const assignResult = autoAssign(updatedConv);
          if (assignResult) {
            widgetNsp.to(conversationRoom(conversation.id)).emit('widget:new_message', assignResult.sysMsg);
            widgetNsp.to(conversationRoom(conversation.id)).emit('widget:status', { status: 'assigned', agentName: assignResult.agent.name });
            io.of('/agent').to(companyRoom(conversation.company_id)).emit('queue:updated', serializeConversation(conversation.id));
            notifyAgent(assignResult.agent.id, {
              title: 'Chat assigned to you',
              body: `${visitor.name || 'A visitor'} — ${updatedConv.category || 'General inquiry'}`,
              url: '/admin/#assigned',
            });
            const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(conversation.company_id);
            const freshConv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversation.id);
            telegram.notifyAgentAssigned(company, assignResult.agent, freshConv, visitor);
          }
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
  const agentNsp = io.of('/agent');

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
