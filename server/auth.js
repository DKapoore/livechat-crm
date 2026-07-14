const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function login(email, password) {
  const agent = db.prepare(`SELECT * FROM agents WHERE email = ?`).get(email);
  if (!agent) return null;
  const ok = bcrypt.compareSync(password, agent.password_hash);
  if (!ok) return null;

  const token = jwt.sign(
    { agentId: agent.id, companyId: agent.company_id, role: agent.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  const { password_hash, ...safeAgent } = agent;
  return { token, agent: safeAgent };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.auth = payload;
  next();
}

module.exports = { login, verifyToken, authMiddleware, JWT_SECRET };
