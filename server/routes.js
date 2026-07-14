const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const db = require('./db');
const { login, authMiddleware } = require('./auth');
const { getPublicKey, saveSubscription, removeSubscription } = require('./push');
const telegram = require('./telegram');
const email = require('./email');
const sheets = require('./sheets');

const router = express.Router();

module.exports = function createRouter(io) {

const ADMIN_ROLES = ['super_admin', 'manager'];
function isAdmin(req) {
  return ADMIN_ROLES.includes(req.auth.role);
}

// ---------- File uploads ----------
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, randomUUID() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap

function fileResponse(file) {
  return {
    url: '/uploads/' + file.filename,
    name: file.originalname,
    type: file.mimetype,
  };
}

// Admin/agent upload (authenticated)
router.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json(fileResponse(req.file));
});

// Visitor upload (public, but must supply a valid widget key)
router.post('/widget-upload', upload.single('file'), (req, res) => {
  const widget = db.prepare(`SELECT id FROM widgets WHERE widget_key = ?`).get(req.body.widgetKey);
  if (!widget) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Invalid widget key' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json(fileResponse(req.file));
});

// ---------- Telegram webhook (PUBLIC — Telegram calls this directly, no JWT available) ----------
// The companyId in the URL acts as this endpoint's shared secret; Telegram has no way to
// forge it without already knowing it, and it grants no access beyond "relay this bot's updates".
router.post('/telegram/webhook/:companyId', async (req, res) => {
  res.sendStatus(200); // ack immediately; Telegram retries aggressively on non-200/timeout
  try {
    await telegram.handleWebhookUpdate(req.params.companyId, req.body, io);
  } catch (err) {
    console.error('[telegram webhook] error:', err.message);
  }
});

// ---------- Auth ----------
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const result = login(email, password);
  if (!result) return res.status(401).json({ error: 'Invalid credentials' });
  res.json(result);
});

router.get('/auth/me', authMiddleware, (req, res) => {
  const agent = db.prepare(`SELECT id, company_id, name, email, role, department_id, status FROM agents WHERE id = ?`)
    .get(req.auth.agentId);
  res.json(agent);
});

router.patch('/auth/me', authMiddleware, (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body || {};
  const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.auth.agentId);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  if (newPassword) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, agent.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    db.prepare(`UPDATE agents SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(newPassword, 10), agent.id);
  }
  if (name) db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run(name, agent.id);
  if (email && email !== agent.email) {
    const exists = db.prepare(`SELECT id FROM agents WHERE email = ? AND id != ?`).get(email, agent.id);
    if (exists) return res.status(400).json({ error: 'Email already in use' });
    db.prepare(`UPDATE agents SET email = ? WHERE id = ?`).run(email, agent.id);
  }
  const updated = db.prepare(`SELECT id, name, email, role, status FROM agents WHERE id = ?`).get(agent.id);
  res.json(updated);
});

// All routes below require auth
router.use(authMiddleware);

// ---------- Dashboard summary ----------
router.get('/dashboard/summary', (req, res) => {
  const companyId = req.auth.companyId;
  const waiting = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE company_id=? AND status='waiting'`).get(companyId).c;
  const assigned = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE company_id=? AND status='assigned'`).get(companyId).c;
  const closedToday = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE company_id=? AND status='closed' AND date(updated_at)=date('now')`).get(companyId).c;
  const onlineAgents = db.prepare(`SELECT COUNT(*) c FROM agents WHERE company_id=? AND status='online'`).get(companyId).c;
  const totalAgents = db.prepare(`SELECT COUNT(*) c FROM agents WHERE company_id=?`).get(companyId).c;
  const totalVisitorsToday = db.prepare(`SELECT COUNT(*) c FROM visitors WHERE company_id=? AND date(first_seen)=date('now')`).get(companyId).c;
  res.json({ waiting, assigned, closedToday, onlineAgents, totalAgents, totalVisitorsToday });
});

// ---------- Conversations ----------
router.get('/conversations', (req, res) => {
  const { status } = req.query;
  const companyId = req.auth.companyId;
  let query = `
    SELECT c.*, v.name as visitor_name, v.contact as visitor_contact,
           a.name as agent_name, d.name as department_name
    FROM conversations c
    JOIN visitors v ON v.id = c.visitor_id
    LEFT JOIN agents a ON a.id = c.agent_id
    LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.company_id = ?`;
  const params = [companyId];
  if (status === 'active') {
    query += ` AND c.status != 'closed'`;
  } else if (status) {
    query += ` AND c.status = ?`;
    params.push(status);
  }
  query += ` ORDER BY c.updated_at DESC LIMIT 200`;
  res.json(db.prepare(query).all(...params));
});

