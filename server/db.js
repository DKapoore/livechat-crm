const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'chat.db');
require('fs').mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  widget_key TEXT UNIQUE NOT NULL, -- legacy: kept for backward-compat migration only, new widgets live in the widgets table
  brand_color TEXT DEFAULT '#16a34a',
  welcome_message TEXT DEFAULT 'Welcome! 👋',
  widget_position TEXT DEFAULT 'bottom-right',
  widget_icon TEXT DEFAULT '💬',
  telegram_bot_token TEXT,
  telegram_bot_username TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Multiple widgets per company: each has its own key, name, look, and can be embedded
-- on a different website. A single company/business can run several of these.
CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- internal label, e.g. "Main Website", "Support Portal"
  widget_key TEXT UNIQUE NOT NULL,
  brand_color TEXT DEFAULT '#16a34a',
  welcome_message TEXT DEFAULT 'Welcome! 👋',
  widget_position TEXT DEFAULT 'bottom-right', -- bottom-right | bottom-left | top-right | top-left
  icon_type TEXT DEFAULT 'emoji', -- 'emoji' | 'image'
  icon_value TEXT DEFAULT '💬', -- an emoji character, or an /uploads/... image URL
  icon_display_mode TEXT DEFAULT 'icon', -- 'icon' (small centered icon) | 'full' (image fills the whole button as background)
  button_animation TEXT DEFAULT 'none', -- 'none' | 'pulse' | 'bounce' | 'glow' | 'shake'
  button_label_enabled INTEGER DEFAULT 0,
  button_label_text TEXT DEFAULT 'Chat with us!',
  button_outline_color TEXT DEFAULT '',
  button_outline_width INTEGER DEFAULT 0,
  button_size INTEGER DEFAULT 60, -- px, 44-100 range
  lead_form_enabled INTEGER DEFAULT 0, -- if 1, show a mandatory Name/Mobile/Email/Interest form before chat starts
  lead_form_services TEXT DEFAULT '["General Inquiry"]', -- JSON array of options for the "interested in" dropdown
  lead_form_consent_text TEXT DEFAULT 'I agree to be contacted regarding my inquiry.',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'agent', -- super_admin, manager, agent, department_admin
  department_id TEXT REFERENCES departments(id),
  status TEXT DEFAULT 'offline', -- online, offline, away
  active_chats INTEGER DEFAULT 0,
  max_chats INTEGER DEFAULT 5,
  telegram_chat_id TEXT, -- set once the agent links their Telegram account
  telegram_link_code TEXT, -- temporary code shown to the agent to complete linking
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT,
  contact TEXT,
  mobile TEXT,
  email TEXT,
  interested_services TEXT, -- JSON array of selected service labels from the lead form
  consent_given INTEGER DEFAULT 0,
  lead_captured_at TEXT,
  page_url TEXT,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now'))
);

-- Per-company SMTP + notification email settings
CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_id TEXT UNIQUE NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER DEFAULT 0,
  smtp_user TEXT,
  smtp_pass TEXT,
  from_email TEXT,
  from_name TEXT,
  admin_notify_email TEXT, -- where "new lead" emails go
  notify_on_new_lead INTEGER DEFAULT 1,
  notify_agent_on_assign INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-company Google Sheets sync settings (Apps Script Web App webhook URL)
