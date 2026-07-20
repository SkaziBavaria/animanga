#!/usr/bin/env node
'use strict';

const fs = require('fs');

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not find ${label} in upstream ani-cli reference`);
  return match[1];
}

function extractCryptoConfig(reference) {
  const key = requiredMatch(reference, /^allanime_key="([0-9a-f]{64})"$/m, 'allanime_key');
  const epoch = requiredMatch(reference, /^allanime_epoch=([0-9]+)$/m, 'allanime_epoch');
  const buildId = requiredMatch(reference, /^allanime_build_id=([0-9]+)$/m, 'allanime_build_id');
  const request = requiredMatch(
    reference,
    /^\s*api_resp="\$\((curl .*--data-urlencode "extensions=\$\{query_ext\}")\)"$/m,
    'episode API request',
  );
  const origin = requiredMatch(request, /-H "Origin: ([^"]+)"/, 'episode API Origin');
  return { key, epoch, buildId, origin };
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`Stable ani-cli base no longer contains ${label}`);
  return text.replace(pattern, replacement);
}

function patchStableAniCli(stable, config) {
  let output = stable;
  output = replaceRequired(output, /epoch:[0-9]+,buildId:'[0-9]+'/, `epoch:${config.epoch},buildId:'${config.buildId}'`, 'aaReq payload');
  output = replaceRequired(output, /\.update\('[0-9]+:[0-9]+:'\+qh\+':'\+ts\)/, `.update('${config.epoch}:${config.buildId}:'+qh+':'+ts)`, 'aaReq IV input');
  output = replaceRequired(output, /^allanime_key="[0-9a-f]{64}"$/m, `allanime_key="${config.key}"`, 'allanime_key');

  const requestPattern = /^\s*api_resp="\$\((curl .*--data-urlencode "extensions=\$\{query_ext\}")\)"$/m;
  const oldRequest = requiredMatch(output, requestPattern, 'stable episode API request');
  const indentation = output.match(requestPattern)[0].match(/^\s*/)[0];
  let request = oldRequest.replace(/-H "Origin: [^"]+"/, `-H "Origin: ${config.origin}"`);
  if (/-H "x-build-id: [^"]+"/.test(request)) {
    request = request.replace(/-H "x-build-id: [^"]+"/, `-H "x-build-id: ${config.buildId}"`);
  } else {
    request = request.replace(`-H "Origin: ${config.origin}"`, `-H "Origin: ${config.origin}" -H "x-build-id: ${config.buildId}"`);
  }
  output = output.replace(requestPattern, `${indentation}api_resp="$(${request})"`);
  return output;
}

function main(args) {
  if (args.length !== 2) throw new Error('Usage: patch-ani-cli-crypto.js STABLE_FILE REFERENCE_FILE');
  const [stablePath, referencePath] = args;
  const stable = fs.readFileSync(stablePath, 'utf8');
  const reference = fs.readFileSync(referencePath, 'utf8');
  const config = extractCryptoConfig(reference);
  const patched = patchStableAniCli(stable, config);
  fs.writeFileSync(stablePath, patched);
  process.stdout.write(`Applied AllAnime crypto config: epoch=${config.epoch}, buildId=${config.buildId}, origin=${config.origin}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { extractCryptoConfig, patchStableAniCli };