router.get('/conversations/:id', (req, res) => {
  const conv = db.prepare(`
    SELECT c.*, v.name as visitor_name, v.contact as visitor_contact, v.page_url,
           a.name as agent_name, d.name as department_name
    FROM conversations c
    JOIN visitors v ON v.id = c.visitor_id
    LEFT JOIN agents a ON a.id = c.agent_id
    LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.id = ? AND c.company_id = ?
  `).get(req.params.id, req.auth.companyId);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`).all(req.params.id)
    .map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
  res.json({ ...conv, messages });
});

router.post('/conversations/:id/assign', (req, res) => {
  const { agentId } = req.body || {};
  const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const agent = db.prepare(`SELECT * FROM agents WHERE id=? AND company_id=?`).get(agentId, req.auth.companyId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (conv.agent_id && conv.agent_id !== agentId) {
    db.prepare(`UPDATE agents SET active_chats = MAX(active_chats - 1, 0) WHERE id = ?`).run(conv.agent_id);
  }
  db.prepare(`UPDATE conversations SET agent_id=?, status='assigned' WHERE id=?`).run(agentId, conv.id);
  db.prepare(`UPDATE agents SET active_chats = active_chats + 1 WHERE id = ?`).run(agentId);

  const company = db.prepare(`SELECT * FROM companies WHERE id=?`).get(req.auth.companyId);
  const visitor = db.prepare(`SELECT * FROM visitors WHERE id=?`).get(conv.visitor_id);
  const freshConv = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conv.id);
  telegram.notifyAgentAssigned(company, agent, freshConv, visitor);
  const origin = `${req.protocol}://${req.get('host')}`;
  email.notifyAgentAssigned(req.auth.companyId, { agent, visitor, conversation: freshConv, origin });

  res.json({ ok: true });
});

router.post('/conversations/:id/close', (req, res) => {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  if (conv.agent_id) {
    db.prepare(`UPDATE agents SET active_chats = MAX(active_chats - 1, 0) WHERE id = ?`).run(conv.agent_id);
  }
  db.prepare(`UPDATE conversations SET status='closed' WHERE id=?`).run(conv.id);
  res.json({ ok: true });
});

router.get('/conversations/:id/messages', (req, res) => {
  const conv = db.prepare(`SELECT id FROM conversations WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC`).all(req.params.id));
});

// ---------- Agents ----------
router.get('/agents', (req, res) => {
  res.json(db.prepare(`
    SELECT id, name, email, role, department_id, status, active_chats, max_chats
    FROM agents WHERE company_id = ? ORDER BY name`).all(req.auth.companyId));
});

router.post('/agents', (req, res) => {
  if (!['super_admin', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Forbidden' });
  const { name, email, password, role, department_id } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO agents (id, company_id, name, email, password_hash, role, department_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.auth.companyId, name, email, bcrypt.hashSync(password, 10), role || 'agent', department_id || null);
  } catch (e) {
    return res.status(400).json({ error: 'Email already exists' });
  }
  res.json({ id });
});

router.patch('/agents/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['online', 'offline', 'away'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // An agent may only change their own status; only admins/managers may change someone else's.
  if (req.params.id !== req.auth.agentId && !isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE agents SET status=? WHERE id=? AND company_id=?`).run(status, req.params.id, req.auth.companyId);
  res.json({ ok: true });
});

// ---------- Departments ----------
router.get('/departments', (req, res) => {
  res.json(db.prepare(`SELECT * FROM departments WHERE company_id=? ORDER BY name`).all(req.auth.companyId));
});

router.post('/departments', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = randomUUID();
  db.prepare(`INSERT INTO departments (id, company_id, name) VALUES (?, ?, ?)`).run(id, req.auth.companyId, name);
  res.json({ id });
});

// ---------- Visitors ----------
router.get('/visitors/export.csv', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const visitors = db.prepare(`SELECT * FROM visitors WHERE company_id=? ORDER BY first_seen DESC`).all(req.auth.companyId);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Name', 'Contact', 'Mobile', 'Email', 'Interested In', 'Consent', 'Page URL', 'First Seen', 'Last Seen'];
  const rows = visitors.map(v => [
    v.name, v.contact, v.mobile, v.email,
    v.interested_services ? JSON.parse(v.interested_services).join('; ') : '',
    v.consent_given ? 'Yes' : 'No',
    v.page_url, v.first_seen, v.last_seen,
  ].map(escape).join(','));
  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="visitors-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

router.get('/visitors', (req, res) => {
  res.json(db.prepare(`SELECT * FROM visitors WHERE company_id=? ORDER BY last_seen DESC LIMIT 200`).all(req.auth.companyId));
});

// ---------- Widgets (multiple embeddable widgets per company) ----------
const VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

router.get('/widgets', (req, res) => {
  res.json(db.prepare(`SELECT * FROM widgets WHERE company_id=? ORDER BY created_at ASC`).all(req.auth.companyId));
});

router.get('/widgets/:id', (req, res) => {
  const widget = db.prepare(`SELECT * FROM widgets WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!widget) return res.status(404).json({ error: 'Not found' });
  res.json(widget);
});

