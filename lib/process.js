'use strict';

const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

function commandExists(cmd) {
  if (process.platform === 'win32') {
    return spawnSync('where', [cmd], { encoding: 'utf8', shell: true }).status === 0;
  }
  return spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], { encoding: 'utf8' }).status === 0;
}

function isUtilLinuxScript() {
  if (!commandExists('script')) return false;
  const version = spawnSync('script', ['-V'], { encoding: 'utf8' });
  return /util-linux/i.test(`${version.stdout || ''}${version.stderr || ''}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellJoinCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"'\\$`]/.test(part) ? shellQuote(part) : String(part)))
    .join(' ');
}

function spawnWithScriptLog(logFile, command, args, envPatch = {}) {
  const env = { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch };
  const options = { cwd: os.homedir(), env, stdio: 'ignore' };

  if (!commandExists('script')) {
    const output = fs.openSync(logFile, 'a');
    return {
      child: spawn(command, args, { ...options, stdio: ['ignore', output, output] }),
      closeOutput: () => {
        try { fs.closeSync(output); } catch {}
      },
    };
  }

  if (isUtilLinuxScript()) {
    return {
      child: spawn('script', ['-q', '-e', '-O', logFile, '-c', shellJoinCommand(command, args)], options),
      closeOutput: () => {},
    };
  }

  return {
    child: spawn('script', ['-q', '-e', '-O', logFile, '--', command, ...args], options),
    closeOutput: () => {},
  };
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = {
  commandExists,
  isUtilLinuxScript,
  shellQuote,
  shellJoinCommand,
  spawnWithScriptLog,
  stripAnsi,
};
