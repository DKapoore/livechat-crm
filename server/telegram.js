const db = require('./db');
const { randomUUID } = require('crypto');

const TG_API = 'https://api.telegram.org';

// ---- Outgoing: send a message to an agent's linked Telegram chat ----
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    let data;
    try { data = await res.json(); } catch { console.error('[telegram] sendMessage: non-JSON response'); return false; }
    if (!data.ok) console.error('[telegram] sendMessage failed:', data.description);
    return data.ok;
  } catch (err) {
    console.error('[telegram] sendMessage error:', err.message);
    return false;
  }
}

// ---- Outgoing: send a photo to an agent's Telegram (Telegram fetches it from our public URL) ----
async function sendTelegramPhoto(botToken, chatId, photoUrl, caption) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' }),
    });
    let data;
    try { data = await res.json(); } catch { return false; }
    if (!data.ok) console.error('[telegram] sendPhoto failed:', data.description);
    return data.ok;
  } catch (err) {
    console.error('[telegram] sendPhoto error:', err.message);
    return false;
  }
}

// ---- Outgoing: send a non-image file to an agent's Telegram ----
async function sendTelegramDocument(botToken, chatId, documentUrl, caption) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, document: documentUrl, caption, parse_mode: 'HTML' }),
    });
    let data;
    try { data = await res.json(); } catch { return false; }
    if (!data.ok) console.error('[telegram] sendDocument failed:', data.description);
    return data.ok;
  } catch (err) {
    console.error('[telegram] sendDocument error:', err.message);
    return false;
  }
}

// ---- Validate a bot token and fetch its username (used when admin saves the token) ----
async function validateBotToken(botToken) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/getMe`);
    let data;
    try {
      data = await res.json();
    } catch {
      return { valid: false, error: 'Could not reach Telegram (unexpected response). Check your server has internet access to api.telegram.org.' };
    }
    if (!data.ok) return { valid: false, error: data.description || 'Invalid token' };
    return { valid: true, username: data.result.username };
  } catch (err) {
    return { valid: false, error: `Could not reach Telegram: ${err.message}` };
  }
}

// ---- Check what webhook URL is currently registered with Telegram (for diagnostics) ----
async function getWebhookInfo(botToken) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/getWebhookInfo`);
    let data;
    try { data = await res.json(); } catch { return null; }
    if (!data.ok) return null;
    return data.result; // { url, last_error_message, pending_update_count, ... }
  } catch {
    return null;
  }
}

// ---- Register the webhook URL with Telegram so it pushes updates to our server ----
async function setWebhook(botToken, webhookUrl) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    let data;
    try { data = await res.json(); } catch { return { ok: false, description: 'Unexpected response from Telegram' }; }
    return { ok: data.ok, description: data.description };
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

// ---- Notify an agent (if Telegram-linked) that a chat was assigned to them ----
async function notifyAgentAssigned(company, agent, conversation, visitor) {
  if (!company.telegram_bot_token || !agent.telegram_chat_id) return;
  const text =
    `🟢 <b>New chat assigned to you</b>\n` +
    `Visitor: ${escapeHtml(visitor.name || 'Anonymous')}\n` +
    `Topic: ${escapeHtml(conversation.category || 'General')}\n\n` +
    `Reply using this code so we know which chat it's for:\n` +
    `<code>#${conversation.short_code} your message here</code>`;
  await sendTelegramMessage(company.telegram_bot_token, agent.telegram_chat_id, text);
}

