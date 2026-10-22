import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const active = new Set();
const own = (o, k) => Object.hasOwn(o, k);
const plain = o => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const clone = o => JSON.parse(JSON.stringify(o));
const freeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const canonical = o => Array.isArray(o) ? `[${o.map(canonical).join(',')}]` : plain(o) ? `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}` : JSON.stringify(o);
const fail = message => { throw new TypeError(message); };
function keys(o, allowed, required = allowed) {
  if (!plain(o) || Object.keys(o).some(k => !allowed.includes(k)) || required.some(k => !own(o, k))) fail(`Invalid fields: expected ${allowed.join(', ')}`);
}
function str(s, name, max = 1000) { if (typeof s !== 'string' || !s.trim() || s.length > max) fail(`Invalid ${name}`); }
function number(n, name, min, max) { if (!Number.isFinite(n) || n < min || n > max) fail(`Invalid ${name}`); }
function locator(v) { keys(v, ['id']); str(v.id, 'selected AX candidate id', 256); }
function condition(c) {
  keys(c, ['kind', 'locator', 'property', 'equals']);
  if (c.kind !== 'ax') fail('Only AX conditions supported');
  locator(c.locator);
  const bool = ['exists', 'enabled', 'focused', 'selected'];
  if (bool.includes(c.property)) { if (typeof c.equals !== 'boolean') fail('Boolean condition expected'); }
  else if (['value', 'title'].includes(c.property)) { if (typeof c.equals !== 'string' || c.equals.length > 4000) fail('String condition expected'); }
  else fail('Unsupported AX property');
}
function target(t) {
  keys(t, ['bundleId', 'pid', 'processBirth', 'windowId']);
  str(t.bundleId, 'bundleId', 256); str(t.processBirth, 'processBirth', 256);
  if (!Number.isSafeInteger(t.pid) || t.pid <= 0) fail('Invalid pid');
  if (!(typeof t.windowId === 'string' && t.windowId.trim() && t.windowId.length <= 256) && !(Number.isSafeInteger(t.windowId) && t.windowId > 0)) fail('Invalid windowId');
}
export function validatePlan(plan) {
  keys(plan, ['schemaVersion', 'id', 'target', 'maxRecordingSeconds', 'steps']);
  if (plan.schemaVersion !== 1) fail('Unsupported plan schemaVersion');
  str(plan.id, 'plan id', 128); target(plan.target);
  number(plan.maxRecordingSeconds, 'maxRecordingSeconds', 1, 180);
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 30) fail('Expected 1–30 steps');
  const ids = new Set(); let totalHoldMs = 0;
  for (const step of plan.steps) {
    keys(step, ['id', 'narration', 'action', 'precondition', 'expected', 'holdMs'], ['id', 'narration', 'action', 'precondition', 'expected']);
    if (own(step, 'holdMs') && (!Number.isInteger(step.holdMs) || step.holdMs < 0 || step.holdMs > 30000)) fail('Invalid holdMs');
    totalHoldMs += step.holdMs ?? 0;
    str(step.id, 'step id', 128); str(step.narration, 'narration', 4000);
    if (ids.has(step.id)) fail('Duplicate step id'); ids.add(step.id);
    const a = step.action;
    if (!plain(a)) fail('Invalid action');
    if (['press', 'click'].includes(a.type)) keys(a, ['type', 'locator']);
    else if (a.type === 'scroll') { keys(a, ['type', 'locator', 'deltaX', 'deltaY']); number(a.deltaX, 'deltaX', -2000, 2000); number(a.deltaY, 'deltaY', -2000, 2000); if (a.deltaX === 0 && a.deltaY === 0) fail('Zero scroll'); }
    else if (a.type === 'type') { keys(a, ['type', 'locator', 'text']); str(a.text, 'text', 4000); }
    else fail('Unsupported action type');
    locator(a.locator); condition(step.precondition); condition(step.expected);
  }
  if (totalHoldMs >= plan.maxRecordingSeconds * 1000) fail('Total holdMs must be less than recording budget');
  return freeze(clone(plan));
}
export function hashPlan(plan) { return createHash('sha256').update(canonical(validatePlan(plan))).digest('hex'); }
function evidence(result, statuses) {
  if (!plain(result) || !statuses.includes(result.status) || !own(result, 'evidence')) throw new Error('Adapter returned missing/invalid evidence');
  if (!plain(result.evidence) || Object.keys(result.evidence).length === 0) throw new Error('Adapter evidence must be a nonempty JSON object');
  const jsonValue = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(jsonValue); return; }
    if (plain(value)) { Object.values(value).forEach(jsonValue); return; }
    throw new Error('Adapter evidence is not JSON');
  };
  jsonValue(result.evidence);
  const encoded = JSON.stringify(result.evidence);
  if (encoded === undefined || encoded.length > 65536) throw new Error('Adapter evidence must be JSON (<=64KiB)');
  // Reject functions, undefined and non-finite values instead of silently dropping them.
  if (canonical(result.evidence) !== canonical(JSON.parse(encoded))) throw new Error('Adapter evidence is not JSON');
  return clone(result);
}
class Halt extends Error { constructor(reason) { super(reason); this.reason = reason; } }
function message(error) { return String(error?.message || error).slice(0, 2000); }

