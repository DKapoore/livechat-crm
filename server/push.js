const webpush = require('web-push');
const db = require('./db');

const config = db.prepare(`SELECT * FROM push_config WHERE id = 1`).get();
if (config) {
  webpush.setVapidDetails('mailto:admin@example.com', config.public_key, config.private_key);
}

function getPublicKey() {
  const c = db.prepare(`SELECT public_key FROM push_config WHERE id = 1`).get();
  return c ? c.public_key : null;
}

function saveSubscription(agentId, companyId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (id, agent_id, company_id, endpoint, p256dh, auth)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET agent_id = excluded.agent_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(agentId, companyId, endpoint, keys.p256dh, keys.auth);
  return true;
}

function removeSubscription(endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
  } catch (err) {
    // 404/410 = subscription is dead (browser unsubscribed, uninstalled, etc.) — clean it up
    if (err.statusCode === 404 || err.statusCode === 410) {
      removeSubscription(sub.endpoint);
    } else {
      console.error('[push] send failed:', err.statusCode, err.body || err.message);
    }
  }
}

function notifyCompanyAgents(companyId, payload) {
  if (!getPublicKey()) return;
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE company_id = ?`).all(companyId);
  subs.forEach(sub => sendToSubscription(sub, payload));
}

function notifyAgent(agentId, payload) {
  if (!getPublicKey()) return;
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE agent_id = ?`).all(agentId);
  subs.forEach(sub => sendToSubscription(sub, payload));
}

module.exports = { getPublicKey, saveSubscription, removeSubscription, notifyCompanyAgents, notifyAgent };