router.post('/widgets', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = randomUUID();
  const widgetKey = 'w-' + randomUUID().slice(0, 10);
  db.prepare(`INSERT INTO widgets (id, company_id, name, widget_key) VALUES (?, ?, ?, ?)`)
    .run(id, req.auth.companyId, name.trim(), widgetKey);
  res.json(db.prepare(`SELECT * FROM widgets WHERE id=?`).get(id));
});

router.patch('/widgets/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const widget = db.prepare(`SELECT * FROM widgets WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!widget) return res.status(404).json({ error: 'Not found' });
  const { name, brand_color, welcome_message, widget_position, icon_type, icon_value, lead_form_enabled, lead_form_services, lead_form_consent_text } = req.body || {};
  const position = widget_position && VALID_POSITIONS.includes(widget_position) ? widget_position : widget.widget_position;
  const iconType = icon_type === 'image' ? 'image' : (icon_type === 'emoji' ? 'emoji' : widget.icon_type);
  db.prepare(`
    UPDATE widgets SET name=?, brand_color=?, welcome_message=?, widget_position=?, icon_type=?, icon_value=?,
      lead_form_enabled=?, lead_form_services=?, lead_form_consent_text=? WHERE id=?
  `).run(
      name?.trim() || widget.name,
      brand_color ?? widget.brand_color,
      welcome_message ?? widget.welcome_message,
      position,
      iconType,
      icon_value ?? widget.icon_value,
      lead_form_enabled !== undefined ? (lead_form_enabled ? 1 : 0) : widget.lead_form_enabled,
      lead_form_services ?? widget.lead_form_services,
      lead_form_consent_text ?? widget.lead_form_consent_text,
      widget.id
    );
  res.json(db.prepare(`SELECT * FROM widgets WHERE id=?`).get(widget.id));
});

router.delete('/widgets/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const count = db.prepare(`SELECT COUNT(*) c FROM widgets WHERE company_id=?`).get(req.auth.companyId).c;
  if (count <= 1) return res.status(400).json({ error: "Can't delete your only widget — create another one first." });
  try {
    db.prepare(`DELETE FROM widgets WHERE id=? AND company_id=?`).run(req.params.id, req.auth.companyId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[widgets] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete this widget. Please try again.' });
  }
});