CREATE TABLE IF NOT EXISTS sheets_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_id TEXT UNIQUE NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  webhook_url TEXT,
  sync_leads INTEGER DEFAULT 1,
  sync_admin_data INTEGER DEFAULT 1, -- agents (no passwords), departments, widgets, stats, telegram-linked status
  last_synced_at TEXT,
  last_sync_status TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  widget_id TEXT REFERENCES widgets(id) ON DELETE SET NULL, -- which embedded widget/website this chat came from
  short_code TEXT, -- short human-typeable code (e.g. for replying via Telegram)
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  department_id TEXT REFERENCES departments(id),
  category TEXT,
  status TEXT DEFAULT 'bot', -- bot, waiting, assigned, closed
  priority TEXT DEFAULT 'normal', -- low, normal, high, vip
  bot_step INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL, -- visitor, agent, bot, system
  sender_id TEXT,
  sender_name TEXT,
  text TEXT,
  is_internal_note INTEGER DEFAULT 0,
  meta TEXT, -- JSON: e.g. { quickReplies: [{value,label}] }
  attachment_url TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_questions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  field_key TEXT NOT NULL, -- 'name', 'contact', or a custom key
  question_text TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- 'text' or 'choice'
  choices TEXT, -- JSON array [{value,label,department}] for type=choice
  required INTEGER DEFAULT 0,
  is_category_routing INTEGER DEFAULT 0, -- if 1, the chosen option's department routes the chat
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_answers (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES bot_questions(id),
  field_key TEXT,
  question_text TEXT,
  answer_text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(company_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
`);

// --- Migration guard: add columns to companies table if this DB predates them ---
const existingCompanyCols = db.prepare(`PRAGMA table_info(companies)`).all().map(c => c.name);
if (!existingCompanyCols.includes('widget_position')) {
  db.exec(`ALTER TABLE companies ADD COLUMN widget_position TEXT DEFAULT 'bottom-right'`);
}
if (!existingCompanyCols.includes('widget_icon')) {
  db.exec(`ALTER TABLE companies ADD COLUMN widget_icon TEXT DEFAULT '💬'`);
}
if (!existingCompanyCols.includes('telegram_bot_token')) {
  db.exec(`ALTER TABLE companies ADD COLUMN telegram_bot_token TEXT`);
}
if (!existingCompanyCols.includes('telegram_bot_username')) {
  db.exec(`ALTER TABLE companies ADD COLUMN telegram_bot_username TEXT`);
}

const existingConvCols = db.prepare(`PRAGMA table_info(conversations)`).all().map(c => c.name);
if (!existingConvCols.includes('widget_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN widget_id TEXT REFERENCES widgets(id) ON DELETE SET NULL`);
}
if (!existingConvCols.includes('short_code')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN short_code TEXT`);
}

const existingAgentCols = db.prepare(`PRAGMA table_info(agents)`).all().map(c => c.name);
if (!existingAgentCols.includes('telegram_chat_id')) {
  db.exec(`ALTER TABLE agents ADD COLUMN telegram_chat_id TEXT`);
}
if (!existingAgentCols.includes('telegram_link_code')) {
  db.exec(`ALTER TABLE agents ADD COLUMN telegram_link_code TEXT`);
}

const existingWidgetCols = db.prepare(`PRAGMA table_info(widgets)`).all().map(c => c.name);
if (!existingWidgetCols.includes('lead_form_enabled')) {
  db.exec(`ALTER TABLE widgets ADD COLUMN lead_form_enabled INTEGER DEFAULT 0`);
}
if (!existingWidgetCols.includes('lead_form_services')) {
  db.exec(`ALTER TABLE widgets ADD COLUMN lead_form_services TEXT DEFAULT '["General Inquiry"]'`);
}
if (!existingWidgetCols.includes('lead_form_consent_text')) {
  db.exec(`ALTER TABLE widgets ADD COLUMN lead_form_consent_text TEXT DEFAULT 'I agree to be contacted regarding my inquiry.'`);
}
for (const [col, def] of [
  ['icon_display_mode', `TEXT DEFAULT 'icon'`],
  ['button_animation', `TEXT DEFAULT 'none'`],
  ['button_label_enabled', `INTEGER DEFAULT 0`],
  ['button_label_text', `TEXT DEFAULT 'Chat with us!'`],
  ['button_outline_color', `TEXT DEFAULT ''`],
  ['button_outline_width', `INTEGER DEFAULT 0`],
  ['button_size', `INTEGER DEFAULT 60`],
]) {
  if (!existingWidgetCols.includes(col)) {
    db.exec(`ALTER TABLE widgets ADD COLUMN ${col} ${def}`);
  }
}

const existingVisitorCols = db.prepare(`PRAGMA table_info(visitors)`).all().map(c => c.name);
for (const [col, def] of [['mobile', 'TEXT'], ['email', 'TEXT'], ['interested_services', 'TEXT'], ['consent_given', 'INTEGER DEFAULT 0'], ['lead_captured_at', 'TEXT']]) {
  if (!existingVisitorCols.includes(col)) {
    db.exec(`ALTER TABLE visitors ADD COLUMN ${col} ${def}`);
  }
}

// --- Migration: every existing company must have at least one row in `widgets`.
// Older DBs stored widget branding directly on the companies table (single-widget era);
// carry that config forward into a real widgets row so nothing visually changes on upgrade.
const companiesNeedingWidget = db.prepare(`
  SELECT c.* FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM widgets w WHERE w.company_id = c.id)
