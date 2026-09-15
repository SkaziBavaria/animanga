'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadPlayerViewport() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/player-viewport.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('visualViewportBox follows the visual viewport after a landscape rotation', async () => {
  const { visualViewportBox } = await loadPlayerViewport();
  assert.deepEqual(visualViewportBox({ width: 844, height: 390 }, { width: 390, height: 844 }), {
    width: 844,
    height: 390,
  });
  assert.deepEqual(visualViewportBox({}, { width: 390, height: 844 }), {
    width: 390,
    height: 844,
  });
});

test('applyPlayerFullscreenViewport writes and clears the layout custom properties', async () => {
  const { applyPlayerFullscreenViewport } = await loadPlayerViewport();
  const styles = new Map();
  const element = {
    style: {
      setProperty(name, value) { styles.set(name, value); },
      removeProperty(name) { styles.delete(name); },
    },
  };
  applyPlayerFullscreenViewport(element, true, { width: 844, height: 390 });
  assert.equal(styles.get('--player-fullscreen-width'), '844px');
  assert.equal(styles.get('--player-fullscreen-height'), '390px');
  applyPlayerFullscreenViewport(element, false);
  assert.equal(styles.has('--player-fullscreen-width'), false);
  assert.equal(styles.has('--player-fullscreen-height'), false);
});