/** Adapters are host-owned capabilities. This module never resolves locators or invokes OS APIs. */
export function createRunner({ adapters, clock = { now: () => performance.now() } } = {}) {
  for (const [group, method] of [['target', 'validate'], ['checks', 'evaluate'], ['action', 'execute'], ['capture', 'start'], ['capture', 'stop'], ['persistence', 'begin'], ['persistence', 'checkpoint'], ['persistence', 'finish']]) {
    if (typeof adapters?.[group]?.[method] !== 'function') fail(`Required adapter ${group}.${method}`);
  }
  if (typeof clock?.now !== 'function') fail('Required clock.now');
  return { async run({ plan: input, host, signal, resume } = {}) {
    const plan = validatePlan(input);
    if (!host || typeof host.onStop !== 'function') fail('Host must register a visible stop control via onStop');
    str(host.botId, 'existing host botId', 256); str(host.taskId, 'existing host taskId', 256);
    const binding = freeze({ planId: plan.id, planHash: hashPlan(plan), host: { botId: host.botId, taskId: host.taskId }, target: plan.target });
    const key = `host:${canonical(binding.host)}`;
    const targetKey = `target:${canonical(binding.target)}`;
    if (active.has(key) || active.has(targetKey)) throw new Error('Run already active for this host Bot/task or target');
    if (resume !== undefined) {
      if (!plain(resume) || resume.schemaVersion !== 1 || canonical(resume.binding) !== canonical(binding) || !Array.isArray(resume.timeline) || resume.timeline.length !== plan.steps.length || !Array.isArray(resume.events)) fail('Resume binding/schema mismatch');
      for (let i = 0; i < plan.steps.length; i++) if (resume.timeline[i]?.stepId !== plan.steps[i].id || !['pending', 'checking', 'started', 'verified', 'holding', 'unknown', 'blocked'].includes(resume.timeline[i]?.status)) fail('Invalid resumed timeline');
      let previous = -Infinity;
      for (const [i, e] of resume.events.entries()) {
        if (!plain(e) || e.seq !== i + 1 || !Number.isFinite(e.at) || e.at < previous || canonical(e.binding) !== canonical(binding)) fail('Invalid resumed event binding/order');
        str(e.type, 'event type', 128); previous = e.at;
      }
    }
    active.add(key); active.add(targetKey);
    const controller = new AbortController();
    const cleanupSignal = new AbortController().signal;
    let lease, unsubscribe, timer, captureAttempted = false, captureStart, stopPromise, current, stopReason;
    let state = { schemaVersion: 1, binding, status: 'running', reason: null, capture: { status: 'pending' }, timeline: plan.steps.map(s => ({ stepId: s.id, narration: s.narration, holdMs: s.holdMs ?? 0, status: 'pending' })), events: [] };
    let lastTime = -Infinity;
    const now = () => { const n = clock.now(); if (!Number.isFinite(n) || n < lastTime) throw new Error('Clock must be finite and monotonic'); lastTime = n; return n; };
    const event = (type, detail = {}) => {
      // A restarted process has a different monotonic clock origin. Preserve the original timeline.
      const events = resume === undefined ? state.events : (state.recoveryEvents ||= []);
      events.push({ seq: events.length + 1, at: now(), type, binding, ...clone(detail) });
    };
    // AbortSignal must remain live; do not deep-freeze its internals.
    const context = extra => ({ binding, signal: controller.signal, ...extra });
    const guard = () => { if (controller.signal.aborted) throw new Halt(stopReason || 'cancelled'); };
    const stopCapture = () => {
      if (!captureAttempted) return Promise.resolve();
      if (!stopPromise) stopPromise = (async () => {
        try { await captureStart; } catch { /* start may have had an uncertain effect; still stop own capture */ }
        const result = evidence(await adapters.capture.stop({ binding, signal: cleanupSignal, reason: stopReason || state.reason || 'finished' }), ['stopped', 'unknown']);
        state.capture.stopEvidence = result.evidence;
        if (result.status !== 'stopped') throw new Error('Capture stop is unknown');
        state.capture.status = 'stopped'; state.capture.stoppedAt = now();
        event('capture_stopped', { evidence: result.evidence });
      })();
      return stopPromise;
    };
    const cancel = (reason = 'cancelled') => {
      if (controller.signal.aborted) return;
      stopReason = reason === 'recording_limit' ? reason : 'cancelled';
      controller.abort(stopReason);
      // Stop recording even if an action adapter has not yet settled. The host must abort/drain it.
      void stopCapture().catch(() => {});
    };
    const externalAbort = () => cancel();
    const boundary = async work => { guard(); const value = await work(); guard(); return value; };
    const save = async () => { await boundary(async () => { try { await adapters.persistence.checkpoint(lease, clone(state)); } catch (error) { throw new Halt(`persistence_failed: ${message(error)}`); } }); };
    const checkTarget = async () => {
      const r = evidence(await boundary(() => adapters.target.validate(plan.target, context({ stepId: current?.stepId }))), ['pass', 'fail', 'unknown']);
      event('target_check', { stepId: current?.stepId ?? null, result: r });
      if (r.status !== 'pass' || canonical(r.identity) !== canonical(plan.target)) throw new Halt(r.status === 'unknown' ? 'target_unknown' : 'target_changed');
    };
    const checkCondition = async (c, phase, recheck = false) => {
      const r = evidence(await boundary(() => adapters.checks.evaluate(c, context({ stepId: current.stepId, phase }))), ['pass', 'fail', 'unknown']);
      current[recheck ? 'holdExpectedEvidence' : `${phase}Evidence`] = r;
      const eventPhase = recheck ? 'hold_expected' : phase;
      event(`${eventPhase}_check`, { stepId: current.stepId, result: r });
      if (r.status !== 'pass') throw new Halt(`${eventPhase}_${r.status}`);
    };
    try {
      signal?.addEventListener('abort', externalAbort, { once: true });
      if (signal?.aborted) cancel();
      unsubscribe = host.onStop(() => cancel(), binding);
      if (typeof unsubscribe !== 'function') throw new Error('host.onStop must return unsubscribe');
      guard();
      // begin must exclusively claim this binding/output directory; it must never overwrite a prior run.
      lease = await adapters.persistence.begin(binding, { resume: resume === undefined ? null : clone(resume) });
      guard();
      if (lease === undefined || lease === null) throw new Error('Missing persistence lease');
      if (resume !== undefined) {
        state = clone(resume); state.status = 'paused'; state.reason = 'recovered_requires_replan';
        state.recoveryEvents = [];
        for (const item of state.timeline) {
          if (item.status === 'started') item.status = 'unknown';
          // The action was verified, but the recorded hold was interrupted. Never wait or replay it on recovery.
          else if (item.status === 'holding') item.status = 'blocked';
        }
        event('recovered_no_replay');
        await save();
      } else {
        event('run_started'); await save(); await checkTarget(); await save();
        guard(); captureAttempted = true;
        state.capture = { status: 'starting', requestedAt: now() };
        timer = setTimeout(() => cancel('recording_limit'), plan.maxRecordingSeconds * 1000);
        captureStart = Promise.resolve().then(() => adapters.capture.start(context({ maxRecordingSeconds: plan.maxRecordingSeconds })));
        const ready = evidence(await captureStart, ['ready', 'unknown']);
        if (ready.status !== 'ready' || !Number.isFinite(ready.readyAt) || ready.readyAt < state.capture.requestedAt || ready.readyAt > now()) throw new Halt('capture_not_ready');
        state.capture = { ...state.capture, status: 'recording', readyAt: ready.readyAt, startEvidence: ready.evidence };
        guard(); event('capture_ready', { readyAt: ready.readyAt, evidence: ready.evidence }); await save();
        for (let i = 0; i < plan.steps.length; i++) {
          guard(); current = state.timeline[i]; const step = plan.steps[i];
          current.status = 'checking'; current.startedAt = now(); event('step_started', { stepId: step.id }); await save();
          await checkTarget(); await checkCondition(step.precondition, 'precondition');
          // Recheck immediately before action, since checks can take time or move focus.
          await checkTarget(); await save(); guard();
          current.status = 'started'; current.actionStartedAt = now(); event('action_started', { stepId: step.id });
          await save();
          // Durable intent can take time; validate again after it, immediately before invoking action.
          await checkTarget();
          const result = evidence(await boundary(() => adapters.action.execute(step.action, context({ stepId: step.id }))), ['performed', 'rejected', 'unknown']);
          current.actionFinishedAt = now(); current.actionEvidence = result;
          event('action_result', { stepId: step.id, result });
          if (result.status !== 'performed') throw new Halt(`action_${result.status}`);
          await save(); await checkTarget(); await checkCondition(step.expected, 'expected');
          current.status = 'verified'; current.verifiedAt = now(); event('step_verified', { stepId: step.id }); await save();
          if (current.holdMs > 0) {
            current.status = 'holding'; current.holdStartedAt = now();
            event('step_hold_started', { stepId: step.id, holdMs: current.holdMs }); await save();
            // Real elapsed time, independent of an injected test clock. No synthetic timestamps or frame padding.
            const deadline = performance.now() + current.holdMs;
            do { await boundary(() => sleep(Math.max(1, Math.ceil(deadline - performance.now())), undefined, { signal: controller.signal })); } while (performance.now() < deadline);
            await checkTarget(); await checkCondition(step.expected, 'expected', true);
            current.holdFinishedAt = now(); current.status = 'verified';
            event('step_hold_finished', { stepId: step.id, holdMs: current.holdMs });
          }
          current.completedAt = now(); event('step_completed', { stepId: step.id }); await save();
        }
        await stopCapture(); guard();
        state.status = 'completed'; state.reason = null; event('run_completed'); await save();
      }
    } catch (error) {
      const reason = controller.signal.aborted ? stopReason : error instanceof Halt ? error.reason : 'adapter_error';
      state.status = reason === 'cancelled' ? 'cancelled' : 'paused'; state.reason = reason;
      state.error = message(error);
      if (current?.status === 'holding') {
        try { event('step_hold_interrupted', { stepId: current.stepId, reason }); } catch { /* original error retained */ }
      }
      if (current && current.status !== 'verified') current.status = current.status === 'started' ? 'unknown' : 'blocked';
      try { event('run_halted', { reason, error: state.error }); } catch { /* invalid clock already explains halt */ }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', externalAbort);
      try { await stopCapture(); } catch (error) { state.status = state.status === 'cancelled' ? 'cancelled' : 'paused'; state.reason = 'capture_stop_failed'; state.capture.status = 'unknown'; state.capture.error = message(error); }
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (error) { state.status = 'paused'; state.reason = 'host_stop_cleanup_failed'; state.error = message(error); }
      // Cleanup persists even after cancellation. A failure is never reported as success.
      try { if (lease !== undefined && lease !== null) await adapters.persistence.finish(lease, clone(state)); }
      catch (error) { state.status = state.status === 'cancelled' ? 'cancelled' : 'paused'; state.reason = 'persistence_failed'; state.error = message(error); }
      active.delete(key); active.delete(targetKey);
    }
    return clone(state);
  } };
}
