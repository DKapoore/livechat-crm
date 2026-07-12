const { randomUUID } = require('crypto');
const db = require('../db');

function getQuestions(companyId) {
  return db.prepare(`SELECT * FROM bot_questions WHERE company_id = ? ORDER BY order_index ASC`).all(companyId);
}

function saveMessage(conversationId, senderType, text, senderName = null, senderId = null, meta = null, attachment = null) {
  const msg = {
    id: randomUUID(),
    conversation_id: conversationId,
    sender_type: senderType,
    sender_id: senderId,
    sender_name: senderName,
    text,
    meta: meta ? JSON.stringify(meta) : null,
    attachment_url: attachment ? attachment.url : null,
    attachment_name: attachment ? attachment.name : null,
    attachment_type: attachment ? attachment.type : null,
  };
  db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_name, text, meta, attachment_url, attachment_name, attachment_type)
              VALUES (@id, @conversation_id, @sender_type, @sender_id, @sender_name, @text, @meta, @attachment_url, @attachment_name, @attachment_type)`).run(msg);
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
  const saved = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msg.id);
  return { ...saved, meta: saved.meta ? JSON.parse(saved.meta) : null };
}

function questionMessageMeta(question) {
  if (question.type === 'choice' && question.choices) {
    const choices = JSON.parse(question.choices);
    return { quickReplies: choices.map(c => ({ value: c.value, label: c.label })) };
  }
  return null;
}

function askQuestion(conversationId, question) {
  return saveMessage(conversationId, 'bot', question.question_text, null, null, questionMessageMeta(question));
}

// Handles an incoming visitor message against the current question (conversation.bot_step = index into ordered questions)
function handleVisitorMessage(conversation, visitor, text) {
  const questions = getQuestions(conversation.company_id);
  const botMessages = [];
  const step = conversation.bot_step;
  const question = questions[step];

  if (!question) return botMessages; // no more questions configured; nothing to do

  // ---- Validate + store the answer ----
  let answerText = text.trim();
  if (question.type === 'choice') {
    const choices = JSON.parse(question.choices || '[]');
    const picked = choices.find(c => c.value === answerText || c.label.toLowerCase() === answerText.toLowerCase());
    if (!picked) {
      const retryMeta = questionMessageMeta(question);
      botMessages.push(saveMessage(conversation.id, 'bot', `Sorry, please pick one of the options below.\n\n${question.question_text}`, null, null, retryMeta));
      return botMessages;
    }
    answerText = picked.label;

    if (question.is_category_routing) {
      const dept = picked.department
        ? db.prepare(`SELECT * FROM departments WHERE company_id = ? AND name = ?`).get(conversation.company_id, picked.department)
        : null;
      db.prepare(`UPDATE conversations SET category = ?, department_id = ? WHERE id = ?`)
        .run(picked.label, dept ? dept.id : null, conversation.id);
    }
  } else {
    // text question — allow "skip" for non-required questions
    if (!question.required && answerText.toLowerCase() === 'skip') answerText = null;
    else if (question.required && !answerText) {
      botMessages.push(saveMessage(conversation.id, 'bot', `This one's required — ${question.question_text}`));
      return botMessages;
    }
  }

  // Store into visitor fixed fields for name/contact, else into conversation_answers
  if (question.field_key === 'name' && answerText) {
    db.prepare(`UPDATE visitors SET name = ? WHERE id = ?`).run(answerText.slice(0, 80), visitor.id);
  } else if (question.field_key === 'contact') {
    db.prepare(`UPDATE visitors SET contact = ? WHERE id = ?`).run(answerText ? answerText.slice(0, 120) : null, visitor.id);
  } else {
    db.prepare(`INSERT INTO conversation_answers (id, conversation_id, question_id, field_key, question_text, answer_text)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), conversation.id, question.id, question.field_key, question.question_text, answerText);
  }

  // ---- Advance to next question, or finish the bot flow ----
  const nextStep = step + 1;
  const nextQuestion = questions[nextStep];

  if (nextQuestion) {
    db.prepare(`UPDATE conversations SET bot_step = ? WHERE id = ?`).run(nextStep, conversation.id);
    const lead = question.field_key === 'name' && answerText
      ? `Nice to meet you, ${answerText}! `
      : '';
    if (lead) {
      const meta = questionMessageMeta(nextQuestion);
      botMessages.push(saveMessage(conversation.id, 'bot', lead + nextQuestion.question_text, null, null, meta));
    } else {
      botMessages.push(askQuestion(conversation.id, nextQuestion));
    }
  } else {
    db.prepare(`UPDATE conversations SET bot_step = ?, status = 'waiting' WHERE id = ?`).run(nextStep, conversation.id);
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversation.id);
    const closing = conv.category
      ? `Thanks! I've categorized this as "${conv.category}" and I'm connecting you with the best available agent. Please hold on. 🙏`
      : `Thanks! I'm connecting you with the best available agent. Please hold on. 🙏`;
    botMessages.push(saveMessage(conversation.id, 'bot', closing));
  }

  return botMessages;
}

