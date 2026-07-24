'use strict';

const fs = require('fs');

function isOpenBind(host) {
  return host === '0.0.0.0' || host === '::';
}

function assertSecureBind({
  host,
  accessToken,
  allowInsecure = process.env.ANIMANGA_ALLOW_INSECURE === '1',
  inDocker = fs.existsSync('/.dockerenv'),
} = {}) {
  if (!isOpenBind(host) || accessToken) return;
  if (inDocker || allowInsecure) return;
  throw new Error(
    `Refusing to listen on ${host} without authentication. `
    + 'Set ANIMANGA_ACCESS_TOKEN or ANIMANGA_ALLOW_INSECURE=1 to acknowledge the risk.',
  );
}

module.exports = {
  isOpenBind,
  assertSecureBind,
};
