# 🖥️ tmuxremote

Web-based terminal powered by tmux. Sessions persist across browser close/reload.

## Features

- **tmux-backed** — terminals survive browser close, page reload, or network drop
- **Multiple tabs** — each tab is a separate tmux session, renameable
- **Auth required** — JWT-based login with seeded initial user
- **Mobile-friendly** — on-screen dev keyboard with Esc, Ctrl, Alt, Tab, arrows, F-keys
  - Draggable to reposition
  - Dismissable with a floating FAB to bring it back

## Quick Start

```bash
cd ~/projects/tmuxremote
npm start
```

Open `http://localhost:4567`

**Default credentials:** `admin` / `tmuxremote`

## Configuration

| Env Variable   | Default   | Description          |
|---------------|-----------|----------------------|
| `PORT`        | `4567`    | Server listen port   |
| `JWT_SECRET`  | (random)  | JWT signing secret   |

## Architecture

```
Browser (xterm.js) ←WebSocket→ Node.js (node-pty) ←→ tmux sessions
```

- Each tab maps to a dedicated tmux session (`tmuxremote-<id>`)
- WebSocket carries terminal I/O as JSON messages
- PTYs are kept alive server-side — browser can disconnect freely
- Sessions stored in `.data/sessions.json`, users in `.data/users.json`

## Mobile Keyboard

On touch devices (or screens ≤768px), a dev keyboard appears at the bottom with:

- **Esc, Home, End, PgUp, PgDn** — navigation
- **Ctrl, Alt, ⌘, Tab, Shift-Tab** — modifiers (tap to toggle, then tap a key)
- **Arrow keys, Del** — movement
- **F1–F12** — function keys
- **|, ~, \`, \\** — common shell symbols
- **^C, ^D, ^Z** — signal shortcuts

Drag the handle to reposition. Tap ✕ to dismiss. Tap ⌨ FAB to restore.

## License

MIT
