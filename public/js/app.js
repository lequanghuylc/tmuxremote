import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

// ─── State ───
let currentUser = null;
let tabs = [];
let activeTabId = null;
let terminals = {};  // { tabId: { terminal, fitAddon, ws, container, fontSize } }
let activeModifiers = new Set();
let currentFontSize = 14;

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
    el.innerHTML = `
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
  if (!confirm('Close this tab? The tmux session will be killed.')) return;
  await fetch(`/api/tabs/${tabId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + getToken() } });
  tabs = tabs.filter(t => t.id !== tabId);

  if (terminals[tabId]) {
    terminals[tabId].ws?.close();
    terminals[tabId].terminal.dispose();
    terminals[tabId].container.remove();
    delete terminals[tabId];
  }

  if (activeTabId === tabId) {
    activeTabId = null;
    if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id);
    else showEmptyState();
  }
  renderTabs();
}

function switchTab(tabId) {
  activeTabId = tabId;
  renderTabs();
  hideEmptyState();

  document.querySelectorAll('.tab-terminal').forEach(el => el.classList.remove('active'));

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

function showEmptyState() {
  let empty = document.getElementById('emptyState');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'emptyState';
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="icon">🖥️</div>
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
      if (msg.type === 'data') terminal.write(msg.data);
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

  terminals[tabId] = { terminal, fitAddon, ws, container, resizeObserver };

  setTimeout(() => terminal.focus(), 50);
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

// ─── Helpers ───
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Init ───
async function init() {
  await checkAuth();
  await loadTabs();
  initMobileKeyboard();
  updateZoomLabel();
}

init();
