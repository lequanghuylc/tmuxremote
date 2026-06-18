import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { loadSettings, saveSettings, renderSettingsPanel, DEFAULT_SETTINGS } from './settings.js';

// ─── State ───
let currentUser = null;
let tabs = [];
let activeTabId = null;
let terminals = {};  // { tabId: { terminal, fitAddon, ws, container, fontSize } }
let editors = {};    // { tabId: { monaco, model, filePath, saveTimer, container } }
let activeModifiers = new Set();
let currentFontSize = 14;
let settings = loadSettings();

// ─── Token ───
function getToken() {
  return sessionStorage.getItem('tmuxremote_token') || '';
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' };
}

// ─── Auth ───
async function checkAuth() {
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + getToken() } });
    if (!res.ok) throw new Error();
    const data = await res.json();
    currentUser = data.username;
    document.getElementById('userLabel').textContent = currentUser;
  } catch {
    sessionStorage.removeItem('tmuxremote_token');
    location.href = '/index.html';
  }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  sessionStorage.removeItem('tmuxremote_token');
  location.href = '/index.html';
});

// ─── Tab Management ───
async function loadTabs() {
  const res = await fetch('/api/tabs', { headers: { 'Authorization': 'Bearer ' + getToken() } });
  tabs = await res.json();
  renderTabs();
  if (tabs.length > 0 && !activeTabId) {
    switchTab(tabs[0].id);
  } else if (tabs.length === 0) {
    showEmptyState();
  }
}

function renderTabs() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = `tab ${tab.id === activeTabId ? 'active' : ''}`;
    el.dataset.id = tab.id;
    let icon;
    if (tab.type === 'editor') icon = '<i class="lni lni-pencil-1"></i>';
    else if (tab.type === 'image') icon = '<i class="lni lni-image"></i>';
    else if (tab.type === 'pdf') icon = '<i class="lni lni-file-multiple"></i>';
    else if (tab.type === 'settings') icon = '<i class="lni lni-cog"></i>';
    else icon = '<i class="lni lni-monitor-code"></i>';
    el.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-name" title="Double-click to rename">${escHtml(tab.name)}</span>
      <span class="tab-close" title="Close tab">×</span>
    `;
    el.querySelector('.tab-name').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      showRenameModal(tab.id);
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.addEventListener('click', () => switchTab(tab.id));
    container.appendChild(el);
  });
}

// ─── Rename Modal (replaces inline input) ───
function showRenameModal(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  document.querySelectorAll('.modal-overlay').forEach(m => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Rename Tab</h2>
      <input type="text" id="renameTabInput" value="${escHtml(tab.name)}" placeholder="Tab name">
      <div class="modal-actions">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-save" type="button">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#renameTabInput');
  const cancelBtn = overlay.querySelector('.btn-cancel');
  const saveBtn = overlay.querySelector('.btn-save');

  requestAnimationFrame(() => { input.focus(); input.select(); });

  function closeModal() { overlay.remove(); }

  async function save() {
    const newName = input.value.trim() || tab.name;

    // If editor tab, rename the actual file too
    if (tab.type === 'editor' && tab.filePath) {
      const dir = tab.filePath.substring(0, tab.filePath.lastIndexOf('/'));
      const newPath = dir + '/' + newName;
      if (newPath !== tab.filePath) {
        try {
          await fetch('/api/fs/rename', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ oldPath: tab.filePath, newPath }),
          });
          tab.filePath = newPath;
          // Update editor state
          if (editors[tabId]) editors[tabId].filePath = newPath;
        } catch {}
        renderFileTree();
      }
    }

    tab.name = newName;
    await fetch(`/api/tabs/${tabId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: newName }),
    });
    renderTabs();
    closeModal();
  }

  cancelBtn.addEventListener('click', closeModal);
  saveBtn.addEventListener('click', save);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') closeModal();
  });
}

