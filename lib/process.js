'use strict';

const { spawnSync } = require('child_process');

function commandExists(cmd) {
  if (process.platform === 'win32') {
    return spawnSync('where', [cmd], { encoding: 'utf8', shell: true }).status === 0;
  }
  return spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], { encoding: 'utf8' }).status === 0;
}

function stripAnsi(value) {
  return String(value || '').replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '');
}

module.exports = {
  commandExists,
  stripAnsi,
};