// ---------- Per-widget embed code ZIP export ----------
router.get('/widgets/:id/export-zip', (req, res) => {
  const widget = db.prepare(`SELECT * FROM widgets WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!widget) return res.status(404).json({ error: 'Not found' });
  const origin = `${req.protocol}://${req.get('host')}`;
  const embedCode = `<script src="${origin}/widget.js" data-company="${widget.widget_key}"></script>`;

  const positionLabels = {
    'bottom-right': 'Bottom Right (default)',
    'bottom-left': 'Bottom Left',
    'top-right': 'Top Right',
    'top-left': 'Top Left',
  };

  const embedTxt = `LIVE CHAT WIDGET — EMBED CODE (${widget.name})
==============================

Paste this single line into your website's HTML, right before the closing </body> tag:

${embedCode}

Current widget settings (set from Admin → Widget Customizer):
  Widget name  : ${widget.name}
  Position     : ${positionLabels[widget.widget_position] || widget.widget_position}
  Brand color  : ${widget.brand_color}
  Icon type    : ${widget.icon_type}
  Widget key   : ${widget.widget_key}

That's it — no other setup needed. This widget connects back to your Live Chat CRM
backend automatically and remembers each visitor's conversation across page refreshes.

Note: if you run several widgets (e.g. one per website), each has its OWN embed code —
make sure you paste the right one on the right site. See them all under Admin → Widget Customizer.
`;

  const readmeMd = `# Chat Widget — Install Guide (Hinglish)

## Ye code kaha paste karna hai

Apni website ki HTML file kholo, aur **\`</body>\`** tag se theek pehle ye line paste kar do:

\`\`\`html
${embedCode}
\`\`\`

Bas itna hi — koi aur setup nahi chahiye. Widget khud-ba-khud tumhare Live Chat CRM
backend se connect ho jayega.

⚠️ **Agar tumhare paas multiple widgets hain** (jaise ek Main Website ke liye, ek Support
Portal ke liye), to har widget ka apna alag embed code hota hai. Ye code sirf **"${widget.name}"**
widget ke liye hai — sahi website par sahi code paste karna zaroori hai, warna galat
branding/settings dikhengi. Admin → Widget Customizer mein saare widgets aur unke codes
alag-alag milenge.

**Kaha paste na karo:** \`<head>\` section mein mat daalo — widget load hone mein time lagega.
Hamesha \`</body>\` ke theek upar hi paste karo, taaki poora page pehle load ho jaye.

---

## Floating button ka corner/position kaise badle (Top Right / Top Left / Bottom Right / Bottom Left)

### Tarika 1 — Admin panel se (sabse aasan, koi code nahi)

1. Admin panel kholo → **Widget Customizer** page
2. Jis widget ka position badalna hai, uska card kholo
3. "Button Position" mein 4 options milenge:
   - Bottom Right *(default — zyada tar websites yahi use karti hain)*
   - Bottom Left
   - Top Right
   - Top Left
4. Jo bhi corner chaho, us par click karo → **Save** dabao
5. Widget turant naye position par shift ho jayega — website ka code badalne ki zaroorat nahi

### Tarika 2 — Seedha embed code mein likh kar (agar admin panel access nahi hai)

Script tag mein ek extra attribute \`data-position\` daal do:

\`\`\`html
<script src="${origin}/widget.js" data-company="${widget.widget_key}" data-position="top-left"></script>
\`\`\`

\`data-position\` ki valid values:
- \`bottom-right\`
- \`bottom-left\`
- \`top-right\`
- \`top-left\`

⚠️ Note: agar \`data-position\` attribute diya hai, to wo Admin panel ke Widget Customizer
setting ko **override (overwrite)** kar dega us specific website ke liye. Agar attribute
nahi diya, to Admin panel wali setting use hogi.

### Tarika 3 — widget.js file ke andar khud edit karna (advanced, sirf agar khud host kar rahe ho)

\`public/widget.js\` file kholo, upar ki taraf ek comment block milega jisme likha hai:

\`\`\`
// ============================================================
// 📍 WIDGET POSITION — floating button ka corner yahan se control hota hai
// ============================================================
\`\`\`

Us block ke neeche CSS classes hain (\`.lc-pos-bottom-right\`, \`.lc-pos-bottom-left\`,
\`.lc-pos-top-right\`, \`.lc-pos-top-left\`) — inme \`bottom\`, \`top\`, \`left\`, \`right\` values
badal kar spacing/position fine-tune kar sakte ho.

---

## Color aur icon kaise badle

Admin panel → **Widget Customizer** page mein us widget ka card kholo:
- **Brand Color**: color picker se apna brand color chuno — widget bubble aur header usi
  color mein rangega
- **Icon**: preset emojis mein se chuno, apna khud ka emoji/symbol type kar do, YA
  **apni khud ki image/logo upload** kar do (PNG/JPG) — dono options available hain

Save dabate hi live website par turant change dikhega — koi code edit ya redeploy nahi chahiye.

---

## Multiple widgets kyu aur kaise?

Agar tumhare paas ek se zyada website hai (jaise ek main website, ek support portal, ek
alag brand ki website), to har ek ke liye **alag widget** bana sakte ho — har widget ka
apna naam, color, icon, position, aur embed code hota hai. Sab widgets ek hi Admin panel
se manage hote hain (Admin → Widget Customizer → "+ Add new widget").

---

## Current settings is widget ke liye ("${widget.name}")

| Setting | Value |
|---------|-------|
| Position | ${positionLabels[widget.widget_position] || widget.widget_position} |
| Brand color | ${widget.brand_color} |
| Icon type | ${widget.icon_type} |
| Widget key | ${widget.widget_key} |

---

Koi bhi doubt ho to Admin panel → Widget Customizer page se ye guide dubara download kar sakte ho.
`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="chat-widget-embed-${widget.widget_key}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[zip] archive error', err); res.status(500).end(); });
  archive.pipe(res);
  archive.append(embedTxt, { name: 'embed-code.txt' });
  archive.append(readmeMd, { name: 'README.md' });
  archive.finalize();
});

// ---------- Company settings (name only — widget look now lives on each widget) ----------
router.get('/company', (req, res) => {
  const company = db.prepare(`SELECT id, name, telegram_bot_token, telegram_bot_username, created_at FROM companies WHERE id=?`).get(req.auth.companyId);
  res.json({ ...company, telegram_bot_token: company.telegram_bot_token ? '••••••••' + company.telegram_bot_token.slice(-4) : null });
});

router.patch('/company', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  db.prepare(`UPDATE companies SET name=? WHERE id=?`).run(name.trim(), req.auth.companyId);
  res.json({ ok: true });
});

