'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ANI_CLI } = require('./config');
const { fetchLiveCryptoConfig, validateCryptoConfig, formatCryptoFailure } = require('./mkissa-crypto');
const { patchStableAniCli } = require('../scripts/patch-ani-cli-crypto');

function resolveAniCliPath(bin = ANI_CLI) {
  if (!bin) return bin;
  if (path.isAbsolute(bin) || /[\\/]/.test(bin)) return path.resolve(bin);
  if (process.platform === 'win32') {
    const which = spawnSync('where.exe', [bin], { encoding: 'utf8' });
    return String(which.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || bin;
  }
  const which = spawnSync('sh', ['-c', 'command -v -- "$1"', 'sh', bin], { encoding: 'utf8' });
  return String(which.stdout || '').trim() || bin;
}

function syntaxCheckShellScript(filePath) {
  if (process.platform === 'win32') return { ok: true, skipped: true };
  const result = spawnSync('sh', ['-n', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ani-cli syntax check failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return { ok: true };
}

/**
 * Best-effort atomic refresh of ani-cli crypto material.
 * On failure the original file is left unchanged.
 */
async function refreshAniCliCrypto({
  aniCliPath = resolveAniCliPath(),
  fetchConfig = fetchLiveCryptoConfig,
  validateConfig = validateCryptoConfig,
  replaceFile = fs.renameSync,
} = {}) {
  const target = path.resolve(aniCliPath);
  if (!fs.existsSync(target)) {
    return { ok: false, skipped: true, reason: `ani-cli not found at ${target}` };
  }

  const original = fs.readFileSync(target);
  const tempPath = path.join(path.dirname(target), `.ani-cli.crypto-refresh.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tempPath, original);
    const config = await fetchConfig();
    await validateConfig(config);
    const patched = patchStableAniCli(fs.readFileSync(tempPath, 'utf8'), {
      key: config.key,
      epoch: config.epoch,
      buildId: config.buildId,
      origin: config.origin,
    });
    fs.writeFileSync(tempPath, patched);
    syntaxCheckShellScript(tempPath);
    try {
      fs.chmodSync(tempPath, 0o755);
    } catch {
      // Non-fatal on platforms that ignore chmod.
    }

    // tempPath lives beside target, so rename is an atomic same-filesystem
    // replacement on Docker and Termux. Fail closed if the platform cannot
    // provide that guarantee.
    replaceFile(tempPath, target);

    return {
      ok: true,
      path: target,
      epoch: config.epoch,
      buildId: config.buildId,
      source: config.source || 'mkissa',
    };
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
    // A failed atomic rename leaves the original target untouched.
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, original);
    }
    return {
      ok: false,
      path: target,
      reason: formatCryptoFailure({ message: error.message }),
    };
  }
}

async function refreshAniCliCryptoBestEffort(options = {}) {
  const result = await refreshAniCliCrypto(options);
  if (result.ok) {
    console.log(`ani-cli crypto refreshed (epoch=${result.epoch}, buildId=${result.buildId}, source=${result.source})`);
  } else if (!result.skipped) {
    console.warn(`ani-cli crypto refresh skipped; keeping previous file (${result.reason})`);
  }
  return result;
}

module.exports = {
  resolveAniCliPath,
  refreshAniCliCrypto,
  refreshAniCliCryptoBestEffort,
  syntaxCheckShellScript,
};
