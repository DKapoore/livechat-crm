const nodemailer = require('nodemailer');
const db = require('./db');

function getEmailConfig(companyId) {
  return db.prepare(`SELECT * FROM email_config WHERE company_id = ?`).get(companyId);
}

function buildTransport(config) {
  return nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port,
    secure: !!config.smtp_secure, // true for port 465, false for 587/others (STARTTLS)
    auth: { user: config.smtp_user, pass: config.smtp_pass },
  });
}

async function sendTestEmail(config, toEmail) {
  try {
    const transport = buildTransport(config);
    await transport.sendMail({
      from: `"${config.from_name || 'Live Chat CRM'}" <${config.from_email}>`,
      to: toEmail,
      subject: '✅ Test email — Live Chat CRM',
      html: `<p>This is a test email confirming your SMTP settings are working correctly.</p>`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function leadEmailHtml({ visitor, conversation, widget, adminUrl }) {
  const services = visitor.interested_services ? JSON.parse(visitor.interested_services) : [];
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
      <div style="background:#16a34a; color:#fff; padding:16px 20px; border-radius: 10px 10px 0 0;">
        <h2 style="margin:0; font-size:18px;">🔔 New Lead / New Visitor</h2>
      </div>
      <div style="border:1px solid #e2e8f0; border-top:none; padding:20px; border-radius:0 0 10px 10px;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <tr><td style="padding:6px 0; color:#64748b; width:140px;">Name</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(visitor.name || '—')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Mobile</td><td style="padding:6px 0;">${escapeHtml(visitor.mobile || '—')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Email</td><td style="padding:6px 0;">${escapeHtml(visitor.email || '—')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Interested in</td><td style="padding:6px 0;">${services.map(escapeHtml).join(', ') || '—'}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Consent given</td><td style="padding:6px 0;">${visitor.consent_given ? '✅ Yes' : '❌ No'}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Source widget</td><td style="padding:6px 0;">${escapeHtml(widget?.name || '—')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Page URL</td><td style="padding:6px 0; word-break:break-all;">${escapeHtml(visitor.page_url || '—')}</td></tr>
        </table>
        ${adminUrl ? `<a href="${adminUrl}" style="display:inline-block; margin-top:16px; background:#16a34a; color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600;">Open in Dashboard →</a>` : ''}
      </div>
    </div>
  `;
}

function assignmentEmailHtml({ agent, visitor, conversation, adminUrl }) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
      <div style="background:#2563eb; color:#fff; padding:16px 20px; border-radius: 10px 10px 0 0;">
        <h2 style="margin:0; font-size:18px;">💼 New Chat Assigned to You</h2>
      </div>
      <div style="border:1px solid #e2e8f0; border-top:none; padding:20px; border-radius:0 0 10px 10px;">
        <p style="font-size:14px; margin-top:0;">Hi ${escapeHtml(agent.name)}, a conversation has been assigned to you:</p>
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <tr><td style="padding:6px 0; color:#64748b; width:140px;">Visitor</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(visitor.name || 'Anonymous')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Topic</td><td style="padding:6px 0;">${escapeHtml(conversation.category || 'General')}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b;">Reference</td><td style="padding:6px 0;">#${escapeHtml(conversation.short_code || '')}</td></tr>
        </table>
        ${adminUrl ? `<a href="${adminUrl}" style="display:inline-block; margin-top:16px; background:#2563eb; color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600;">Reply now →</a>` : ''}
      </div>
    </div>
  `;
}

async function notifyNewLead(companyId, { visitor, conversation, widget, origin }) {
  const config = getEmailConfig(companyId);
  if (!config || !config.smtp_host || !config.notify_on_new_lead || !config.admin_notify_email) return;
  try {
    const transport = buildTransport(config);
    await transport.sendMail({
      from: `"${config.from_name || 'Live Chat CRM'}" <${config.from_email}>`,
      to: config.admin_notify_email,
      subject: `New Lead/New Visitor - ${visitor.name || 'Anonymous'}`,
      html: leadEmailHtml({ visitor, conversation, widget, adminUrl: origin ? `${origin}/admin/#inbox` : null }),
    });
  } catch (err) {
    console.error('[email] notifyNewLead failed:', err.message);
  }
}

async function notifyAgentAssigned(companyId, { agent, visitor, conversation, origin }) {
  const config = getEmailConfig(companyId);
  if (!config || !config.smtp_host || !config.notify_agent_on_assign || !agent.email) return;
  try {
    const transport = buildTransport(config);
    await transport.sendMail({
      from: `"${config.from_name || 'Live Chat CRM'}" <${config.from_email}>`,
      to: agent.email,
      subject: `New chat assigned to you — #${conversation.short_code}`,
      html: assignmentEmailHtml({ agent, visitor, conversation, adminUrl: origin ? `${origin}/admin/#assigned` : null }),
    });
  } catch (err) {
    console.error('[email] notifyAgentAssigned failed:', err.message);
  }
}

module.exports = { getEmailConfig, sendTestEmail, notifyNewLead, notifyAgentAssigned };
