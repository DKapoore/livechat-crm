const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const routes = require('./routes');
const { setupSockets } = require('./sockets');
const db = require('./db');

const app = express();
const server = http.createServer(app);

// Render (and most PaaS platforms) sit behind a reverse proxy that terminates SSL —
// without this, req.protocol always reports 'http' even when the real request was
// https, which breaks anything that builds an absolute URL from the request (like
// the Telegram webhook registration below).
app.set('trust proxy', 1);
const io = new Server(server, {
  cors: { origin: '*' }, // widget is embedded on arbitrary third-party sites
});

app.use(cors());
app.use(express.json());

// Serve /demo.html dynamically so it always uses the CURRENT company's widget key,
// even after the database has been reset/reseeded (which generates a new random key).
app.get('/demo.html', (req, res) => {
  const widget = db.prepare('SELECT widget_key FROM widgets ORDER BY created_at ASC LIMIT 1').get();
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'demo-template.html'), 'utf8');
  res.send(template.replace('{{WIDGET_KEY}}', widget ? widget.widget_key : ''));
});

// Serve uploaded attachments
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Serve the embeddable widget script + assets, and the admin dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', routes(io));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

setupSockets(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Live Chat CRM server running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
  console.log(`Widget demo page: http://localhost:${PORT}/demo.html`);
});