// ---- Forward a new visitor message to the assigned agent's Telegram ----
// `origin` is the CRM server's own public base URL (e.g. https://yourapp.onrender.com) —
// needed to turn a stored relative path like "/uploads/xxx.png" into a URL Telegram can fetch.
async function forwardVisitorMessage(company, agent, conversation, visitorMsg, origin) {
  if (!company.telegram_bot_token || !agent.telegram_chat_id) return;

  if (visitorMsg.attachment_url) {
    const absoluteUrl = visitorMsg.attachment_url.startsWith('http') ? visitorMsg.attachment_url : (origin || '') + visitorMsg.attachment_url;
    const caption = `<b>#${conversation.short_code}</b> — visitor sent an attachment${visitorMsg.text ? ':\n' + escapeHtml(visitorMsg.text) : ''}`;
    const isImage = (visitorMsg.attachment_type || '').startsWith('image/');
    const sent = isImage
      ? await sendTelegramPhoto(company.telegram_bot_token, agent.telegram_chat_id, absoluteUrl, caption)
      : await sendTelegramDocument(company.telegram_bot_token, agent.telegram_chat_id, absoluteUrl, caption);
    if (sent) return;
    // Fall through to a text-only notice if Telegram couldn't fetch/send the file for any reason
    await sendTelegramMessage(company.telegram_bot_token, agent.telegram_chat_id,
      `💬 <b>#${conversation.short_code}</b> — visitor sent an attachment (couldn't preview it here): ${absoluteUrl}`);
    return;
  }

  const text = `💬 <b>#${conversation.short_code}</b> — visitor says:\n${escapeHtml(visitorMsg.text || '')}`;
  await sendTelegramMessage(company.telegram_bot_token, agent.telegram_chat_id, text);
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---- Generate a one-time linking code for an agent to send to the bot as /start <code> ----
function generateLinkCode(agentId) {
  const code = randomUUID().slice(0, 8).toUpperCase();
  db.prepare(`UPDATE agents SET telegram_link_code = ? WHERE id = ?`).run(code, agentId);
  return code;
}

// ---- Handle an incoming Telegram webhook update for a given company ----
// This is the core of the "agent replies from Telegram" feature: it parses the agent's
// message, matches it to a conversation by short_code, and posts it back into the system
// via the same saveMessage()+socket-emit path a normal in-app reply would use — which is
// exactly why it shows up live in the admin dashboard automatically.
async function handleWebhookUpdate(companyId, update, io) {
  const { saveMessage } = require('./bot/flow');
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = String(message.chat.id);
  const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(companyId);
  if (!company || !company.telegram_bot_token) return;

  // --- Linking flow: "/start <code>" ---
  const startMatch = message.text.match(/^\/start\s+(\S+)/);
  if (startMatch) {
    const code = startMatch[1].toUpperCase();
    const agent = db.prepare(`SELECT * FROM agents WHERE company_id = ? AND telegram_link_code = ?`).get(companyId, code);
    if (agent) {
      db.prepare(`UPDATE agents SET telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?`).run(chatId, agent.id);
      await sendTelegramMessage(company.telegram_bot_token, chatId,
        `✅ Linked! You'll now get chat notifications here for <b>${escapeHtml(company.name)}</b>.\n\nWhen a chat is assigned to you, reply with:\n<code>#CODE your message</code>`);
    } else {
      await sendTelegramMessage(company.telegram_bot_token, chatId, '❌ That link code is invalid or expired. Generate a new one from My Account in the admin dashboard.');
    }
    return;
  }

  // --- Reply flow: agent must already be linked ---
  const agent = db.prepare(`SELECT * FROM agents WHERE company_id = ? AND telegram_chat_id = ?`).get(companyId, chatId);
  if (!agent) {
    await sendTelegramMessage(company.telegram_bot_token, chatId, "You're not linked to an agent account yet. Get your link code from My Account in the admin dashboard, then send /start <code> here.");
    return;
  }

  const codeMatch = message.text.match(/^#?([A-Za-z0-9]{6})\s+([\s\S]+)/);
  let conversation = null;
  let replyText = message.text;

  if (codeMatch) {
    const [, shortCode, rest] = codeMatch;
    conversation = db.prepare(`SELECT * FROM conversations WHERE company_id = ? AND short_code = ? AND agent_id = ?`)
      .get(companyId, shortCode.toUpperCase(), agent.id);
    if (conversation) replyText = rest;
  }

  // Convenience: no code given but agent has exactly one active assigned chat
  if (!conversation) {
    const active = db.prepare(`SELECT * FROM conversations WHERE company_id = ? AND agent_id = ? AND status != 'closed'`).all(companyId, agent.id);
    if (active.length === 1 && !codeMatch) {
      conversation = active[0];
    }
  }

  if (!conversation) {
    await sendTelegramMessage(company.telegram_bot_token, chatId,
      "Couldn't match that to a chat. Prefix your reply with the code, e.g.:\n<code>#AB12CD Thanks for reaching out!</code>");
    return;
  }

  const msg = saveMessage(conversation.id, 'agent', replyText, agent.name, agent.id);

  // Push into the same real-time pipeline as an in-app agent reply, so it shows in the
  // admin dashboard immediately and reaches the visitor's widget live.
  if (io) {
    io.of('/agent').to(`company:${companyId}`).emit('agent:new_message', { conversationId: conversation.id, message: msg });
    io.of('/widget').to(`conv:${conversation.id}`).emit('widget:new_message', msg);
  }

  await sendTelegramMessage(company.telegram_bot_token, chatId, `✓ Sent to #${conversation.short_code}`);
}

module.exports = {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramDocument,
  validateBotToken,
  setWebhook,
  getWebhookInfo,
  notifyAgentAssigned,
  forwardVisitorMessage,
  generateLinkCode,
  handleWebhookUpdate,
};
