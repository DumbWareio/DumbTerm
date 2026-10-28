#!/usr/bin/env node

/**
 * node-pty 1.1.0 publishes its macOS spawn-helper without the execute bit, so every
 * pty.spawn() on macOS fails with "posix_spawnp failed" (microsoft/node-pty#850, #919).
 * Runs after `npm install` to restore the bit; a no-op once upstream ships a fixed release.
 */

const fs = require('fs');
const path = require('path');

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!fs.existsSync(prebuildsDir)) {
  process.exit(0);
}

fs.readdirSync(prebuildsDir)
  .filter(dir => dir.startsWith('darwin-'))
  .forEach(dir => {
    const helper = path.join(prebuildsDir, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  });