`).all();
for (const company of companiesNeedingWidget) {
  db.prepare(`
    INSERT INTO widgets (id, company_id, name, widget_key, brand_color, welcome_message, widget_position, icon_type, icon_value)
    VALUES (?, ?, 'Main Website', ?, ?, ?, ?, 'emoji', ?)
  `).run(randomUUID(), company.id, company.widget_key, company.brand_color, company.welcome_message, company.widget_position, company.widget_icon);
}

// --- Migration: backfill widget_id + short_code on any conversations that predate them ---
const convsMissingShortCode = db.prepare(`SELECT id, company_id FROM conversations WHERE short_code IS NULL`).all();
if (convsMissingShortCode.length) {
  const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  const updateStmt = db.prepare(`UPDATE conversations SET short_code = ?, widget_id = COALESCE(widget_id, (SELECT id FROM widgets WHERE company_id = ? LIMIT 1)) WHERE id = ?`);
  for (const c of convsMissingShortCode) {
    updateStmt.run(genCode(), c.company_id, c.id);
  }
}

// --- Seed a demo company + admin agent + departments if empty ---
const companyCount = db.prepare('SELECT COUNT(*) c FROM companies').get().c;
if (companyCount === 0) {
  const companyId = randomUUID();
  const widgetKey = 'demo-' + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO companies (id, name, widget_key) VALUES (?, ?, ?)`)
    .run(companyId, 'Demo Company', widgetKey);

  const widgetId = randomUUID();
  db.prepare(`INSERT INTO widgets (id, company_id, name, widget_key, brand_color, welcome_message, widget_position, icon_type, icon_value)
              VALUES (?, ?, 'Main Website', ?, '#16a34a', 'Welcome! 👋', 'bottom-right', 'emoji', '💬')`)
    .run(widgetId, companyId, widgetKey);

  const depts = ['Sales', 'Technical', 'Billing', 'Support'];
  const deptIds = {};
  for (const d of depts) {
    const id = randomUUID();
    deptIds[d] = id;
    db.prepare(`INSERT INTO departments (id, company_id, name) VALUES (?, ?, ?)`)
      .run(id, companyId, d);
  }

  const adminId = randomUUID();
  db.prepare(`INSERT INTO agents (id, company_id, name, email, password_hash, role, status, department_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(adminId, companyId, 'Admin', 'admin@demo.com', bcrypt.hashSync('admin123', 10), 'super_admin', 'offline', deptIds['Support']);

  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents (id, company_id, name, email, password_hash, role, status, department_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(agentId, companyId, 'Agent Priya', 'agent@demo.com', bcrypt.hashSync('agent123', 10), 'agent', 'offline', deptIds['Sales']);

  // Default bot question flow: name -> contact -> category (with department routing)
  const q1 = randomUUID();
  db.prepare(`INSERT INTO bot_questions (id, company_id, order_index, field_key, question_text, type, required, is_category_routing)
              VALUES (?, ?, 0, 'name', 'What is your name?', 'text', 1, 0)`).run(q1, companyId);

  const q2 = randomUUID();
  db.prepare(`INSERT INTO bot_questions (id, company_id, order_index, field_key, question_text, type, required, is_category_routing)
              VALUES (?, ?, 1, 'contact', 'Could you share your mobile or email? (optional — type "skip" to continue)', 'text', 0, 0)`).run(q2, companyId);

  const q3 = randomUUID();
  const categoryChoices = JSON.stringify([
    { value: '1', label: 'Product Support', department: 'Support' },
    { value: '2', label: 'Sales', department: 'Sales' },
    { value: '3', label: 'Billing', department: 'Billing' },
    { value: '4', label: 'Technical Issue', department: 'Technical' },
    { value: '5', label: 'Other', department: 'Support' },
  ]);
  db.prepare(`INSERT INTO bot_questions (id, company_id, order_index, field_key, question_text, type, choices, required, is_category_routing)
              VALUES (?, ?, 2, 'category', 'What do you want help with?', 'choice', ?, 1, 1)`).run(q3, companyId, categoryChoices);

  console.log('--------------------------------------------------');
  console.log('Seeded demo company. Widget key:', widgetKey);
  console.log('Admin login: admin@demo.com / admin123');
  console.log('Agent login: agent@demo.com / agent123');
  console.log('--------------------------------------------------');
}

// --- Generate VAPID keys for web push (once) ---
const pushConfigCount = db.prepare('SELECT COUNT(*) c FROM push_config').get().c;
if (pushConfigCount === 0) {
  const webpush = require('web-push');
  const keys = webpush.generateVAPIDKeys();
  db.prepare(`INSERT INTO push_config (id, public_key, private_key) VALUES (1, ?, ?)`)
    .run(keys.publicKey, keys.privateKey);
}

module.exports = db;
