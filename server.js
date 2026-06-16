import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4567;
const JWT_SECRET = process.env.JWT_SECRET || randomUUID();
const DATA_DIR = join(__dirname, '.data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── User Store ───
const USERS_FILE = join(DATA_DIR, 'users.json');

function loadUsers() {
  if (existsSync(USERS_FILE)) return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  return {};
}

function saveUsers(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Seed initial user
let users = loadUsers();
if (Object.keys(users).length === 0) {
  const hash = bcrypt.hashSync('tmuxremote', 10);
  users['admin'] = { passwordHash: hash, created: new Date().toISOString() };
  saveUsers(users);
  console.log('🔑 Seeded initial user: admin / tmuxremote');
}

// ─── Session Store ───
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

function loadSessions() {
  if (existsSync(SESSIONS_FILE)) return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  return { tabs: [] };
}

function saveSessionStore(store) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

// ─── Express App ───
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, 'public')));
app.use('/node_modules', express.static(join(__dirname, 'node_modules')));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, username, token });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// Tab/session management
app.get('/api/tabs', authMiddleware, (req, res) => {
  const store = loadSessions();
  res.json(store.tabs);
});

app.post('/api/tabs', authMiddleware, (req, res) => {
  const { name } = req.body;
  const id = randomUUID().slice(0, 8);
  const tmuxSession = `tmuxremote-${id}`;
  const store = loadSessions();
  const tab = { id, name: name || `Tab ${store.tabs.length + 1}`, tmuxSession, created: new Date().toISOString() };
  store.tabs.push(tab);
  saveSessionStore(store);
  res.json(tab);
});

app.put('/api/tabs/:id', authMiddleware, (req, res) => {
  const { name } = req.body;
  const store = loadSessions();
  const tab = store.tabs.find(t => t.id === req.params.id);
  if (!tab) return res.status(404).json({ error: 'Tab not found' });
  if (name) tab.name = name;
  saveSessionStore(store);
  res.json(tab);
});

app.delete('/api/tabs/:id', authMiddleware, (req, res) => {
  const store = loadSessions();
  const idx = store.tabs.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Tab not found' });
  const tab = store.tabs[idx];
  // Kill the tmux session
  try {
    const p = pty.spawn('tmux', ['kill-session', '-t', tab.tmuxSession], { name: 'xterm-256color', cols: 80, rows: 24 });
    p.onExit(() => {});
  } catch {}
  store.tabs.splice(idx, 1);
  saveSessionStore(store);
  res.json({ ok: true });
});

// ─── HTTP + WebSocket Server ───
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track active PTYs per tmux session
const activePtys = new Map();

function getOrCreatePty(tmuxSession, cols = 120, rows = 30) {
  const key = tmuxSession;
  if (activePtys.has(key)) {
    const existing = activePtys.get(key);
    try { existing.resize(cols, rows); } catch {}
    return existing;
  }

  // tmux -A = attach if session exists, create if not
  const args = ['new-session', '-A', '-s', tmuxSession];
  const term = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || '/root',
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  activePtys.set(key, term);
  term.onExit(() => {
    activePtys.delete(key);
  });
  return term;
}

wss.on('connection', (ws, req) => {
  // Auth via query param
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) { ws.close(4001, 'No token'); return; }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'Invalid token');
    return;
  }

  const tmuxSession = url.searchParams.get('session');
  if (!tmuxSession) { ws.close(4002, 'No session'); return; }

  const cols = parseInt(url.searchParams.get('cols')) || 120;
  const rows = parseInt(url.searchParams.get('rows')) || 30;

  const term = getOrCreatePty(tmuxSession, cols, rows);

  // Forward PTY output to WS
  const dataHandler = term.onData(data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  // Forward WS input to PTY
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'resize') {
        try { term.resize(msg.cols, msg.rows); } catch {}
      }
    } catch {}
  });

  ws.on('close', () => {
    dataHandler.dispose();
    // Don't kill the PTY — that's the whole point (tmux persistence)
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🖥️  tmuxremote running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 Default login: admin / tmuxremote\n`);
});