async function createTab(name) {
  const res = await fetch('/api/tabs', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
  const tab = await res.json();
  tabs.push(tab);
  renderTabs();
  switchTab(tab.id);
}

async function closeTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Smart confirm based on tab type
  if (tab.type === 'terminal') {
    // Only confirm if terminal has recent activity (something likely running)
    const term = terminals[tabId];
    if (term && Date.now() - term.lastActivity < 2000) {
      if (!confirm('A process may still be running. Close this terminal tab?')) return;
    }
  } else if (tab.type === 'editor') {
    // Only confirm if file has unsaved changes
    const editor = editors[tabId];
    if (editor && editor.dirty) {
      if (!confirm('You have unsaved changes. Close without saving?')) return;
    }
  }
  // image, pdf, settings: no confirm

  await fetch(`/api/tabs/${tabId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + getToken() } });
  tabs = tabs.filter(t => t.id !== tabId);

  // Clean up terminal
  if (terminals[tabId]) {
    terminals[tabId].ws?.close();
    terminals[tabId].terminal.dispose();
    terminals[tabId].container.remove();
    delete terminals[tabId];
  }

  // Clean up editor
  if (editors[tabId]) {
    editors[tabId].model?.dispose();
    editors[tabId].monaco?.dispose();
    editors[tabId].container?.remove();
    delete editors[tabId];
  }

  // Clean up settings/image/pdf containers
  const settingsEl = document.getElementById(`settings-${tabId}`);
  if (settingsEl) settingsEl.remove();
  const imageEl = document.getElementById(`image-${tabId}`);
  if (imageEl) imageEl.remove();
  const pdfEl = document.getElementById(`pdf-${tabId}`);
  if (pdfEl) pdfEl.remove();

  if (activeTabId === tabId) {
    activeTabId = null;
    if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id);
    else showEmptyState();
  }
  renderTabs();
}

function switchTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  activeTabId = tabId;
  renderTabs();
  hideEmptyState();

  // Hide all panels
  document.querySelectorAll('.tab-terminal, .tab-editor, .tab-settings, .tab-image, .tab-pdf').forEach(el => el.classList.remove('active'));

  if (tab?.type === 'editor') {
    if (editors[tabId]) {
      editors[tabId].container.classList.add('active');
      requestAnimationFrame(() => {
        editors[tabId].monaco.layout();
        editors[tabId].monaco.focus();
      });
    } else {
      initEditor(tabId);
    }
  } else if (tab?.type === 'settings') {
    showSettingsTab(tabId);
  } else if (tab?.type === 'image') {
    showImageTab(tabId);
  } else if (tab?.type === 'pdf') {
    showPdfTab(tabId);
  } else {
    // Terminal tab
    if (terminals[tabId]) {
      terminals[tabId].container.classList.add('active');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          terminals[tabId].fitAddon.fit();
          terminals[tabId].terminal.focus();
          const { ws, terminal } = terminals[tabId];
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          }
        });
      });
    } else {
      initTerminal(tabId);
    }
  }
}

function showEmptyState() {
  let empty = document.getElementById('emptyState');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'emptyState';
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="icon"><i class="lni lni-monitor-code"></i></div>
      <div>No terminal tabs open</div>
      <button id="emptyNewTab">+ New Tab</button>
    `;
    document.getElementById('terminalContainer').appendChild(empty);
    empty.querySelector('#emptyNewTab').addEventListener('click', showNewTabModal);
  }
  empty.style.display = 'flex';
}

function hideEmptyState() {
  const empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
}

// ─── Zoom ───
function zoomIn() { setZoom(currentFontSize + 1); }
function zoomOut() { setZoom(currentFontSize - 1); }
function zoomReset() { setZoom(14); }

function setZoom(size) {
  size = Math.max(4, Math.min(32, size));
  if (size === currentFontSize) return;
  currentFontSize = size;

  // Update all terminal instances
  for (const tabId in terminals) {
    const t = terminals[tabId];
    t.terminal.options.fontSize = size;
    // FitAddon will recalculate cols/rows based on new font size
    requestAnimationFrame(() => {
      t.fitAddon.fit();
      if (t.ws.readyState === WebSocket.OPEN) {
        t.ws.send(JSON.stringify({ type: 'resize', cols: t.terminal.cols, rows: t.terminal.rows }));
      }
    });
  }

  updateZoomLabel();
}

function updateZoomLabel() {
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = currentFontSize + 'px';
}

