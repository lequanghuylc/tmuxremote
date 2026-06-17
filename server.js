import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, rmdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { readdir, stat, readFile, writeFile, mkdir, unlink, rename, rm } from 'fs/promises';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4567;
const JWT_SECRET = process.env.JWT_SECRET || randomUUID();
const DATA_DIR = join(__dirname, '.data');
const DEFAULT_USERNAME = process.env.DEFAULT_USERNAME || 'admin';
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'tmuxremote';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const FIREBASE_WEB_CONFIG = process.env.FIREBASE_WEB_CONFIG || '';
const EMAIL_WHITELIST = process.env.EMAIL_WHITELIST || '';
const FIREBASE_ENABLED = !!FIREBASE_SERVICE_ACCOUNT;

// ─── Firebase Admin Init ───
let firebaseApp = null;
if (FIREBASE_ENABLED) {
  try {
    const serviceAccount = JSON.parse(readFileSync(FIREBASE_SERVICE_ACCOUNT, 'utf8'));
    firebaseApp = admin.initializeApp({
      credential: admin.cert(serviceAccount),
    });
    console.log('🔥 Firebase Authentication enabled');
    if (EMAIL_WHITELIST) {
      console.log(`📧 Email whitelist: ${EMAIL_WHITELIST}`);
    }
  } catch (err) {
    console.error('❌ Failed to initialize Firebase:', err.message);
    process.exit(1);
  }
}

