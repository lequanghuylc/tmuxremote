#!/usr/bin/env node
import { resolve } from 'path';
import { existsSync } from 'fs';

const args = process.argv.slice(2);
let filePath = null;
let url = process.env.TMUXREMOTE_URL || 'http://localhost:4567';
let apiKey = process.env.CLI_API_KEY || 'tmuxremote-cli-key';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) { url = args[++i]; continue; }
  if (args[i] === '--key' && args[i + 1]) { apiKey = args[++i]; continue; }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: tredit <filepath> [--url <server-url>] [--key <api-key]');
    console.log('');
    console.log('Opens a file in the tmuxremote web editor.');
    console.log('If the file does not exist, opens a blank editor that saves to that path on Cmd+S.');
    process.exit(0);
  }
  if (!filePath) filePath = args[i];
}

if (!filePath) {
  console.error('Usage: tredit <filepath> [--url <server-url>] [--key <api-key>]');
  process.exit(1);
}

const absPath = resolve(filePath);
console.log(`Opening: ${absPath}`);

try {
  const res = await fetch(`${url}/api/cli/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, filePath: absPath }),
  });
  const data = await res.json();
  if (res.ok) {
    console.log(`✅ Tab opened (id: ${data.id})`);
  } else {
    console.error(`❌ Error: ${data.error}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`❌ Cannot reach server at ${url}: ${err.message}`);
  console.error('Make sure tmuxremote is running: node server.js');
  process.exit(1);
}
