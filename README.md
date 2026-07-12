# Live Chat CRM — Working MVP

A real, running foundation for a multi-agent live chat CRM: Node.js + Express + Socket.IO backend,
SQLite database, JWT-authenticated admin API, an embeddable widget script, and a functional admin
dashboard. This is **not** the full 20-page enterprise spec — it's the working core that everything
else plugs into. See "What's built vs. what's next" below.

## Quick start

```bash
npm install
npm start
```

Then open:
- **Demo website with the widget embedded:** http://localhost:4000/demo.html
- **Admin dashboard:** http://localhost:4000/admin

On first run the server seeds a demo company, two departments-worth of agents, and prints your
widget key and login credentials to the console:

```
Admin login: admin@demo.com / admin123
Agent login: agent@demo.com / agent123
```

The SQLite file lives at `data/chat.db` (auto-created, gitignored). Delete it to reset to a fresh
seeded state.

## How the pieces fit together

```
Visitor's website              This backend                    Admin dashboard
┌──────────────────┐   WS      ┌──────────────────┐    WS      ┌──────────────────┐
│ <script src=      │ ───────► │ /widget namespace │ ─────────► │ /agent namespace  │
│  widget.js        │          │  bot flow engine  │            │  live queue, chat │
│  data-company=X>  │ ◄─────── │  auto-assign       │ ◄───────── │  panel, agents…   │
└──────────────────┘          │  SQLite (better-   │            └──────────────────┘
                                │  sqlite3)          │
                                └──────────────────┘
                                       ▲
                                REST API (/api/*, JWT)
```

- **Embed code**: one script tag, generated per-company on the Admin → "Widget & Embed" page.
  It injects the floating widget UI, connects back to this server over WebSocket, and remembers
  the conversation in `localStorage` so a page refresh reconnects to the same chat.
- **Bot flow**: implemented as a small state machine (`server/bot/flow.js`) — welcome → name →
  contact (optional) → category (quick-reply buttons) → routed into the waiting queue.
- **Routing**: on reaching the queue, the server tries to auto-assign to an online agent in the
  matching department with the fewest active chats, falling back to any online agent. Admins can
  also manually assign/reassign from the Waiting Queue page.
- **Real-time**: Socket.IO namespaces `/widget` (visitor-facing) and `/agent` (dashboard), rooms
  per-conversation and per-company so messages, queue changes, and typing indicators broadcast
  live to everyone who should see them.
- **Admin dashboard**: vanilla JS SPA (no build step) — Dashboard, Waiting Queue, Assigned Chats,
  Closed Chats, Visitors, Agents (add/manage, role field), Departments, Widget & Embed, Settings
  (brand color / welcome message). Agent chat panel supports replying, internal notes (hidden from
  the visitor), assigning, and closing.

## What's built vs. what's still a stub or missing

**Working now:** widget embed + real backend connection, **fully customizable bot question flow**
(admin can add/edit/delete/reorder questions, mix free-text and multiple-choice, route to
departments from any choice question), department-based auto-assign, manual assign/transfer,
JWT auth with roles, **agents can update their own name/email/password**, live agent↔visitor
messaging, internal notes, unified **Inbox** + waiting/assigned/closed queues, visitors list with
**CSV export**, agent + department management, **file/image attachments** from both the widget and
the admin chat panel, widget branding settings, reconnect-after-refresh, **installable mobile PWA**
admin dashboard with **push notifications** for new chats and assignments.

**Not yet built** (still ahead):
- Emoji picker, canned replies, tags, AI-suggested replies, knowledge base + search, conversation
  merge, chat transfer *between* agents (currently only queue/inbox→agent assign), read
  receipts/seen status, sound notifications, voice notes.
- Reports/analytics pages, audit/activity logs, PDF export, conversation backup automation.
- Redis-backed queue/session store and horizontal scaling — single Node process + SQLite is fine
  for small-to-mid volume but not "thousands of concurrent visitors" without Redis + Postgres.
- Multi-language widget strings, plugin architecture, full RBAC enforcement on every route.
- Rate limiting, deeper input sanitization for production hardening.

## New in this update (v3)

- **Multiple widgets per account**: Admin → Widget Customizer now manages a *list* of widgets,
  not just one. Each has its own name, embed code, color, position, and icon — run a differently
  branded chat button on each of your websites from one dashboard.
- **Custom image icons**: the floating button icon can now be an uploaded image/logo instead of
  just an emoji — toggle between "Emoji" and "Upload image" per widget in the Customizer.
- **Role-based access control**: agents (role `agent`) can no longer see or use Agents,
  Departments, Bot Flow, Widget Customizer, or Settings — those pages are hidden from their
  sidebar, and the underlying API routes now reject non-admin requests server-side too (this
  was previously enforced inconsistently). Agents can only change their *own* online/offline
  status, not another agent's. Visitor CSV export is now admin/manager-only.
- **Telegram integration (optional)**: Admin → Settings → Telegram Integration lets you connect
  a Telegram bot (via @BotFather token). Each agent can then link their own Telegram account
  from My Account. Once a chat is assigned to a Telegram-linked agent, they get notified on
  Telegram and can reply by sending `#CODE their message` — that reply is saved and broadcast
  through the exact same pipeline as an in-app reply, so it shows up live in the admin dashboard
  automatically. This feature is fully optional and invisible until a bot token is configured.

Agent vs Admin login — quick clarification: there's one login system (email + password + JWT)
for everyone; a `role` field on each account (`super_admin` / `manager` / `department_admin` /
`agent`) determines what they can see and do. Admins manage widgets, agents, departments, the
bot flow, and settings. Agents only get the chat-handling pages (Inbox, Queue, Assigned, Closed,
Visitors, My Account) — nothing that could reconfigure the account is exposed to them, and this
is now enforced on the backend, not just hidden in the UI.

## New in this update (v2)

- **Bot Flow builder** (Admin → Bot Flow): add/edit/delete/reorder the questions the bot asks.
  Supports free-text and multiple-choice questions; any choice question can be marked to route
  the conversation to a matching department.
- **Visitors → Export CSV**: one click downloads all visitor records.
- **Attachments**: 📎 button in both the widget and the admin chat panel, images preview inline,
  other files show as a download link. 15MB cap per file, stored under `uploads/`.
- **My Account** (Admin → My Account): change your own name, email, or password (old password
  required to set a new one).
- **Mobile PWA**: the admin dashboard is installable on a phone home screen (Add to Home Screen /
  Install App), works full-screen, and registers a service worker for offline app-shell caching.
- **Push notifications**: agents can tap "Enable notifications" once; after that they get a phone/
  browser push when a new chat lands in the queue or gets assigned to them — even if the admin tab
  isn't open. Requires HTTPS in production (see the deployment guide).
- **Server deployment guide**: see `DEPLOYMENT-GUIDE-HINGLISH.md` for step-by-step VPS + domain +
  SSL setup instructions in Hinglish.


## Suggested next steps, roughly in priority order

1. Harden auth (password reset, rate limiting) and lock down RBAC on every route.
2. Add canned replies + tags + conversation transfer between agents — high-value, low-effort.
3. Move to Postgres + Redis (Socket.IO Redis adapter) once you need more than one server process.
4. Build out Reports/Analytics and audit logging.
5. File attachments (S3-compatible storage) and the knowledge base + AI-suggested replies.

Happy to build out any of these next — just say which one.
