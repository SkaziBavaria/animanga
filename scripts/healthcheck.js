'use strict';

const port = Number(process.env.ANIMANGA_PORT || 7831);
const token = String(process.env.ANIMANGA_ACCESS_TOKEN || '');
const username = String(process.env.ANIMANGA_ACCESS_USERNAME || 'animanga');
const headers = token
  ? { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` }
  : {};

fetch(`http://127.0.0.1:${port}/api/status`, { headers, signal: AbortSignal.timeout(4000) })
  .then((response) => {
    if (!response.ok) throw new Error(`Healthcheck HTTP ${response.status}`);
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