// ─── Terminal ───
function initTerminal(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  const container = document.createElement('div');
  container.className = 'tab-terminal active';
  container.id = `term-${tabId}`;
  document.getElementById('terminalContainer').appendChild(container);

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: currentFontSize,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Consolas', monospace",
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39d353',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d364',
      brightWhite: '#f0f6fc',
    },
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  // WebSocket connection
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cols = terminal.cols;
  const rows = terminal.rows;
  const token = getToken();
  const wsUrl = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&session=${encodeURIComponent(tab.tmuxSession)}&cols=${cols}&rows=${rows}`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'data') {
        terminal.write(msg.data);
        if (terminals[tabId]) terminals[tabId].lastActivity = Date.now();
      }
    } catch {}
  });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  });

  ws.addEventListener('close', (e) => {
    if (e.code === 4001 || e.code === 4002) {
      terminal.write('\r\n\x1b[31m[auth error — please log in again]\x1b[0m\r\n');
      sessionStorage.removeItem('tmuxremote_token');
      setTimeout(() => { location.href = '/index.html'; }, 2000);
    } else {
      terminal.write('\r\n\x1b[31m[disconnected from server]\x1b[0m\r\n');
    }
  });

  ws.addEventListener('error', () => {
    terminal.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
  });

  // Forward keystrokes to WS
  terminal.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  });
  resizeObserver.observe(container);

  terminals[tabId] = { terminal, fitAddon, ws, container, resizeObserver, lastActivity: 0 };

  setTimeout(() => terminal.focus(), 50);
}

// ─── Editor ───
const LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'javascriptreact', tsx: 'typescriptreact',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  py: 'python', rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  xml: 'xml', svg: 'xml',
  sql: 'sql', graphql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  conf: 'ini', cfg: 'ini', ini: 'ini', env: 'ini',
  txt: 'plaintext', log: 'plaintext', text: 'plaintext',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', dart: 'dart', lua: 'lua', r: 'r',
};

function getLanguageForFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const base = filePath.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANG_MAP[ext] || 'plaintext';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff']);
const PDF_EXTS = new Set(['pdf']);

function getFileType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'editor';
}

async function openFileInEditor(filePath) {
  // Check if already open
  const existingTab = tabs.find(t => (t.type === 'editor' || t.type === 'image' || t.type === 'pdf') && t.filePath === filePath);
  if (existingTab) {
    switchTab(existingTab.id);
    return;
  }

  const fileType = getFileType(filePath);
  const name = filePath.split('/').pop();
  const res = await fetch('/api/tabs', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type: fileType, filePath, name }),
  });
  const tab = await res.json();
  tabs.push(tab);
  renderTabs();
  switchTab(tab.id);
}

async function initEditor(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.filePath) return;

  const monaco = await window.monacoReady;

  const container = document.createElement('div');
  container.className = 'tab-editor active';
  container.id = `editor-${tabId}`;
  document.getElementById('terminalContainer').appendChild(container);

  // Load file content
  let content = '';
  try {
    const res = await fetch(`/api/fs/read?path=${encodeURIComponent(tab.filePath)}`, {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    if (res.ok) {
      const data = await res.json();
      content = data.content;
    }
  } catch {}

  const language = getLanguageForFile(tab.filePath);
  const model = monaco.editor.createModel(content, language);

  const statusBar = document.createElement('div');
  statusBar.className = 'editor-status';
  container.appendChild(statusBar);

  const editor = monaco.editor.create(container, {
    model,
    theme: 'vs-dark',
    automaticLayout: false,
    fontSize: settings.fontSize,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Consolas', monospace",
    minimap: { enabled: settings.minimap },
    scrollBeyondLastLine: false,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    tabSize: settings.tabSize,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    smoothScrolling: true,
    cursorBlinking: settings.cursorBlinking ? 'smooth' : 'solid',
    padding: { top: 8 },
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => editor.layout());
  resizeObserver.observe(container);

  // Ctrl+S / Cmd+S save (NO auto-save)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
    try {
      await fetch('/api/fs/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: tab.filePath, content: model.getValue() }),
      });
      if (editors[tabId]) editors[tabId].dirty = false;
      // Brief visual feedback
      const statusBar = container.querySelector('.editor-status');
      if (statusBar) {
        statusBar.textContent = '✓ Saved';
        statusBar.classList.add('saved');
        setTimeout(() => { statusBar.textContent = ''; statusBar.classList.remove('saved'); }, 2000);
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  });

  editors[tabId] = { monaco: editor, model, filePath: tab.filePath, container, resizeObserver, dirty: false };

  // Track unsaved changes
  model.onDidChangeContent(() => {
    if (editors[tabId]) editors[tabId].dirty = true;
  });

  setTimeout(() => editor.focus(), 50);
}

// ─── New Tab Modal ───
document.getElementById('addTabBtn').addEventListener('click', showNewTabModal);

function showNewTabModal() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>New Terminal Tab</h2>
      <input type="text" id="newTabName" placeholder="Tab name (optional)">
      <div class="modal-actions">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-create" type="button">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#newTabName');
  const cancelBtn = overlay.querySelector('.btn-cancel');
  const createBtn = overlay.querySelector('.btn-create');

  requestAnimationFrame(() => input.focus());

  function closeModal() { overlay.remove(); }

  cancelBtn.addEventListener('click', closeModal);
  createBtn.addEventListener('click', () => {
    createTab(input.value.trim());
    closeModal();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { createTab(input.value.trim()); closeModal(); }
    if (e.key === 'Escape') closeModal();
  });
}

// ─── Settings Tab ───
function showSettingsTab(tabId) {
  let container = document.getElementById(`settings-${tabId}`);
  if (!container) {
    container = document.createElement('div');
    container.className = 'tab-settings active';
    container.id = `settings-${tabId}`;
    document.getElementById('terminalContainer').appendChild(container);
    renderSettingsPanel(container, settings, (key, value) => {
      // Apply settings changes to existing editors/terminals
      if (key === 'fontSize') {
        for (const eid in editors) {
          editors[eid].monaco.updateOptions({ fontSize: value });
        }
        for (const tid in terminals) {
          terminals[tid].terminal.options.fontSize = value;
          requestAnimationFrame(() => {
            terminals[tid].fitAddon.fit();
          });
        }
      }
      if (key === 'wordWrap') {
        for (const eid in editors) {
          editors[eid].monaco.updateOptions({ wordWrap: value ? 'on' : 'off' });
        }
      }
      if (key === 'minimap') {
        for (const eid in editors) {
          editors[eid].monaco.updateOptions({ minimap: { enabled: value } });
        }
      }
      if (key === 'cursorBlinking') {
        for (const eid in editors) {
          editors[eid].monaco.updateOptions({ cursorBlinking: value ? 'smooth' : 'solid' });
        }
      }
      if (key === 'tabSize') {
        for (const eid in editors) {
          editors[eid].model.updateOptions({ tabSize: value });
        }
      }
    });
  }
  container.classList.add('active');
}

// ─── Image Tab ───
function showImageTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  let container = document.getElementById(`image-${tabId}`);
  if (!container) {
    container = document.createElement('div');
    container.className = 'tab-image active';
    container.id = `image-${tabId}`;
    const token = getToken();
    const imgUrl = `/api/fs/raw?path=${encodeURIComponent(tab.filePath)}&token=${encodeURIComponent(token)}`;
    container.innerHTML = `
      <div class="image-viewer">
        <img src="${imgUrl}" alt="${escHtml(tab.name)}" />
      </div>
    `;
    document.getElementById('terminalContainer').appendChild(container);
  }
  container.classList.add('active');
}

// ─── PDF Tab ───
function showPdfTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  let container = document.getElementById(`pdf-${tabId}`);
  if (!container) {
    container = document.createElement('div');
    container.className = 'tab-pdf active';
    container.id = `pdf-${tabId}`;
    const token = getToken();
    const pdfUrl = `/api/fs/raw?path=${encodeURIComponent(tab.filePath)}&token=${encodeURIComponent(token)}`;
    container.innerHTML = `
      <div class="pdf-viewer">
        <iframe src="${pdfUrl}" frameborder="0"></iframe>
      </div>
    `;
    document.getElementById('terminalContainer').appendChild(container);
  }
  container.classList.add('active');
}

// ─── Paste Modal (works on HTTP without Clipboard API) ───
function showPasteModal(term) {
  document.querySelectorAll('.modal-overlay').forEach(m => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Paste into terminal</h2>
      <textarea id="pasteArea" rows="6" placeholder="Paste text here..."></textarea>
      <div class="modal-actions">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-save" type="button">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const area = overlay.querySelector('#pasteArea');
  const cancelBtn = overlay.querySelector('.btn-cancel');
  const sendBtn = overlay.querySelector('.btn-save');

  requestAnimationFrame(() => area.focus());

  function close() { overlay.remove(); term.terminal.focus(); }

  cancelBtn.addEventListener('click', close);
  // Delay close-on-overlay-click so the triggering pointerdown/click doesn't immediately close it
  setTimeout(() => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }, 100);

  sendBtn.addEventListener('click', () => {
    const text = area.value;
    if (text && term.ws.readyState === WebSocket.OPEN) {
      term.ws.send(JSON.stringify({ type: 'data', data: text }));
    }
    close();
  });

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    // Ctrl+Enter to send
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendBtn.click();
    }
  });
}

// ─── Mobile Keyboard ───

// Escape sequence map — JS strings interpret \x03, \x1b, \t properly (HTML attributes do NOT)
const SEQUENCES = {
  'ctrl-c':  '\x03',
  'ctrl-d':  '\x04',
  'ctrl-z':  '\x1a',
  'ctrl-a':  '\x01',
  'ctrl-e':  '\x05',
  'ctrl-l':  '\x0c',
  'ctrl-w':  '\x17',
  'ctrl-u':  '\x15',
  'ctrl-k':  '\x0b',
  'ctrl-r':  '\x12',
  'esc':      '\x1b',
  'tab':      '\t',
  'shift-tab': '\x1b[Z',
  'arrow-up':    '\x1b[A',
  'arrow-down':  '\x1b[B',
  'arrow-right': '\x1b[C',
  'arrow-left':  '\x1b[D',
  'home':    '\x1b[H',
  'end':     '\x1b[F',
  'pgup':    '\x1b[5~',
  'pgdn':    '\x1b[6~',
  'del':     '\x1b[3~',
  'ins':     '\x1b[2~',
  'backspace': '\x7f',
  'f1':  '\x1bOP',
  'f2':  '\x1bOQ',
  'f3':  '\x1bOR',
  'f4':  '\x1bOS',
  'f5':  '\x1b[15~',
  'f6':  '\x1b[17~',
  'f7':  '\x1b[18~',
  'f8':  '\x1b[19~',
  'f9':  '\x1b[20~',
  'f10': '\x1b[21~',
  'f11': '\x1b[23~',
  'f12': '\x1b[24~',
};

function clearModifiers() {
  activeModifiers.clear();
  document.querySelectorAll('.mod-key.active-mod').forEach(b => b.classList.remove('active-mod'));
}

function initMobileKeyboard() {
  const keyboard = document.getElementById('mobileKeyboard');
  const handle = document.getElementById('keyboardDragHandle');
  const dismissBtn = document.getElementById('dismissKeyboard');
  const showFab = document.getElementById('showKeyboardFab');
  const toggleBtn = document.getElementById('toggleKeyboard');
  const expandedRows = document.getElementById('keyboardRows');
  const compactRow = document.getElementById('keyboardCompact');

  // ── Expand / Collapse ──
  let isExpanded = false;

  toggleBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isExpanded = !isExpanded;
    expandedRows.style.display = isExpanded ? 'block' : 'none';
    toggleBtn.textContent = isExpanded ? '▴' : '▾';
  });

  // ── Dragging — persist position on release ──
  let isDragging = false;
  let startY = 0;
  let startBottom = 0;

  handle.addEventListener('touchstart', (e) => {
    isDragging = true;
    startY = e.touches[0].clientY;
    startBottom = parseInt(keyboard.style.bottom) || 0;
    keyboard.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const dy = startY - e.touches[0].clientY;
    keyboard.style.bottom = Math.max(0, startBottom + dy) + 'px';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    keyboard.style.transition = '';
  });

  // Mouse dragging (desktop / Cypress)
  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startBottom = parseInt(keyboard.style.bottom) || 0;
    keyboard.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dy = startY - e.clientY;
    keyboard.style.bottom = Math.max(0, startBottom + dy) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    keyboard.style.transition = '';
  });

  // ── Dismiss / Show ──
  dismissBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    keyboard.classList.add('dismissed');
    showFab.style.display = 'flex';
  });

  showFab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    keyboard.classList.remove('dismissed');
    keyboard.style.bottom = keyboard.style.bottom || '0px';
    showFab.style.display = 'none';
  });

  // ── Key handling ──
  document.querySelectorAll('.mod-key').forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const term = activeTabId && terminals[activeTabId];
      if (!term) return;

      // Modifier toggle (Ctrl, Alt, ⌘)
      if (btn.dataset.mod) {
        const mod = btn.dataset.mod;
        if (activeModifiers.has(mod)) {
          activeModifiers.delete(mod);
          btn.classList.remove('active-mod');
        } else {
          activeModifiers.add(mod);
          btn.classList.add('active-mod');
        }
        term.terminal.focus();
        return;
      }

      let data = '';

      // data-action: exact sequence from JS map (fixes \x03, \t, \x1b[A etc.)
      if (btn.dataset.action) {
        // Copy: xterm selection → clipboard (works on HTTP via textarea trick)
        if (btn.dataset.action === 'copy') {
          const sel = term.terminal.getSelection();
          if (sel) {
            const ta = document.createElement('textarea');
            ta.value = sel;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          clearModifiers();
          term.terminal.focus();
          return;
        }
        // Paste: show a textarea modal so user can Ctrl+V / paste and send
        if (btn.dataset.action === 'paste') {
          e.stopPropagation();
          showPasteModal(term);
          clearModifiers();
          return;
        }
        data = SEQUENCES[btn.dataset.action] || '';
      }
      // data-char: printable character, modifiers apply
      else if (btn.dataset.char) {
        data = btn.dataset.char;
        if (activeModifiers.has('ctrl') && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        }
        if (activeModifiers.has('alt') || activeModifiers.has('meta')) {
          data = '\x1b' + data;
        }
      }

      // Send
      if (data && term.ws.readyState === WebSocket.OPEN) {
        term.ws.send(JSON.stringify({ type: 'data', data }));
      }

      // Clear modifiers after keypress
      clearModifiers();
      term.terminal.focus();
    });
  });
}

// ─── Zoom Controls ───
document.getElementById('zoomInBtn').addEventListener('click', zoomIn);
document.getElementById('zoomOutBtn').addEventListener('click', zoomOut);
document.getElementById('zoomLabel').addEventListener('click', zoomReset);

// Keyboard shortcuts: Ctrl/Cmd + = / - / 0
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomIn();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault();
    zoomOut();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault();
    zoomReset();
  }
});

// Settings button
document.getElementById('settingsBtn').addEventListener('click', () => {
  // Check if settings tab already exists
  const existing = tabs.find(t => t.type === 'settings');
  if (existing) {
    switchTab(existing.id);
  } else {
    createSettingsTab();
  }
});

async function createSettingsTab() {
  const res = await fetch('/api/tabs', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type: 'settings', name: 'Settings' }),
  });
  const tab = await res.json();
  tabs.push(tab);
  renderTabs();
  switchTab(tab.id);
}

// ─── Helpers ───
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Sidebar ───
function initSidebar() {
  const burgerBtn = document.getElementById('burgerBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');

  // Burger menu (mobile)
  burgerBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });

  // Sidebar tab switching
  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(tab.dataset.panel + 'Panel').classList.add('active');
      // Refresh git graphs when switching to git tab
      if (tab.dataset.panel === 'git') loadGitGraphs();
    });
  });
}

// ─── Favorites State ───
let favorites = [];

async function loadFavorites() {
  const res = await fetch('/api/favorites', { headers: { 'Authorization': 'Bearer ' + getToken() } });
  favorites = await res.json();
}

async function addFavorite(path) {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ path }),
  });
  favorites = await res.json();
  renderFileTree();
}

async function removeFavorite(path) {
  const res = await fetch('/api/favorites', {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ path }),
  });
  favorites = await res.json();
  renderFileTree();
}

// ─── File Tree ───
let treeState = {}; // { path: { expanded: bool, children: [] } }

async function loadDir(path) {
  const res = await fetch(`/api/fs/ls?path=${encodeURIComponent(path)}`, {
    headers: { 'Authorization': 'Bearer ' + getToken() },
  });
  if (!res.ok) return [];
  return await res.json();
}

function renderFileTree() {
  const container = document.getElementById('fileTree');
  container.innerHTML = '';

  // Favorites section (if any)
  if (favorites.length > 0) {
    const section = document.createElement('div');
    section.className = 'tree-favorites-section';
    const label = document.createElement('div');
    label.className = 'tree-section-label';
    label.innerHTML = '<i class="lni lni-star-fat"></i> Favorites';
    section.appendChild(label);

    favorites.forEach(favPath => {
      const item = createTreeItem({
        name: favPath.split('/').filter(Boolean).pop() || '/',
        path: favPath,
        isDir: true,
        isFavorite: true,
      });
      section.appendChild(item);
    });
    container.appendChild(section);
  }

  // Root section
  const rootLabel = document.createElement('div');
  rootLabel.className = 'tree-section-label';
  rootLabel.innerHTML = '<i class="lni lni-database-2"></i> Root';
  container.appendChild(rootLabel);

  // Root node (auto-expand)
  if (!treeState['/']) {
    treeState['/'] = { expanded: false, children: [], loaded: false };
  }
  const rootItem = createTreeItem({ name: '/', path: '/', isDir: true });
  container.appendChild(rootItem);

  // Auto-expand root on first load — find the container and arrow from the rendered item
  if (!treeState['/'].loaded) {
    const rootRow = rootItem.querySelector('.tree-item');
    const rootArrow = rootRow.querySelector('.tree-arrow');
    const rootChildren = rootItem.querySelector('.tree-children');
    toggleTreeItem('/', rootChildren, rootArrow);
  }
}

function createTreeItem(entry) {
  const wrapper = document.createElement('div');

  const row = document.createElement('div');
  row.className = 'tree-item' + (entry.isFavorite ? ' favorite-item' : '');
  row.style.paddingLeft = (entry.path === '/' ? 8 : 0) + 'px';

  const arrow = document.createElement('span');
  arrow.className = 'tree-arrow' + (entry.isDir ? '' : ' hidden');
  arrow.innerHTML = '<i class="lni lni-angle-double-right"></i>';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  if (entry.isFavorite) {
    icon.innerHTML = '<i class="lni lni-star-fat"></i>';
  } else if (entry.isDir) {
    icon.innerHTML = '<i class="lni lni-folder-1"></i>';
  } else {
    icon.innerHTML = '<i class="lni lni-file-multiple"></i>';
  }

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;

  row.appendChild(arrow);
  row.appendChild(icon);
  row.appendChild(name);

  // Calculate indent level based on path depth
  const depth = entry.path === '/' ? 0 : entry.path.split('/').filter(Boolean).length;
  row.style.paddingLeft = (8 + depth * 16) + 'px';

  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'tree-children';

  // Expand/collapse on click (dirs only), open editor on click (files)
  if (entry.isDir) {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTreeItem(entry.path, childrenContainer, arrow);
    });
  } else {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInEditor(entry.path);
    });
  }

  // Context menu: right-click (desktop) or double-tap (mobile)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, entry.path);
  });

  let lastTap = 0;
  row.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      const touch = e.changedTouches[0];
      showContextMenu(touch.clientX, touch.clientY, entry.path);
    }
    lastTap = now;
  });

  // Update expanded state
  const state = treeState[entry.path];
  if (state && state.expanded) {
    arrow.classList.add('expanded');
    childrenContainer.classList.add('expanded');
    if (state.children && state.children.length > 0) {
      renderChildren(childrenContainer, entry.path);
    }
  }

  wrapper.appendChild(row);
  wrapper.appendChild(childrenContainer);
  return wrapper;
}

function renderChildren(container, parentPath) {
  container.innerHTML = '';
  const state = treeState[parentPath];
  if (!state || !state.children) return;

  state.children.forEach(child => {
    const item = createTreeItem(child);
    container.appendChild(item);
  });
}

async function toggleTreeItem(path, container, arrow) {
  if (!treeState[path]) {
    treeState[path] = { expanded: false, children: [], loaded: false };
  }

  const state = treeState[path];

  if (!state.expanded) {
    // Expand
    state.expanded = true;
    if (arrow) arrow.classList.add('expanded');
    if (container) container.classList.add('expanded');

    // Load children if not loaded
    if (!state.loaded) {
      if (container) {
        const loading = document.createElement('div');
        loading.className = 'tree-loading';
        loading.textContent = 'Loading...';
        container.appendChild(loading);
      }

      const children = await loadDir(path);
      state.children = children;
      state.loaded = true;

      if (container) {
        renderChildren(container, path);
      }
    }
  } else {
    // Collapse
    state.expanded = false;
    if (arrow) arrow.classList.remove('expanded');
    if (container) container.classList.remove('expanded');
  }
}

// ─── Context Menu ───
let contextMenuTarget = null;
let contextMenuIsDir = false;

function showContextMenu(x, y, path) {
  contextMenuTarget = path;
  const menu = document.getElementById('contextMenu');
  const isFav = favorites.includes(path);

  // Determine if target is dir or file from tree state
  let isDir = path === '/'; // root is always dir
  if (!isDir) {
    for (const statePath in treeState) {
      const state = treeState[statePath];
      if (state.children) {
        const found = state.children.find(c => c.path === path);
        if (found) { isDir = found.isDir; break; }
      }
    }
  }
  contextMenuIsDir = isDir;

  // Show/hide items based on file vs dir
  menu.querySelector('[data-action="open-terminal"]').style.display = isDir ? 'flex' : 'none';
  menu.querySelector('[data-action="open-editor"]').style.display = isDir ? 'none' : 'flex';
  menu.querySelector('[data-action="add-favorite"]').style.display = (isFav || !isDir) ? 'none' : 'flex';
  menu.querySelector('[data-action="remove-favorite"]').style.display = (isFav && isDir) ? 'flex' : 'none';
  menu.querySelector('[data-action="new-file"]').style.display = isDir ? 'flex' : 'none';
  menu.querySelector('[data-action="new-folder"]').style.display = isDir ? 'flex' : 'none';

  // Position: keep within viewport
  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  contextMenuTarget = null;
}

// ─── Input Modal (for rename, new file, new folder) ───
function showInputModal(title, defaultValue, callback) {
  document.querySelectorAll('.modal-overlay').forEach(m => m.remove());
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${escHtml(title)}</h2>
      <input type="text" id="inputModalField" value="${escHtml(defaultValue)}" placeholder="">
      <div class="modal-actions">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-save" type="button">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#inputModalField');
  const cancelBtn = overlay.querySelector('.btn-cancel');
  const saveBtn = overlay.querySelector('.btn-save');
  requestAnimationFrame(() => { input.focus(); input.select(); });
  function close() { overlay.remove(); }
  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', () => { callback(input.value.trim()); close(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { callback(input.value.trim()); close(); }
    if (e.key === 'Escape') close();
  });
}

// Helper: refresh the parent directory in the tree after file operations
function refreshTreeParent(filePath) {
  const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
  if (treeState[parentPath]) {
    treeState[parentPath].loaded = false;
    treeState[parentPath].children = [];
    // Find and re-toggle
    const parentRow = document.querySelector(`.tree-item[data-path="${CSS.escape(parentPath)}"]`);
    // Simpler: just re-render the whole tree
    renderFileTree();
  }
}

function initContextMenu() {
  const menu = document.getElementById('contextMenu');

  // Hide on click elsewhere
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tree-item')) hideContextMenu();
  });

  // Menu actions
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const path = contextMenuTarget;
      const isDir = contextMenuIsDir;
      hideContextMenu();
      if (!path) return;

      if (action === 'open-terminal') {
        const name = path.split('/').filter(Boolean).pop() || '/';
        const res = await fetch('/api/tabs', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name, type: 'terminal' }),
        });
        const tab = await res.json();
        tabs.push(tab);
        renderTabs();
        switchTab(tab.id);
        setTimeout(() => {
          const t = terminals[tab.id];
          if (t && t.ws.readyState === WebSocket.OPEN) {
            t.ws.send(JSON.stringify({ type: 'data', data: `cd ${path}\n` }));
          }
        }, 500);
      } else if (action === 'open-editor') {
        openFileInEditor(path);
      } else if (action === 'add-favorite') {
        await addFavorite(path);
        loadGitGraphs();
      } else if (action === 'remove-favorite') {
        await removeFavorite(path);
        loadGitGraphs();
      } else if (action === 'new-file') {
        showInputModal('New file in ' + path, '', async (name) => {
          if (!name) return;
          const filePath = path + '/' + name;
          await fetch('/api/fs/touch', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ path: filePath }),
          });
          treeState[path] && (treeState[path].loaded = false);
          renderFileTree();
        });
      } else if (action === 'new-folder') {
        showInputModal('New folder in ' + path, '', async (name) => {
          if (!name) return;
          const dirPath = path + '/' + name;
          await fetch('/api/fs/mkdir', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ path: dirPath }),
          });
          treeState[path] && (treeState[path].loaded = false);
          renderFileTree();
        });
      } else if (action === 'rename') {
        const oldName = path.split('/').pop();
        showInputModal('Rename', oldName, async (newName) => {
          if (!newName || newName === oldName) return;
          const dir = path.substring(0, path.lastIndexOf('/'));
          const newPath = dir + '/' + newName;
          await fetch('/api/fs/rename', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ oldPath: path, newPath }),
          });
          // Update editor tab if open for this path
          for (const tabId in editors) {
            if (editors[tabId].filePath === path) {
              editors[tabId].filePath = newPath;
              const tab = tabs.find(t => t.id === tabId);
              if (tab) { tab.filePath = newPath; tab.name = newName; }
            }
          }
          renderTabs();
          treeState[dir] && (treeState[dir].loaded = false);
          renderFileTree();
        });
      } else if (action === 'delete') {
        const name = path.split('/').pop();
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
        await fetch('/api/fs/delete', {
          method: 'DELETE',
          headers: authHeaders(),
          body: JSON.stringify({ path }),
        });
        // Close editor tab if open for this path
        for (const tabId in editors) {
          if (editors[tabId].filePath === path) {
            closeTab(tabId);
          }
        }
        const dir = path.substring(0, path.lastIndexOf('/')) || '/';
        treeState[dir] && (treeState[dir].loaded = false);
        renderFileTree();
      }
    });
  });
}

// ─── Git Graphs ───
async function loadGitGraphs() {
  const container = document.getElementById('gitGraphs');
  container.innerHTML = '';

  if (favorites.length === 0) {
    container.innerHTML = '<div class="git-no-favs">No favorites yet.<br>Add paths via right-click in the file manager to see their git graphs here.</div>';
    return;
  }

  for (const favPath of favorites) {
    const repoDiv = document.createElement('div');
    repoDiv.className = 'git-repo';

    const header = document.createElement('div');
    header.className = 'git-repo-header';
    header.innerHTML = `<i class="lni lni-git"></i> <span>${escHtml(favPath)}</span>`;
    repoDiv.appendChild(header);

    try {
      const res = await fetch(`/api/git/log?path=${encodeURIComponent(favPath)}`, {
        headers: { 'Authorization': 'Bearer ' + getToken() },
      });
      const data = await res.json();

      if (data.error || data.commits.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'git-empty';
        empty.textContent = data.error || 'No commits found';
        repoDiv.appendChild(empty);
      } else {
        data.commits.forEach(commit => {
          const row = document.createElement('div');
          row.className = 'git-commit';

          const graph = document.createElement('span');
          graph.className = 'git-graph-chars';
          graph.textContent = commit.graph;

          const hash = document.createElement('span');
          hash.className = 'git-hash';
          hash.textContent = commit.hash;

          const msg = document.createElement('span');
          msg.className = 'git-msg';
          msg.textContent = commit.message;

          row.appendChild(graph);
          row.appendChild(hash);
          row.appendChild(msg);

          if (commit.refs) {
            const refs = document.createElement('span');
            refs.className = 'git-refs';
            refs.textContent = commit.refs;
            row.appendChild(refs);
          }

          const date = document.createElement('span');
          date.className = 'git-date';
          date.textContent = commit.date;
          row.appendChild(date);

          repoDiv.appendChild(row);
        });
      }
    } catch (err) {
      const empty = document.createElement('div');
      empty.className = 'git-empty';
      empty.textContent = 'Error loading git log';
      repoDiv.appendChild(empty);
    }

    container.appendChild(repoDiv);
  }
}

// ─── Init ───
async function init() {
  await checkAuth();
  await loadFavorites();
  await loadTabs();
  initSidebar();
  initContextMenu();
  initMobileKeyboard();
  updateZoomLabel();
  renderFileTree();

  // Poll for CLI-initiated tab opens
  setInterval(async () => {
    try {
      const res = await fetch('/api/cli/pending', { headers: { 'Authorization': 'Bearer ' + getToken() } });
      if (res.ok) {
        const items = await res.json();
        for (const item of items) {
          if (item.type === 'editor') {
            openFileInEditor(item.filePath);
          } else {
            // image or pdf
            openFileInEditor(item.filePath);
          }
        }
      }
    } catch {}
  }, 2000);
}

init();