function generateShortCode(companyId) {
  // Short, human-typeable code used for referencing a conversation (e.g. replying via Telegram).
  // Retries on the rare collision within the same company.
  for (let i = 0; i < 5; i++) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const exists = db.prepare(`SELECT 1 FROM conversations WHERE company_id = ? AND short_code = ?`).get(companyId, code);
    if (!exists) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function startConversation(companyId, pageUrl, widgetId = null) {
  const visitorId = randomUUID();
  db.prepare(`INSERT INTO visitors (id, company_id, page_url) VALUES (?, ?, ?)`)
    .run(visitorId, companyId, pageUrl || null);

  const conversationId = randomUUID();
  const shortCode = generateShortCode(companyId);
  db.prepare(`INSERT INTO conversations (id, company_id, widget_id, short_code, visitor_id, status, bot_step)
              VALUES (?, ?, ?, ?, ?, 'bot', 0)`)
    .run(conversationId, companyId, widgetId, shortCode, visitorId);

  const widget = widgetId ? db.prepare(`SELECT * FROM widgets WHERE id = ?`).get(widgetId) : null;
  const welcomeText = widget ? widget.welcome_message : 'Welcome! 👋';
  const welcome = saveMessage(conversationId, 'bot', welcomeText);

  const questions = getQuestions(companyId);
  const messages = [welcome];
  if (questions[0]) {
    messages.push(askQuestion(conversationId, questions[0]));
  } else {
    db.prepare(`UPDATE conversations SET status = 'waiting' WHERE id = ?`).run(conversationId);
    messages.push(saveMessage(conversationId, 'bot', "I'm connecting you with the best available agent. Please hold on. 🙏"));
  }

  return {
    visitor: db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(visitorId),
    conversation: db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId),
    messages,
  };
}

function autoAssign(conversation) {
  let agent = null;
  if (conversation.department_id) {
    agent = db.prepare(`
      SELECT * FROM agents WHERE company_id = ? AND department_id = ? AND status = 'online'
      AND active_chats < max_chats ORDER BY active_chats ASC LIMIT 1
    `).get(conversation.company_id, conversation.department_id);
  }
  if (!agent) {
    agent = db.prepare(`
      SELECT * FROM agents WHERE company_id = ? AND status = 'online'
      AND active_chats < max_chats ORDER BY active_chats ASC LIMIT 1
    `).get(conversation.company_id);
  }
  if (!agent) return null;

  db.prepare(`UPDATE conversations SET agent_id = ?, status = 'assigned' WHERE id = ?`)
    .run(agent.id, conversation.id);
  db.prepare(`UPDATE agents SET active_chats = active_chats + 1 WHERE id = ?`).run(agent.id);

  const sysMsg = saveMessage(conversation.id, 'system', `${agent.name} has joined the chat.`);
  return { agent, sysMsg };
}

module.exports = { handleVisitorMessage, startConversation, autoAssign, saveMessage, getQuestions };
