'use strict';
// Executes the real JXA metadata code against an Objective-C bridge fixture,
// then exercises the real JS backend with controlled child-process protocols.
// No GUI, OS window capture, actual audio or media decoding is claimed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MacAppCapture } = require('../lib/app-observation-macos.cjs');
const { MacRecordingBackend } = require('../lib/app-recording-native.cjs');
const OWN = 900, WINDOW = 123;
const copy = value => JSON.parse(JSON.stringify(value));
const normal = (pid = OWN, id = WINDOW) => ({ kCGWindowLayer: 0, kCGWindowIsOnscreen: true, kCGWindowAlpha: 1,
  kCGWindowOwnerPID: pid, kCGWindowNumber: id, kCGWindowName: 'Same title', kCGWindowBounds: { Width: 640, Height: 480 } });
function metadata() {
  const state = { apps: new Map([[OWN, { bundle: 'test.openbot', seconds: 1700000000, micros: 123456 }],
    [55, { bundle: 'test.external', seconds: 1700000001, micros: 654321 }]]), windows: [normal(), normal(55, 456)], queries: [] };
  let bytes, emitted;
  const context = vm.createContext({ ObjC: { import() {}, bindFunction() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x },
    $: { NSMutableData: { dataWithLength: length => { bytes = Buffer.alloc(length); return { mutableBytes: bytes, base64EncodedStringWithOptions: () => bytes.toString('base64') }; } },
      proc_pidinfo: (pid, _mode, _arg, buffer) => {
        const app = state.apps.get(pid); if (!app) return 0;
        buffer.writeUInt32LE(pid, 12); buffer.writeBigUInt64LE(BigInt(app.seconds), 120); buffer.writeBigUInt64LE(BigInt(app.micros), 128); return 136;
      },
      NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => {
        const app = state.apps.get(pid); return app ? { isNil: () => false, processIdentifier: pid,
          bundleIdentifier: app.bundle, localizedName: 'Same application name' } : null;
      } },
      NSProcessInfo: { processInfo: { processIdentifier: 9999 } }, CGWindowListCopyWindowInfo: () => copy(state.windows)
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/app-observation-macos.jxa'), 'utf8'), context);
  context.emit = value => { emitted = copy(value); };
  state.run = (mode, request) => { emitted = undefined; state.queries.push({ mode, request: copy(request) }); context.run([mode, JSON.stringify(request)]); return emitted; };
  return state;
}
function ownedWindow() {
  const state = { destroyed: false, visible: true, minimized: false, mediaId: 'window:123:0' };
  return { state, window: { isDestroyed: () => state.destroyed, isVisible: () => state.visible,
    isMinimized: () => state.minimized, getMediaSourceId: () => state.mediaId } };
}
function fixture(t) {
  const state = metadata(), root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'owned-window-test-'));
  let acknowledgeRecorderSpawn;
  const recorderSpawned = new Promise(resolve => { acknowledgeRecorderSpawn = resolve; });
  const helper = path.join(root, 'helper'); fs.writeFileSync(helper, 'fixture', { mode: 0o700 });
  Object.assign(state, { permission: 'granted', microphone: 'denied', recorders: [], screenFallbacks: 0 });
  const electron = { systemPreferences: { getMediaAccessStatus: kind => kind === 'screen' ? state.permission : state.microphone },
    screen: { getCursorScreenPoint: () => { state.screenFallbacks++; throw Error('No screen fallback'); } } };
  const capture = new MacAppCapture({ electron, ownPid: OWN, platform: 'darwin', spawnProcess: (_command, args) => {
    const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let closed = false;
    child.kill = signal => { if (!closed) { closed = true; setImmediate(() => child.emit('close', null, signal)); } };
    child.stdin.on('finish', () => setImmediate(() => {
      if (closed) return;
      try {
        let result = state.run(args[3], JSON.parse(args[4])); if (state.rewrite) result = state.rewrite(args[3], result);
        child.stdout.write(JSON.stringify(result) + '\n'); closed = true; child.emit('close', 0);
      } catch (error) { child.stderr.write(error.message); closed = true; child.emit('close', 1); }
    })); return child;
  } });
  const backend = new MacRecordingBackend({ electron, capture, platform: 'darwin', release: '24.0', helperPath: helper,
    getWindow: () => { throw Error('Owned capture cannot use the legacy main-window getter'); },
    spawnProcess: (_command, args) => {
      const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), request: JSON.parse(args[0]), commands: [] });
      child.json = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.target = () => Object.fromEntries(['windowId', 'pid', 'bundle', 'launchDate'].map(key => [key, child.request[key]]));
      child.media = () => {
        const videoPath = path.join(child.request.outputDir, 'recording.mp4'), frame = path.join(child.request.outputDir, 'frame-0.jpg');
        fs.writeFileSync(videoPath, 'controlled-video'); fs.writeFileSync(frame, 'controlled-frame');
        return { videoPath, width: 640, height: 480, durationSeconds: 1, frames: [{ path: frame, atSeconds: 0 }],
          audioMode: 'system', audio: { system: true, microphone: false }, audioSampleCounts: { system: 48000, microphone: 0 },
          audioSampleDurationSeconds: { system: 1, microphone: 0 }, audioTrackCount: 1, systemAudioScope: 'system-wide', stopReason: 'manual' };
      };
      child.stdin.on('data', chunk => {
        child.commands.push(String(chunk));
        if (String(chunk) === 'stop\n') setImmediate(() => { child.json({ type: 'finished', result: child.media() }); child.emit('close', 0); });
        if (String(chunk) === 'cancel\n') setImmediate(() => child.emit('close', 1));
      });
      child.kill = () => setImmediate(() => child.emit('close', 1));
      state.recorders.push(child); acknowledgeRecorderSpawn(child);
      setImmediate(() => { if (!state.holdReady) child.json({ type: 'started', target: child.target() }); }); return child;
    } });
  const output = () => fs.mkdtempSync(path.join(root, 'output-'));
  t.after(async () => { await backend.close(); await capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { capture, backend, state, output, recorderSpawned };
}

test('real JXA owned-query returns exact same-process microsecond identity; list still excludes own process', () => {
  const state = metadata(), result = state.run('owned-query', { ownPid: OWN, windowId: WINDOW });
  assert.equal(result.app.pid, OWN); assert.equal(result.app.bundle, 'test.openbot');
  assert.equal(result.app.launchDate, 1700000000.123456);
  assert.deepEqual(state.run('list', { ownPid: OWN }).applications.map(row => row.app.pid), [55]);
  assert.throws(() => state.run('owned-query', { ownPid: OWN, windowId: WINDOW, app: { pid: 55 } }), /Invalid owned/);
  state.windows[0].kCGWindowOwnerPID = 55;
  assert.equal(state.run('owned-query', { ownPid: OWN, windowId: WINDOW }).error, 'window-unavailable');
});
test('JXA owned-query rejects hidden, minimized-equivalent, duplicate and missing process/window identities', () => {
  for (const alter of [s => { s.windows[0].kCGWindowIsOnscreen = false; }, s => { s.windows[0].kCGWindowAlpha = 0; },
    s => { s.windows[0].kCGWindowLayer = 1; }, s => { s.windows.push(normal()); }, s => { s.apps.delete(OWN); }]) {
    const state = metadata(); alter(state); assert.ok(state.run('owned-query', { ownPid: OWN, windowId: WINDOW }).error);
  }
});
test('owned resolution keeps a frozen tuple, never issues an external list token and rejects changed birth/PID/bundle', async t => {
  for (const change of ['birth', 'pid', 'bundle']) await t.test(change, async sub => {
    const f = fixture(sub), { window } = ownedWindow();
    const resolved = await f.capture.resolveOwnedWindow(window);
    assert.equal(Object.isFrozen(resolved), true); assert.equal(Object.isFrozen(resolved.app), true);
    assert.equal(f.capture.targets.size, 0);
    assert.deepEqual(f.state.queries[0], { mode: 'owned-query', request: { ownPid: OWN, windowId: WINDOW } });
    if (change === 'birth') f.state.apps.get(OWN).micros++;
    if (change === 'pid') f.state.windows[0].kCGWindowOwnerPID = 55;
    if (change === 'bundle') f.state.apps.get(OWN).bundle = 'test.replaced';
    await assert.rejects(resolved.validate(), { code: 'APP_OBSERVATION_UNAVAILABLE' });
    assert.equal(resolved.app.launchDate, 1700000000.123456);
  });
});
test('owned resolution rejects invalid media IDs, unavailable native identity and hidden/closed windows', async t => {
  for (const mediaId of ['screen:1:0', 'window:0:0', 'window:4294967296:0', 'window:123:0junk']) {
    const f = fixture(t), { window, state } = ownedWindow(); state.mediaId = mediaId;
    await assert.rejects(f.capture.resolveOwnedWindow(window), { code: 'APP_OBSERVATION_UNAVAILABLE' }); assert.equal(f.state.queries.length, 0);
  }
  for (const field of ['destroyed', 'visible', 'minimized', 'mediaId']) await t.test(field, async sub => {
    const f = fixture(sub), owned = ownedWindow(), resolved = await f.capture.resolveOwnedWindow(owned.window);
    owned.state[field] = field === 'visible' ? false : field === 'mediaId' ? 'window:124:0' : true;
    const before = f.state.queries.length;
    await assert.rejects(resolved.validate(), { code: 'APP_OBSERVATION_UNAVAILABLE' }); assert.equal(f.state.queries.length, before);
  });
  const f = fixture(t), { window } = ownedWindow();
  f.state.rewrite = (mode, result) => mode === 'owned-query' ? { ...result, app: { ...result.app, pid: 55 } } : result;
  await assert.rejects(f.capture.resolveOwnedWindow(window), { code: 'APP_OBSERVATION_UNAVAILABLE' });
});
test('post-query live guard, cancellation, revoked permission and capture shutdown invalidate owned leases', async t => {
  const f = fixture(t), owned = ownedWindow(); let calls = 0;
  await assert.rejects(f.capture.resolveOwnedWindow(owned.window, { guard: () => { if (++calls === 2) owned.state.visible = false; } }), { code: 'APP_OBSERVATION_UNAVAILABLE' });
  owned.state.visible = true;
  const abort = new AbortController(), resolved = await f.capture.resolveOwnedWindow(owned.window, { signal: abort.signal });
  abort.abort(); await assert.rejects(resolved.validate(), { code: 'ABORTED' });
  const next = await f.capture.resolveOwnedWindow(owned.window); f.state.permission = 'denied';
  await assert.rejects(next.validate(), { code: 'APP_OBSERVATION_PERMISSION_REQUIRED' });
  f.state.permission = 'granted'; await f.capture.close(); await assert.rejects(next.validate(), { code: 'APP_OBSERVATION_CLOSED' });
});
test('ordinary external list and opaque target resolution remain separate from owned recording', async t => {
  const f = fixture(t), listed = await f.capture.listApplications();
  assert.equal(listed.applications.length, 1);
  const targetId = listed.applications[0].targetId, external = await f.capture.resolveRecordingTarget(targetId);
  assert.equal(external.app.pid, 55); assert.equal(external.windowId, 456);
  const session = await f.backend.start({ source: 'application', targetId, outputDir: f.output(), audioMode: 'system' });
  assert.equal(f.state.recorders[0].request.pid, 55); assert.equal((await session.stop()).audioMode, 'system');
  assert.equal(f.state.queries.some(q => q.mode === 'owned-query'), false);
});
test('owned system-only recorder forwards the complete tuple and shares serial session ownership', async t => {
  const f = fixture(t), owned = ownedWindow();
  const session = await f.backend.startOwnedWindow(owned.window, { outputDir: f.output(), audioMode: 'system', cleanupGuard: () => {} });
  const child = f.state.recorders[0];
  assert.deepEqual(child.target(), { windowId: WINDOW, pid: OWN, bundle: 'test.openbot', launchDate: 1700000000.123456 });
  assert.deepEqual(session.target, child.target()); assert.equal(Object.isFrozen(session.target), true);
  assert.equal(child.request.audioMode, 'system'); assert.equal(Object.hasOwn(child.request, 'targetId'), false);
  assert.equal(Object.hasOwn(child.request, 'source'), false); assert.equal(Object.hasOwn(child.request, 'displayId'), false);
  await assert.rejects(f.backend.startOwnedWindow(owned.window, { outputDir: f.output(), audioMode: 'system' }), { code: 'APP_RECORDING_BUSY' });
  assert.equal(f.state.recorders.length, 1); assert.equal((await session.stop()).audio.microphone, false);
  const next = await f.backend.startOwnedWindow(owned.window, { outputDir: f.output(), audioMode: 'system' });
  await next.cancel(); await assert.rejects(next.finished, { code: 'ABORTED' }); assert.equal(f.backend.active, false);
  assert.equal(f.state.screenFallbacks, 0);
});
test('owned target overrides and unknown resolver fields cannot select a different window or screen', async t => {
  const f = fixture(t), { window } = ownedWindow();
  for (const key of ['source', 'targetId', 'windowId', 'pid', 'bundle', 'launchDate', 'displayId', 'resolveTarget']) {
    await assert.rejects(f.backend.startOwnedWindow(window, { outputDir: f.output(), audioMode: 'system', [key]: undefined }), { code: 'APP_RECORDING_INVALID' });
  }
  await assert.rejects(f.backend.startOwnedWindow(window, { outputDir: f.output(), audioMode: 'system', [Symbol('owned')]: () => {} }), { code: 'APP_RECORDING_INVALID' });
  assert.equal(f.state.recorders.length, 0); assert.equal(f.state.queries.length, 0);
  f.state.windows = [];
  await assert.rejects(f.backend.startOwnedWindow(window, { outputDir: f.output(), audioMode: 'system' }), { code: 'APP_OBSERVATION_UNAVAILABLE' });
  assert.equal(f.state.recorders.length, 0); assert.equal(f.state.screenFallbacks, 0);
});
test('native-owned target loss keeps exact nonpublishable private partial and clears physical busy only after close', async t => {
  const f = fixture(t), { window } = ownedWindow();
  const session = await f.backend.startOwnedWindow(window, { outputDir: f.output(), audioMode: 'system', cleanupGuard: () => {} });
  const child = f.state.recorders[0]; child.media(); f.state.windows = [];
  child.json({ type: 'target-lost', target: child.target(), mediaState: 'partial', video: { name: 'recording.mp4', width: 640, height: 480, durationSeconds: 1 } });
  let done = false; session.finished.catch(() => { done = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); assert.equal(f.backend.active, true); child.emit('close', 1);
  await assert.rejects(session.finished, error => { assert.equal(error.code, 'APP_RECORDING_TARGET_LOST');
    assert.deepEqual(error.partialMedia.target, child.target()); assert.equal(error.partialMedia.publishable, false);
    assert.equal(error.partialMedia.files.length, 2); assert.match(error.partialMedia.files[0].sha256, /^[a-f0-9]{64}$/); return true; });
  assert.equal(f.backend.active, false); assert.equal(f.state.screenFallbacks, 0);
});
test('cancelling owned start before native-ready drains only its acknowledged child', async t => {
  const f = fixture(t), { window } = ownedWindow(), controller = new AbortController(); f.state.holdReady = true;
  const pending = f.backend.startOwnedWindow(window, { outputDir: f.output(), audioMode: 'system', signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ABORTED' });
  // Wait for the actual mock spawn, rather than a number of event-loop turns:
  // filesystem preparation can outlast those turns on the external test volume.
  const child = await f.recorderSpawned;
  assert.equal(child, f.state.recorders[0]);
  assert.equal(f.state.recorders.length, 1); controller.abort(); await rejected;
  assert.deepEqual(f.state.recorders[0].commands, ['cancel\n']); assert.equal(f.backend.active, false);
});