// ---------- Telegram integration (optional) ----------
router.get('/telegram/status', async (req, res) => {
  const company = db.prepare(`SELECT telegram_bot_token, telegram_bot_username FROM companies WHERE id=?`).get(req.auth.companyId);
  const linkedAgentsCount = db.prepare(`SELECT COUNT(*) c FROM agents WHERE company_id=? AND telegram_chat_id IS NOT NULL`).get(req.auth.companyId).c;
  const expectedWebhookUrl = `${req.protocol}://${req.get('host')}/api/telegram/webhook/${req.auth.companyId}`;

  let webhookOk = null;
  let webhookError = null;
  if (company.telegram_bot_token) {
    const info = await telegram.getWebhookInfo(company.telegram_bot_token);
    if (info) {
      webhookOk = info.url === expectedWebhookUrl;
      webhookError = info.last_error_message || (info.url === '' ? 'No webhook is registered with Telegram yet.' : null);
    }
  }

  res.json({
    configured: !!company.telegram_bot_token,
    botUsername: company.telegram_bot_username,
    linkedAgentsCount,
    webhookUrl: expectedWebhookUrl,
    webhookOk,
    webhookError,
    myTelegramLinked: !!db.prepare(`SELECT telegram_chat_id FROM agents WHERE id=?`).get(req.auth.agentId)?.telegram_chat_id,
  });
});

router.post('/telegram/retry-webhook', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const company = db.prepare(`SELECT * FROM companies WHERE id=?`).get(req.auth.companyId);
  if (!company.telegram_bot_token) return res.status(400).json({ error: 'Telegram is not configured yet.' });
  const webhookUrl = `${req.protocol}://${req.get('host')}/api/telegram/webhook/${req.auth.companyId}`;
  const hookResult = await telegram.setWebhook(company.telegram_bot_token, webhookUrl);
  res.json({ ok: hookResult.ok, message: hookResult.description, webhookUrl });
});

router.post('/telegram/config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { botToken } = req.body || {};
  if (!botToken) return res.status(400).json({ error: 'botToken required' });

  const validation = await telegram.validateBotToken(botToken);
  if (!validation.valid) return res.status(400).json({ error: validation.error || 'Invalid bot token' });

  db.prepare(`UPDATE companies SET telegram_bot_token=?, telegram_bot_username=? WHERE id=?`)
    .run(botToken, validation.username, req.auth.companyId);

  const webhookUrl = `${req.protocol}://${req.get('host')}/api/telegram/webhook/${req.auth.companyId}`;
  const hookResult = await telegram.setWebhook(botToken, webhookUrl);

  res.json({ ok: true, botUsername: validation.username, webhookRegistered: hookResult.ok, webhookMessage: hookResult.description });
});

