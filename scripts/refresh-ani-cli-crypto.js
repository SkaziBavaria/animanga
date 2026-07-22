#!/usr/bin/env node
'use strict';

const { refreshAniCliCryptoBestEffort } = require('../lib/ani-cli-refresh');

refreshAniCliCryptoBestEffort()
  .then((result) => {
    process.exitCode = 0;
    if (result.ok === false && process.env.ANIMANGA_CRYPTO_REFRESH_STRICT === '1') {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.warn(`ani-cli crypto refresh failed unexpectedly; keeping previous file (${error.message})`);
    process.exitCode = process.env.ANIMANGA_CRYPTO_REFRESH_STRICT === '1' ? 1 : 0;
  });