function isEmailAllowed(email) {
  if (!EMAIL_WHITELIST) return true; // no whitelist = allow all
  const allowed = EMAIL_WHITELIST.split(',').map(e => e.trim().toLowerCase());
  return allowed.includes(email.toLowerCase());
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Favorites Store ───
const FAVS_FILE = join(DATA_DIR, 'favorites.json');
function loadFavorites() {
  if (existsSync(FAVS_FILE)) return JSON.parse(readFileSync(FAVS_FILE, 'utf8'));
  return [];
}
function saveFavorites(favs) {
  writeFileSync(FAVS_FILE, JSON.stringify(favs, null, 2));
}

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
  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  users[DEFAULT_USERNAME] = { passwordHash: hash, created: new Date().toISOString() };
  saveUsers(users);
  console.log(`🔑 Seeded initial user: ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}`);
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

// Config endpoint (public) — tells client which auth mode to use
app.get('/api/config', (req, res) => {
  const config = { authMode: FIREBASE_ENABLED ? 'firebase' : 'password' };
  if (FIREBASE_ENABLED && FIREBASE_WEB_CONFIG) {
    try {
      config.firebaseConfig = JSON.parse(FIREBASE_WEB_CONFIG);
    } catch {}
  }
  res.json(config);
});

// Auth routes
app.post('/api/login', (req, res) => {
  if (FIREBASE_ENABLED) {
    return res.status(403).json({ error: 'Password login disabled. Use Google sign-in.' });
  }
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

// Firebase Google auth
if (FIREBASE_ENABLED) {
  app.post('/api/auth/firebase', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Missing idToken' });
    try {
      const decoded = await firebaseApp.auth().verifyIdToken(idToken);
      const { email, name, picture } = decoded;
      if (!email) return res.status(401).json({ error: 'No email in token' });
      if (!isEmailAllowed(email)) {
        return res.status(403).json({ error: `Email ${email} is not allowed` });
      }
      const username = email.split('@')[0];
      const token = jwt.sign({ username, email, name, picture }, JWT_SECRET, { expiresIn: '7d' });
      res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      res.json({ ok: true, username, email, token });
    } catch (err) {
      res.status(401).json({ error: 'Invalid token: ' + err.message });
    }
  });
}

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// Tab/session management
app.get('/api/tabs', authMiddleware, (req, res) => {
  const store = loadSessions();
  res.json(store.tabs);
});

app.post('/api/tabs', authMiddleware, (req, res) => {
  const { name, type, filePath } = req.body;
  const id = randomUUID().slice(0, 8);
  const store = loadSessions();

  if (type === 'editor' && filePath) {
    // Editor tab
    const tab = { id, name: name || basename(filePath), type: 'editor', filePath, created: new Date().toISOString() };
    store.tabs.push(tab);
    saveSessionStore(store);
    return res.json(tab);
  }

  // Terminal tab (default)
  const tmuxSession = `tmuxremote-${id}`;
  const tab = { id, name: name || `Tab ${store.tabs.length + 1}`, type: 'terminal', tmuxSession, created: new Date().toISOString() };
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
  // Kill tmux session only for terminal tabs
  if (tab.type === 'terminal' && tab.tmuxSession) {
    try {
      const p = pty.spawn('tmux', ['kill-session', '-t', tab.tmuxSession], { name: 'xterm-256color', cols: 80, rows: 24 });
      p.onExit(() => {});
    } catch {}
  }
  store.tabs.splice(idx, 1);
  saveSessionStore(store);
  res.json({ ok: true });
});

// ─── Filesystem API ───
app.get('/api/fs/ls', authMiddleware, async (req, res) => {
  const dirPath = req.query.path || '/';
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = join(dirPath, entry.name);
      let size = 0;
      try {
        const s = await stat(fullPath);
        size = s.size;
      } catch {}
      return {
        name: entry.name,
        path: fullPath,
        isDir: entry.isDirectory(),
        isSymLink: entry.isSymbolicLink(),
        size,
      };
    }));
    // Sort: dirs first, then by name
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json(items);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Read file content
app.get('/api/fs/read', authMiddleware, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const content = await readFile(filePath, 'utf8');
    const s = await stat(filePath);
    res.json({ content, size: s.size, path: filePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Write file content
app.post('/api/fs/write', authMiddleware, async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    await writeFile(filePath, content, 'utf8');
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rename file/folder
app.post('/api/fs/rename', authMiddleware, async (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
  try {
    await rename(oldPath, newPath);
    res.json({ ok: true, oldPath, newPath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete file/folder
app.delete('/api/fs/delete', authMiddleware, async (req, res) => {
  const filePath = req.body.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      await rm(filePath, { recursive: true, force: true });
    } else {
      await unlink(filePath);
    }
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create directory
app.post('/api/fs/mkdir', authMiddleware, async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  try {
    await mkdir(dirPath, { recursive: true });
    res.json({ ok: true, path: dirPath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create empty file
app.post('/api/fs/touch', authMiddleware, async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    await writeFile(filePath, '', { flag: 'a' }); // append nothing = touch
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Favorites API ───
app.get('/api/favorites', authMiddleware, (req, res) => {
  res.json(loadFavorites());
});

app.post('/api/favorites', authMiddleware, (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'path required' });
  const favs = loadFavorites();
  if (!favs.includes(path)) {
    favs.push(path);
    saveFavorites(favs);
  }
  res.json(favs);
});

app.delete('/api/favorites', authMiddleware, (req, res) => {
  const { path } = req.body;
  let favs = loadFavorites();
  favs = favs.filter(f => f !== path);
  saveFavorites(favs);
  res.json(favs);
});

// ─── Git API ───
app.get('/api/git/log', authMiddleware, (req, res) => {
  const repoPath = req.query.path;
  if (!repoPath) return res.status(400).json({ error: 'path required' });
  try {
    const gitDir = join(repoPath, '.git');
    if (!existsSync(gitDir)) return res.json({ commits: [], error: 'Not a git repo' });
    const log = execSync(
      'git log --all --oneline --decorate --graph -50 --format="%h|%s|%an|%ar|%D"',
      { cwd: repoPath, timeout: 5000, encoding: 'utf8' }
    );
    const commits = log.trim().split('\n').map(line => {
      const parts = line.split('|');
      // The graph chars are before the hash
      const graphMatch = line.match(/^([^a-f0-9]*)([a-f0-9]+)\|/);
      const graph = graphMatch ? graphMatch[1] : '';
      return {
        graph,
        hash: parts[0]?.replace(/[^a-f0-9]/g, '') || '',
        message: parts[1] || '',
        author: parts[2] || '',
        date: parts[3] || '',
        refs: parts[4] || '',
        raw: line,
      };
    }).filter(c => c.hash || c.graph);
    res.json({ commits });
  } catch (err) {
    res.json({ commits: [], error: err.message });
  }
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
  if (FIREBASE_ENABLED) {
    console.log(`🔥 Auth: Firebase Google Sign-In`);
  } else {
    console.log(`🔑 Auth: ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}`);
  }
  console.log('');
});
