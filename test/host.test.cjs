'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostCapture } = require('../host.cjs');
const image = { isEmpty: () => false };
const window = capturePage => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { capturePage } });

test('an in-flight main screenshot cannot change the independent recording window', async () => {
  let resolveImage;
  const main = window(() => new Promise(resolve => { resolveImage = resolve; }));
  const spectator = window(() => { throw Error('not the screenshot target'); });
  const backend = createHostCapture({ electron: {}, getWindow: () => main, getRecordingWindow: () => spectator });
  const pending = backend.captureSelf(main);
  assert.equal(backend.busy, true);
  assert.equal(backend.recording.getWindow(), spectator);
  await assert.rejects(backend.captureSelf(spectator), { code: 'APP_OBSERVATION_UNAVAILABLE' });
  resolveImage(image);
  assert.equal((await pending).image, image);
  assert.equal(backend.recording.getWindow(), spectator);
  assert.equal(backend.busy, false);
  await backend.close();
});

test('closing rejects a late screenshot and waits for the pending operation', async () => {
  let resolveImage;
  const main = window(() => new Promise(resolve => { resolveImage = resolve; }));
  const backend = createHostCapture({ electron: {}, getWindow: () => main });
  const pending = backend.captureSelf(main);
  const rejected = assert.rejects(pending, { code: 'APP_OBSERVATION_CLOSED' });
  let closed = false;
  const closing = backend.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  resolveImage(image);
  await rejected;
  await closing;
  assert.equal(closed, true);
});

test('existing hosts retain their self-recording window and unavailable screenshot checks', async () => {
  const main = window(async () => image);
  const backend = createHostCapture({ electron: {}, getWindow: () => main });
  assert.equal(backend.recording.getWindow(), main);
  assert.equal((await backend.captureSelf(main)).image, image);
  main.isVisible = () => false;
  await assert.rejects(backend.captureSelf(main), { code: 'APP_OBSERVATION_UNAVAILABLE' });
  await backend.close();
});
