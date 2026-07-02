'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/run-node-tests.js <test-directory>');
  process.exit(1);
}

const root = path.resolve(process.cwd(), target);
if (!fs.existsSync(root)) {
  console.error(`Test directory not found: ${target}`);
  process.exit(1);
}

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
    } else if (/\.test\.js$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectTests(root).sort();
if (!files.length) {
  console.error(`No test files found in: ${target}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
