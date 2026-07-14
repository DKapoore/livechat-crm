const db = require('./db');

function getSheetsConfig(companyId) {
  return db.prepare(`SELECT * FROM sheets_config WHERE company_id = ?`).get(companyId);
}

async function postToSheet(webhookUrl, payload) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data;
    try { data = await res.json(); } catch { data = { ok: res.ok }; }
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function recordSyncResult(companyId, ok, message) {
  db.prepare(`
    UPDATE sheets_config SET last_synced_at = datetime('now'), last_sync_status = ? WHERE company_id = ?
  `).run(ok ? `OK: ${message || 'synced'}` : `FAILED: ${message || 'unknown error'}`, companyId);
}

// Push a single new lead row the moment it's captured (real-time-ish, doesn't wait for a full sync)
async function pushLead(companyId, visitor, conversation, widget) {
  const config = getSheetsConfig(companyId);
  if (!config || !config.webhook_url || !config.sync_leads) return;
  const services = visitor.interested_services ? JSON.parse(visitor.interested_services) : [];
  const result = await postToSheet(config.webhook_url, {
    type: 'lead',
    row: {
      timestamp: new Date().toISOString(),
      name: visitor.name || '',
      mobile: visitor.mobile || '',
      email: visitor.email || '',
      interestedIn: services.join(', '),
      consentGiven: visitor.consent_given ? 'Yes' : 'No',
      widgetName: widget?.name || '',
      pageUrl: visitor.page_url || '',
      category: conversation?.category || '',
      shortCode: conversation?.short_code || '',
    },
  });
  recordSyncResult(companyId, result.ok, result.ok ? 'lead synced' : (result.error || 'lead sync failed'));
}

// Full snapshot sync of everything EXCEPT secrets (no passwords, no SMTP creds, no bot tokens,
// no raw Telegram chat IDs — only a linked yes/no flag). Triggered manually ("Sync Now") or
// on key admin-side changes (agent added, widget saved, settings changed).
async function syncAdminData(companyId) {
  const config = getSheetsConfig(companyId);
  if (!config || !config.webhook_url || !config.sync_admin_data) return { ok: false, error: 'Not configured' };

  const company = db.prepare(`SELECT id, name, created_at FROM companies WHERE id = ?`).get(companyId);
  const agents = db.prepare(`
    SELECT name, email, role, status, department_id, active_chats, max_chats,
           CASE WHEN telegram_chat_id IS NOT NULL THEN 'Yes' ELSE 'No' END as telegram_linked
    FROM agents WHERE company_id = ?
  `).all(companyId);
  const departments = db.prepare(`SELECT name FROM departments WHERE company_id = ?`).all(companyId);
  const widgets = db.prepare(`
    SELECT name, widget_key, brand_color, widget_position, icon_type, lead_form_enabled FROM widgets WHERE company_id = ?
  `).all(companyId);
  const visitorsCount = db.prepare(`SELECT COUNT(*) c FROM visitors WHERE company_id = ?`).get(companyId).c;
  const conversationsCount = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE company_id = ?`).get(companyId).c;
  const closedCount = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE company_id = ? AND status = 'closed'`).get(companyId).c;

  const result = await postToSheet(config.webhook_url, {
    type: 'full_sync',
    company: { name: company.name, createdAt: company.created_at },
    agents: agents.map(a => ({ ...a, department_id: undefined })),
    departments,
    widgets,
    stats: {
      totalVisitors: visitorsCount,
      totalConversations: conversationsCount,
      closedConversations: closedCount,
      syncedAt: new Date().toISOString(),
    },
  });

  recordSyncResult(companyId, result.ok, result.ok ? 'full sync complete' : (result.error || `HTTP ${result.status}`));
  return result;
}

module.exports = { getSheetsConfig, pushLead, syncAdminData, postToSheet };