router.delete('/telegram/config', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE companies SET telegram_bot_token=NULL, telegram_bot_username=NULL WHERE id=?`).run(req.auth.companyId);
  res.json({ ok: true });
});

// Any agent can generate their own linking code, then send "/start <code>" to the company bot
router.post('/telegram/link-code', (req, res) => {
  const company = db.prepare(`SELECT * FROM companies WHERE id=?`).get(req.auth.companyId);
  if (!company.telegram_bot_token) return res.status(400).json({ error: 'Telegram is not configured for this company yet — ask an admin to set it up in Settings.' });
  const code = telegram.generateLinkCode(req.auth.agentId);
  res.json({ code, botUsername: company.telegram_bot_username });
});

router.delete('/telegram/link', (req, res) => {
  db.prepare(`UPDATE agents SET telegram_chat_id=NULL, telegram_link_code=NULL WHERE id=?`).run(req.auth.agentId);
  res.json({ ok: true });
});

// ---------- Email notifications (optional, SMTP) ----------
router.get('/email/config', (req, res) => {
  const config = db.prepare(`SELECT * FROM email_config WHERE company_id=?`).get(req.auth.companyId);
  if (!config) return res.json({ configured: false });
  res.json({
    configured: true,
    smtp_host: config.smtp_host,
    smtp_port: config.smtp_port,
    smtp_secure: !!config.smtp_secure,
    smtp_user: config.smtp_user,
    from_email: config.from_email,
    from_name: config.from_name,
    admin_notify_email: config.admin_notify_email,
    notify_on_new_lead: !!config.notify_on_new_lead,
    notify_agent_on_assign: !!config.notify_agent_on_assign,
  });
});

router.post('/email/config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_email, from_name, admin_notify_email, notify_on_new_lead, notify_agent_on_assign, sendTest } = req.body || {};
  if (!smtp_host || !smtp_port || !smtp_user || !from_email) {
    return res.status(400).json({ error: 'smtp_host, smtp_port, smtp_user, and from_email are required' });
  }
  const existing = db.prepare(`SELECT * FROM email_config WHERE company_id=?`).get(req.auth.companyId);
  const finalPass = smtp_pass || existing?.smtp_pass; // allow saving other fields without re-entering password

  if (sendTest) {
    const testResult = await email.sendTestEmail(
      { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass: finalPass, from_email, from_name },
      admin_notify_email || smtp_user
    );
    if (!testResult.ok) return res.status(400).json({ error: `Test email failed: ${testResult.error}` });
  }

  if (existing) {
    db.prepare(`
      UPDATE email_config SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=?, from_email=?, from_name=?,
        admin_notify_email=?, notify_on_new_lead=?, notify_agent_on_assign=? WHERE company_id=?
    `).run(smtp_host, smtp_port, smtp_secure ? 1 : 0, smtp_user, finalPass, from_email, from_name || '',
        admin_notify_email || '', notify_on_new_lead ? 1 : 0, notify_agent_on_assign ? 1 : 0, req.auth.companyId);
  } else {
    db.prepare(`
      INSERT INTO email_config (company_id, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_email, from_name, admin_notify_email, notify_on_new_lead, notify_agent_on_assign)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.auth.companyId, smtp_host, smtp_port, smtp_secure ? 1 : 0, smtp_user, finalPass, from_email, from_name || '',
        admin_notify_email || '', notify_on_new_lead ? 1 : 0, notify_agent_on_assign ? 1 : 0);
  }
  res.json({ ok: true, testSent: !!sendTest });
});

