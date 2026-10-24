'use strict';
// Controlled protocol/filesystem tests. These fixtures do not prove media decoding
// or real ScreenCaptureKit microphone/system-audio behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MacRecordingBackend } = require('../lib/app-recording-native.cjs');
const BOTH = 'system-and-microphone';

function media(directory, audioMode) {
  const microphone = audioMode === BOTH;
  const videoPath = path.join(directory, 'recording.mp4'), frame = path.join(directory, 'frame-0.jpg');
  fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]));
  fs.writeFileSync(frame, Buffer.from([255, 216, 255, 0]));
  return { videoPath, width: 320, height: 240, durationSeconds: 1, frames: [{ path: frame, atSeconds: 0 }],
    audioMode, audio: { system: true, microphone }, systemAudioScope: 'system-wide',
    audioSampleCounts: { system: 48000, microphone: microphone ? 48000 : 0 },
    audioSampleDurationSeconds: { system: 1, microphone: microphone ? 1 : 0 }, audioTrackCount: 1, stopReason: 'manual' };
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'recording-audio-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function native(t, permissions = { screen: 'granted', microphone: 'denied' }) {
  const root = directory(t), outputDir = path.join(root, 'session'), helper = path.join(root, 'helper');
  fs.mkdirSync(outputDir); fs.writeFileSync(helper, 'fixture', { mode: 0o700 });
  const state = { calls: 0, permissions, commands: [], request: null, override: {} };
  const window = { isDestroyed: () => false, getMediaSourceId: () => 'window:123:0' };
  const backend = new MacRecordingBackend({ platform: 'darwin', release: '24.0', helperPath: helper,
    getWindow: () => window,
    capture: { resolveRecordingTarget: async () => ({ windowId: 99,
      app: { pid: 55, bundle: 'test.browser', launchDate: 1234.5 }, validate: async () => {} }) },
    electron: { systemPreferences: { getMediaAccessStatus: kind => state.permissions[kind] } },
    spawnProcess: (_command, args) => {
      state.calls++; state.request = JSON.parse(args[0]);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const finish = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.stdin.on('data', chunk => {
        state.commands.push(String(chunk));
        if (String(chunk) === 'stop\n') setImmediate(() => { finish({ type: 'finished', result: { ...media(outputDir, state.request.audioMode), ...state.override } }); child.emit('close', 0); });
        if (String(chunk) === 'cancel\n') setImmediate(() => child.emit('close', 1));
      });
      child.kill = () => setImmediate(() => child.emit('close', 1));
      state.child = child;
      setImmediate(() => finish({ type: 'started' })); return child;
    } });
  t.after(() => backend.close()); return { backend, outputDir, state };
}
test('system mode starts and finishes with microphone permission denied or not determined', async t => {
  for (const microphone of ['denied', 'not-determined']) await t.test(microphone, async sub => {
    const f = native(sub, { screen: 'granted', microphone });
    const session = await f.backend.start({ source: 'app', outputDir: f.outputDir, audioMode: 'system' });
    assert.equal(f.state.request.audioMode, 'system');
    const result = await session.stop();
    assert.deepEqual(result.audio, { system: true, microphone: false });
    assert.equal(result.systemAudioScope, 'system-wide'); assert.equal(result.audioSampleCounts.microphone, 0);
  });
});
test('legacy default still requires microphone and forwards both mode when granted', async t => {
  const denied = native(t);
  await assert.rejects(denied.backend.start({ source: 'app', outputDir: denied.outputDir }), { code: 'APP_RECORDING_PERMISSION_REQUIRED' });
  assert.equal(denied.state.calls, 0);
  const allowed = native(t, { screen: 'granted', microphone: 'granted' });
  const session = await allowed.backend.start({ source: 'app', outputDir: allowed.outputDir });
  assert.equal(allowed.state.request.audioMode, BOTH); assert.equal((await session.stop()).audio.microphone, true);
});
test('invalid audio modes and missing screen permission fail before native process start', async t => {
  const f = native(t);
  for (const audioMode of [null, '', 'microphone', 'silent', true]) await assert.rejects(f.backend.start({ source: 'app', outputDir: f.outputDir, audioMode }), { code: 'APP_RECORDING_INVALID' });
  f.state.permissions.screen = 'denied';
  await assert.rejects(f.backend.start({ source: 'app', outputDir: f.outputDir, audioMode: 'system' }), { code: 'APP_RECORDING_PERMISSION_REQUIRED' });
  assert.equal(f.state.calls, 0);
});
test('system result rejects mixed audio, positive microphone evidence, silent system and scope downgrade', async t => {
  for (const override of [{ audioMode: BOTH }, { audioMode: null }, { audioMode: undefined }, { audio: { system: true, microphone: true } },
    { audioSampleCounts: { system: 48000, microphone: 1 } }, { audioSampleDurationSeconds: { system: 1, microphone: 0.1 } },
    { audioSampleCounts: { system: 0, microphone: 0 } }, { audioTrackCount: 0 }, { systemAudioScope: 'tab-only' }]) await t.test(JSON.stringify(override), async sub => {
    const f = native(sub); f.state.override = override;
    const session = await f.backend.start({ source: 'app', outputDir: f.outputDir, audioMode: 'system' });
    await assert.rejects(session.stop(), { code: 'APP_RECORDING_PROTOCOL' }); assert.equal(f.backend.active, false);
  });
});
test('system mode ignores later mic permission changes but preserves screen and cancellation guards', async t => {
  const f = native(t, { screen: 'granted', microphone: 'granted' });
  const session = await f.backend.start({ source: 'app', outputDir: f.outputDir, audioMode: 'system' });
  f.state.permissions.microphone = 'denied'; assert.equal((await session.stop()).audioMode, 'system');
  const next = native(t); const started = await next.backend.start({ source: 'app', outputDir: next.outputDir, audioMode: 'system' });
  await started.cancel(); await assert.rejects(started.finished, { code: 'ABORTED' }); assert.ok(next.state.commands.includes('cancel\n'));
  const revoked = native(t); const recording = await revoked.backend.start({ source: 'app', outputDir: revoked.outputDir, audioMode: 'system' });
  revoked.state.permissions.screen = 'denied';
  await assert.rejects(recording.stop(), { code: 'APP_RECORDING_PERMISSION_REQUIRED' });
});
test('system-only target-loss drain retains verified private partial files without microphone access', async t => {
  const f = native(t);
  const session = await f.backend.start({ source: 'application', targetId: 'a'.repeat(32), outputDir: f.outputDir,
    audioMode: 'system', cleanupGuard: () => {} });
  media(f.outputDir, 'system');
  const request = f.state.request, target = { windowId: request.windowId, pid: request.pid, bundle: request.bundle, launchDate: request.launchDate };
  f.state.child.stdout.write(JSON.stringify({ type: 'target-lost', target, mediaState: 'partial',
    video: { name: 'recording.mp4', width: 320, height: 240, durationSeconds: 1 } }) + '\n');
  f.state.child.emit('close', 1);
  await assert.rejects(session.finished, error => {
    assert.equal(error.code, 'APP_RECORDING_TARGET_LOST');
    assert.equal(error.partialMedia.publishable, false); assert.equal(error.partialMedia.files.length, 2);
    assert.deepEqual(error.partialMedia.target, target); return true;
  });
  assert.equal(f.backend.active, false);
});
