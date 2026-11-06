// Library Management System — zero-dependency Node server.
// Serves the web app, stores data in a JSON file, and enforces sign-in and roles.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC = path.join(__dirname, 'public');
const DATA_COLS = ['books', 'members', 'loans', 'reservations'];
const SESSION_SHORT = 12 * 3600e3;      // "keep me signed in" off
const SESSION_LONG = 30 * 24 * 3600e3;  // "keep me signed in" on

fs.mkdirSync(BACKUP_DIR, { recursive: true });

let state = { app: 'library-management', settings: null, users: {}, books: {}, members: {}, loans: {}, reservations: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = { ...state, ...d, app: 'library-management' };
  state.users = state.users || {};
  console.log(`Loaded ${Object.keys(state.books).length} books, ${Object.keys(state.members).length} members, ${Object.keys(state.users).length} staff accounts.`);
} catch (e) { console.log('No existing data — starting a fresh library. Open the app to create the administrator account.'); }

/* ---------- persistence ---------- */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, DATA_FILE); }, 150);
}
function dailyBackup() {
  if (!fs.existsSync(DATA_FILE)) return;
  const name = path.join(BACKUP_DIR, `library-${new Date().toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(name)) fs.copyFileSync(DATA_FILE, name);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  files.slice(0, Math.max(0, files.length - 14)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}
dailyBackup(); setInterval(dailyBackup, 6 * 3600e3);

/* ---------- passwords (same scheme as the browser app, so backups move between versions) ---------- */
function hashPw(pw, salt) { let h = salt + ':' + pw; for (let i = 0; i < 2000; i++) h = crypto.createHash('sha256').update(h + salt).digest('hex'); return h; }
function pwFields(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { pwSalt: salt, pwHash: hashPw(pw, salt) }; }
function checkPw(rec, pw) {
  if (!rec || !rec.pwHash || !rec.pwSalt) return false;
  const a = Buffer.from(hashPw(String(pw), rec.pwSalt)), b = Buffer.from(rec.pwHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Emergency admin reset: LMS_RESET_ADMIN=newpassword (username "admin", or LMS_RESET_USER)
if (process.env.LMS_RESET_ADMIN) {
  const uname = (process.env.LMS_RESET_USER || 'admin').toLowerCase();
  let u = Object.values(state.users).find(x => (x.username || '').toLowerCase() === uname);
  if (!u) { u = { id: crypto.randomUUID(), username: uname, name: 'Administrator', createdAt: new Date().toISOString() }; }
  state.users[u.id] = { ...u, role: 'admin', active: true, ...pwFields(process.env.LMS_RESET_ADMIN) };
  save(); console.log(`⚠️  Password for "${uname}" was reset from LMS_RESET_ADMIN. Remove that variable and restart.`);
}

/* ---------- sessions ---------- */
const sessions = new Map(); // token -> {kind, id, exp}
const failures = new Map(); // ip -> {n, until}
function newSession(kind, id, remember) { const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, { kind, id, exp: Date.now() + (remember ? SESSION_LONG : SESSION_SHORT) }); return t; }
setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t); }, 3600e3);
function principalOf(s) {
  if (!s) return null;
  if (s.kind === 'staff') { const u = state.users[s.id]; return u && u.active !== false ? { kind: 'staff', id: u.id, role: u.role === 'admin' ? 'admin' : 'librarian', name: u.name || u.username } : null; }
  const m = state.members[s.id]; return m && m.pwHash && m.status !== 'Suspended' ? { kind: 'member', id: m.id, role: 'member', name: m.name } : null;
}
function auth(req) {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) return null;
  const t = h.slice(7), s = sessions.get(t); if (!s || s.exp < Date.now()) { sessions.delete(t); return null; }
  const p = principalOf(s); if (!p) { sessions.delete(t); return null; } p.token = t; return p;
}
const needsSetup = () => !Object.values(state.users).some(u => u.role === 'admin' && u.active !== false);
const activeAdmins = except => Object.values(state.users).filter(u => u.role === 'admin' && u.active !== false && u.id !== except).length;

/* ---------- views of the data ---------- */
const stripSecrets = o => { const c = { ...o }; const has = !!c.pwHash; delete c.pwHash; delete c.pwSalt; delete c.password; return [c, has]; };
function memberPublic(m) { const [c, has] = stripSecrets(m); c.hasPortal = has; return c; }
function bookStats(bid) {
  const onLoan = Object.values(state.loans).filter(l => l.bookId === bid && !l.returnedAt).length;
  const hs = Object.values(state.reservations).filter(h => h.bookId === bid);
  return { onLoan, ready: hs.filter(h => h.status === 'ready').length, waiting: hs.filter(h => h.status === 'waiting').length };
}
function stateFor(p) {
  const out = { app: 'library-management', settings: state.settings };
  if (p.kind === 'staff') {
    DATA_COLS.forEach(c => out[c] = state[c]);
    out.members = Object.fromEntries(Object.entries(state.members).map(([k, m]) => [k, memberPublic(m)]));
    out.users = p.role === 'admin' ? Object.fromEntries(Object.entries(state.users).map(([k, u]) => [k, stripSecrets(u)[0]])) : {};
    return out;
  }
  // Members see the catalog (with availability counts) and only their own records.
  out.books = Object.fromEntries(Object.entries(state.books).map(([k, b]) => [k, { ...b, _stats: bookStats(k) }]));
  out.members = { [p.id]: memberPublic(state.members[p.id]) };
  out.loans = Object.fromEntries(Object.entries(state.loans).filter(([, l]) => l.memberId === p.id));
  out.reservations = Object.fromEntries(Object.entries(state.reservations).filter(([, h]) => h.memberId === p.id));
  out.users = {};
  return out;
}
function promote(bid) {
  const b = state.books[bid]; if (!b) return;
  const st = bookStats(bid); let free = (Number(b.copies) || 0) - st.onLoan - st.ready;
  Object.values(state.reservations).filter(h => h.bookId === bid && h.status === 'waiting').sort((a, c) => a.createdAt < c.createdAt ? -1 : 1)
    .forEach(h => { if (free > 0) { state.reservations[h.id] = { ...h, status: 'ready', readyAt: new Date().toISOString() }; free--; } });
}
function clean(body) { const o = {}; for (const [k, v] of Object.entries(body)) if (!k.startsWith('_') && k !== 'hasPortal') o[k] = v; return o; }

/* ---------- http helpers ---------- */
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
}
const validId = id => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id);
const validUser = u => /^[A-Za-z0-9._-]{3,32}$/.test(u || '');
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/status') return send(res, 200, { app: 'library-management', needsSetup: needsSetup(), libraryName: state.settings?.libraryName || 'Library' });

    if (p === '/api/setup' && req.method === 'POST') {
      if (!needsSetup()) return send(res, 403, { error: 'This library is already set up. Please sign in.' });
      const b = await readBody(req);
      if (!validUser(b.username)) return send(res, 400, { error: 'Username must be 3–32 letters, numbers, dots, dashes or underscores.' });
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' });
      const u = { id: crypto.randomUUID(), username: b.username, name: String(b.name || b.username).slice(0, 100), role: 'admin', active: true, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString(), ...pwFields(b.password) };
      state.users[u.id] = u; state.settings = { ...(state.settings || {}), libraryName: String(b.libraryName || 'My Library').slice(0, 120) }; save();
      return send(res, 200, { token: newSession('staff', u.id, true), user: principalOf({ kind: 'staff', id: u.id }) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = ipOf(req), f = failures.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
      const b = await readBody(req); const name = String(b.username || '').trim().toLowerCase();
      let rec = null, kind = b.kind === 'member' ? 'member' : 'staff';
      if (kind === 'staff') rec = Object.values(state.users).find(u => (u.username || '').toLowerCase() === name && u.active !== false);
      else rec = Object.values(state.members).find(m => (m.code || '').toLowerCase() === name) || Object.values(state.members).find(m => m.email && m.email.toLowerCase() === name);
      if (!checkPw(rec, b.password)) {
        const n = (f && f.until <= Date.now() ? 0 : (f?.n || 0)) + 1; failures.set(ip, { n, until: n >= 8 ? Date.now() + 5 * 60e3 : 0 });
        return send(res, 401, { error: kind === 'staff' ? 'Wrong username or password.' : 'Wrong member ID or password — or no portal password has been set for this member yet.' });
      }
      failures.delete(ip);
      if (kind === 'member' && rec.status === 'Suspended') return send(res, 403, { error: 'Your membership is suspended — please contact the library.' });
      if (kind === 'staff') { state.users[rec.id] = { ...rec, lastLoginAt: new Date().toISOString() }; save(); }
      return send(res, 200, { token: newSession(kind, rec.id, !!b.remember), user: principalOf({ kind, id: rec.id }) });
    }

    const me = auth(req);
    if (!me) return send(res, 401, { error: 'Please sign in.' });
    if (p === '/api/logout' && req.method === 'POST') { sessions.delete(me.token); return send(res, 200, { ok: true }); }
    if (p === '/api/me') { const { token, ...u } = me; return send(res, 200, { user: u }); }
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, stateFor(me));

    if (p === '/api/password' && req.method === 'POST') {
      const b = await readBody(req); const col = me.kind === 'staff' ? 'users' : 'members'; const rec = state[col][me.id];
      if (!checkPw(rec, b.current)) return send(res, 400, { error: 'Current password is wrong.' });
      if (String(b.next || '').length < 6) return send(res, 400, { error: 'New password must be at least 6 characters.' });
      state[col][me.id] = { ...rec, ...pwFields(b.next) }; save();
      for (const [t, s] of sessions) if (s.kind === me.kind && s.id === me.id && t !== me.token) sessions.delete(t); // sign out other devices
      return send(res, 200, { ok: true });
    }

    if (p === '/api/settings' && req.method === 'PUT') {
      if (me.role !== 'admin') return send(res, 403, { error: 'Only administrators can change settings.' });
      const b = await readBody(req); if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'bad body' });
      state.settings = b; save(); return send(res, 200, { ok: true });
    }

    const m = p.match(/^\/api\/(books|members|loans|reservations|users)\/([^/]+)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const col = m[1], id = decodeURIComponent(m[2]);
    if (!validId(id)) return send(res, 400, { error: 'bad id' });
    if (req.method !== 'PUT' && req.method !== 'DELETE') return send(res, 405, { error: 'method not allowed' });
    const body = req.method === 'PUT' ? await readBody(req) : null;
    if (body && (typeof body !== 'object' || Array.isArray(body))) return send(res, 400, { error: 'bad body' });

    /* members (portal users) may only create or cancel their own reservations */
    if (me.kind === 'member') {
      if (col !== 'reservations' || req.method !== 'PUT') return send(res, 403, { error: 'Not allowed.' });
      const ex = state.reservations[id];
      if (ex) {
        if (ex.memberId !== me.id || body.status !== 'cancelled' || !['waiting', 'ready'].includes(ex.status)) return send(res, 403, { error: 'Not allowed.' });
        state.reservations[id] = { ...ex, status: 'cancelled', closedAt: new Date().toISOString() };
        if (ex.status === 'ready') promote(ex.bookId); save(); return send(res, 200, { ok: true });
      }
      const mem = state.members[me.id], book = state.books[body.bookId];
      if (!book) return send(res, 400, { error: 'Book not found.' });
      if (mem.expiresAt && new Date(mem.expiresAt) < new Date(new Date().toDateString())) return send(res, 403, { error: 'Your membership has expired.' });
      if (Object.values(state.reservations).some(h => h.memberId === me.id && h.bookId === book.id && ['waiting', 'ready'].includes(h.status))) return send(res, 400, { error: 'You already reserved this book.' });
      if (Object.values(state.loans).some(l => l.memberId === me.id && l.bookId === book.id && !l.returnedAt)) return send(res, 400, { error: 'You already have this book.' });
      const st = bookStats(book.id), free = (Number(book.copies) || 0) - st.onLoan - st.ready, now = new Date().toISOString();
      state.reservations[id] = { id, bookId: book.id, memberId: me.id, createdAt: now, ...(free > 0 && !st.waiting ? { status: 'ready', readyAt: now } : { status: 'waiting' }) };
      save(); return send(res, 200, { ok: true });
    }

    /* staff accounts: administrators only */
    if (col === 'users') {
      if (me.role !== 'admin') return send(res, 403, { error: 'Only administrators can manage staff accounts.' });
      const ex = state.users[id];
      if (req.method === 'DELETE') {
        if (id === me.id) return send(res, 400, { error: 'You can’t delete your own account.' });
        if (ex && ex.role === 'admin' && !activeAdmins(id)) return send(res, 400, { error: 'You need at least one active administrator.' });
        delete state.users[id]; for (const [t, s] of sessions) if (s.kind === 'staff' && s.id === id) sessions.delete(t);
        save(); return send(res, 200, { ok: true });
      }
      const imported = body.pwHash && body.pwSalt && !body.password ? { pwHash: String(body.pwHash), pwSalt: String(body.pwSalt) } : null; // restoring a backup
      const u = clean(body); delete u.pwHash; delete u.pwSalt;
      if (!validUser(u.username)) return send(res, 400, { error: 'Username must be 3–32 letters, numbers, dots, dashes or underscores.' });
      if (Object.values(state.users).some(x => x.id !== id && (x.username || '').toLowerCase() === u.username.toLowerCase())) return send(res, 400, { error: 'That username is taken.' });
      u.role = u.role === 'admin' ? 'admin' : 'librarian'; u.active = u.active !== false;
      if (id === me.id) { u.role = 'admin'; u.active = true; }
      if (ex && ex.role === 'admin' && (u.role !== 'admin' || !u.active) && !activeAdmins(id)) return send(res, 400, { error: 'You need at least one active administrator.' });
      const pw = u.password; delete u.password;
      if (!ex && !pw && !imported) return send(res, 400, { error: 'A password is required.' });
      if (pw && String(pw).length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' });
      state.users[id] = { ...(ex || {}), ...u, id, ...(pw ? pwFields(pw) : (!ex && imported ? imported : {})) };
      if (pw || !u.active) for (const [t, s] of sessions) if (s.kind === 'staff' && s.id === id && t !== me.token) sessions.delete(t);
      save(); return send(res, 200, { ok: true });
    }

    /* library data: administrators and librarians */
    if (req.method === 'DELETE') { delete state[col][id]; save(); return send(res, 200, { ok: true }); }
    const o = clean(body);
    if (col === 'members') {
      const ex = state.members[id] || {}; const pw = o.password; const imported = !ex.pwHash && o.pwHash && o.pwSalt ? { pwHash: String(o.pwHash), pwSalt: String(o.pwSalt) } : null;
      delete o.password; delete o.pwHash; delete o.pwSalt; if (imported) Object.assign(ex, imported);
      if (pw && String(pw).length < 6) return send(res, 400, { error: 'Portal password must be at least 6 characters.' });
      state.members[id] = { ...o, id, ...(pw ? pwFields(pw) : (ex.pwHash ? { pwHash: ex.pwHash, pwSalt: ex.pwSalt } : {})) };
    } else state[col][id] = { ...o, id };
    save(); return send(res, 200, { ok: true });
  } catch (e) {
    console.error(e); return send(res, 500, { error: 'server error' });
  }
});

function serveStatic(p, res) {
  let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  return send(res, 200, fs.readFileSync(file), types[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

server.listen(PORT, () => console.log(`📚 Library Management System running on http://localhost:${PORT}`));
const shutdown = () => { clearTimeout(saveTimer); try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) {} process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
