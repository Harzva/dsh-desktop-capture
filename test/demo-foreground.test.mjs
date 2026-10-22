// Pure wire/client lifecycle checks with an in-memory child; never launches AX/App.
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { AXClient } from '../demo/action/index.mjs';
const target = { pid: 123, bundleId: 'fixture.app', processBirth: '1234.5', windowId: 88 };
async function fixture(body, respond = () => ({ status: 'activated', identity: target, evidence: { verified: true, frontmostPID: 123, focusedWindowMatches: true } })) {
  const original = cp.spawn, requests = [];
  cp.spawn = () => {
    const child = new EventEmitter(); child.pid = 999999;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.destroy = () => {};
    child.kill = () => queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
    child.stdin.write = (bytes, callback) => {
      const request = JSON.parse(bytes); requests.push(request);
      queueMicrotask(() => {
        const result = respond(request);
        if (result?.writeError) return callback(Error('fixture write uncertain'));
        if (result === undefined) return;
        child.stdout.emit('data', Buffer.from(JSON.stringify({ requestId: request.requestId, ...result.error ? { ok: false, error: result.error } : { ok: true, result } }) + '\n'));
      });
    };
    return child;
  };
  syncBuiltinESMExports();
  const client = new AXClient({ binary: '/fixture/never-spawned', timeoutMs: 100 });
  try { await body(client, requests); }
  finally { await client.closeAndWait(); cp.spawn = original; syncBuiltinESMExports(); }
}
test('activate sends exact target once, preserves verified result and never replays after success', async () => {
  await fixture(async (client, requests) => {
    const result = await client.activate(target);
    assert.equal(result.status, 'activated'); assert.deepEqual(result.identity, target); assert.equal(result.evidence.verified, true);
    assert.equal(requests.length, 1); assert.equal(requests[0].op, 'activate'); assert.deepEqual(requests[0].target, target);
    await assert.rejects(client.activate(target), { code: 'activation_already_attempted', effect: 'none' });
    await assert.rejects(client.request('activate', { target }), { code: 'activation_already_attempted' });
    assert.equal(requests.length, 1);
  });
});
test('invalid target and pre-send abort dispatch nothing and do not consume the activation', async () => {
  await fixture(async (client, requests) => {
    for (const bad of [{ ...target, pid: 0 }, { ...target, windowId: '88' }, { ...target, processBirth: 'NaN' }, { ...target, extra: true }])
      assert.throws(() => client.activate(bad), TypeError);
    await assert.rejects(client.request('activate', { target, extra: true }), TypeError);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.activate(target, { signal: controller.signal }), { code: 'cancelled', effect: 'none' });
    assert.equal(requests.length, 0); await client.activate(target); assert.equal(requests.length, 1);
  });
});
for (const failure of ['timeout', 'abort', 'write']) test(`in-flight activate ${failure} is unknown, fences and does not replay`, async () => {
  await fixture(async (client, requests) => {
    const controller = new AbortController(), pending = client.activate(target, { signal: controller.signal });
    if (failure === 'abort') controller.abort();
    await assert.rejects(pending, error => error.effect === 'unknown' && ['timeout', 'cancelled', 'write_failed'].includes(error.code));
    assert.equal(client.fenced, true); await assert.rejects(client.activate(target), { code: 'fenced' }); assert.equal(requests.length, 1);
  }, () => failure === 'write' ? { writeError: true } : undefined);
});
for (const effect of ['none', 'unknown']) test(`native ${effect} failure retains exact evidence and fences session`, async () => {
  const evidence = { attempted: effect === 'unknown', target, verified: false, api: 'fixture', raiseAXError: -25204 };
  await fixture(async client => {
    await assert.rejects(client.activate(target), error => error.code === 'activation_test_failure' && error.effect === effect &&
      assert.deepEqual(error.nativeEvidence, evidence) === undefined);
    assert.equal(client.fenced, true);
  }, () => ({ error: { code: 'activation_test_failure', message: 'fixture', effect, evidence } }));
});
test('action write uncertainty remains a mutation and never implicitly sends activate', async () => {
  await fixture(async (client, requests) => {
    await assert.rejects(client.request('action', { target, action: { type: 'press', locator: { id: 'fixture:1' } } }), { code: 'write_failed', effect: 'unknown' });
    assert.deepEqual(requests.map(r => r.op), ['action']);
  }, () => ({ writeError: true }));
});
test('verified native postcondition preserves a nonzero raise return without client reinterpretation', async () => {
  const evidence = { verified: true, attempted: true, apiReturned: true, raiseAXError: -25205,
    frontmostPID: target.pid, focusedWindowMatches: true };
  await fixture(async (client, requests) => {
    const result = await client.activate(target);
    assert.equal(result.status, 'activated'); assert.deepEqual(result.identity, target); assert.deepEqual(result.evidence, evidence);
    assert.equal(requests.length, 1);
    await assert.rejects(client.activate(target), { code: 'activation_already_attempted' });
  }, () => ({ status: 'activated', identity: target, evidence }));
});