router.delete('/email/config', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM email_config WHERE company_id=?`).run(req.auth.companyId);
  res.json({ ok: true });
});

// ---------- Google Sheets sync (optional) ----------
router.get('/sheets/config', (req, res) => {
  const config = db.prepare(`SELECT * FROM sheets_config WHERE company_id=?`).get(req.auth.companyId);
  if (!config) return res.json({ configured: false });
  res.json({
    configured: !!config.webhook_url,
    webhook_url: config.webhook_url,
    sync_leads: !!config.sync_leads,
    sync_admin_data: !!config.sync_admin_data,
    last_synced_at: config.last_synced_at,
    last_sync_status: config.last_sync_status,
  });
});

router.post('/sheets/config', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { webhook_url, sync_leads, sync_admin_data } = req.body || {};
  if (!webhook_url || !webhook_url.startsWith('https://script.google.com/')) {
    return res.status(400).json({ error: 'A valid Google Apps Script Web App URL (starts with https://script.google.com/) is required' });
  }
  const existing = db.prepare(`SELECT * FROM sheets_config WHERE company_id=?`).get(req.auth.companyId);
  if (existing) {
    db.prepare(`UPDATE sheets_config SET webhook_url=?, sync_leads=?, sync_admin_data=? WHERE company_id=?`)
      .run(webhook_url, sync_leads !== false ? 1 : 0, sync_admin_data !== false ? 1 : 0, req.auth.companyId);
  } else {
    db.prepare(`INSERT INTO sheets_config (company_id, webhook_url, sync_leads, sync_admin_data) VALUES (?, ?, ?, ?)`)
      .run(req.auth.companyId, webhook_url, sync_leads !== false ? 1 : 0, sync_admin_data !== false ? 1 : 0);
  }
  res.json({ ok: true });
});

router.delete('/sheets/config', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM sheets_config WHERE company_id=?`).run(req.auth.companyId);
  res.json({ ok: true });
});

router.post('/sheets/sync-now', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const result = await sheets.syncAdminData(req.auth.companyId);
  if (!result.ok) return res.status(400).json({ error: result.error || `Sync failed (HTTP ${result.status || '?'})` });
  res.json({ ok: true });
});


// ---------- Bot Questions (customizable auto-reply flow) ----------
router.get('/bot-questions', (req, res) => {
  res.json(db.prepare(`SELECT * FROM bot_questions WHERE company_id=? ORDER BY order_index ASC`).all(req.auth.companyId));
});

router.post('/bot-questions', (req, res) => {
  if (!['super_admin', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Forbidden' });
  const { field_key, question_text, type, choices, required, is_category_routing } = req.body || {};
  if (!field_key || !question_text) return res.status(400).json({ error: 'field_key and question_text required' });
  if (type === 'choice' && (!choices || !JSON.parse(choices || '[]').length)) {
    return res.status(400).json({ error: 'Choice questions need at least one option' });
  }
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(order_index), -1) m FROM bot_questions WHERE company_id=?`).get(req.auth.companyId).m;
  const id = randomUUID();
  db.prepare(`INSERT INTO bot_questions (id, company_id, order_index, field_key, question_text, type, choices, required, is_category_routing)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.auth.companyId, maxOrder + 1, field_key, question_text, type || 'text', choices || null, required ? 1 : 0, is_category_routing ? 1 : 0);
  res.json({ id });
});

router.patch('/bot-questions/:id', (req, res) => {
  if (!['super_admin', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Forbidden' });
  const q = db.prepare(`SELECT * FROM bot_questions WHERE id=? AND company_id=?`).get(req.params.id, req.auth.companyId);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { question_text, type, choices, required, is_category_routing } = req.body || {};
  db.prepare(`UPDATE bot_questions SET question_text=?, type=?, choices=?, required=?, is_category_routing=? WHERE id=?`)
    .run(
      question_text ?? q.question_text,
      type ?? q.type,
      choices !== undefined ? choices : q.choices,
      required !== undefined ? (required ? 1 : 0) : q.required,
      is_category_routing !== undefined ? (is_category_routing ? 1 : 0) : q.is_category_routing,
      q.id
    );
  res.json({ ok: true });
});

router.delete('/bot-questions/:id', (req, res) => {
  if (!['super_admin', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM bot_questions WHERE id=? AND company_id=?`).run(req.params.id, req.auth.companyId);
  res.json({ ok: true });
});

router.post('/bot-questions/reorder', (req, res) => {
  if (!['super_admin', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Forbidden' });
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
  const update = db.prepare(`UPDATE bot_questions SET order_index=? WHERE id=? AND company_id=?`);
  orderedIds.forEach((id, index) => update.run(index, id, req.auth.companyId));
  res.json({ ok: true });
});

// ---------- Push notifications ----------
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

router.post('/push/subscribe', (req, res) => {
  const ok = saveSubscription(req.auth.agentId, req.auth.companyId, req.body.subscription);
  if (!ok) return res.status(400).json({ error: 'Invalid subscription payload' });
  res.json({ ok: true });
});

router.post('/push/unsubscribe', (req, res) => {
  if (req.body.endpoint) removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

return router;
};
