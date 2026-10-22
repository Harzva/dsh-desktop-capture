import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AXProtocolError extends Error {
  constructor(code, message, effect = 'none', evidence) { super(message); this.name = 'AXProtocolError'; this.code = code; this.effect = effect; if (evidence !== undefined) this.nativeEvidence = structuredClone(evidence); }
}
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
function exact(o, fields) { if (!plain(o) || Object.keys(o).some(k => !fields.includes(k)) || fields.some(k => !Object.hasOwn(o, k))) throw new TypeError(`Expected ${fields.join(',')}`); }
export function validateTarget(t) {
  exact(t, ['bundleId', 'pid', 'processBirth', 'windowId']);
  if (typeof t.bundleId !== 'string' || !t.bundleId.trim() || t.bundleId.length > 256 || !Number.isSafeInteger(t.pid) || t.pid < 1 || t.pid > 2147483647 || typeof t.processBirth !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(t.processBirth) || !Number.isFinite(Number(t.processBirth)) || Number(t.processBirth) <= 0 || !Number.isSafeInteger(t.windowId) || t.windowId < 1 || t.windowId > 4294967295) throw new TypeError('Invalid explicit AX target');
  return { ...t };
}
export function validateAction(a) {
  if (!plain(a)) throw new TypeError('Invalid action');
  const fields = ['press', 'click'].includes(a.type) ? ['type', 'locator'] : a.type === 'type' ? ['type', 'locator', 'text'] : a.type === 'scroll' ? ['type', 'locator', 'deltaX', 'deltaY'] : [];
  if (!fields.length) throw new TypeError('Unsupported action'); exact(a, fields); validateLocator(a.locator);
  if (a.type === 'type' && (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 4000)) throw new TypeError('Invalid text');
  if (a.type === 'scroll' && (![a.deltaX, a.deltaY].every(v => Number.isFinite(v) && Math.abs(v) <= 2000) || (!a.deltaX && !a.deltaY))) throw new TypeError('Invalid scroll');
  return a;
}
function validateLocator(l) { exact(l, ['id']); if (typeof l.id !== 'string' || !/^[a-f0-9-]{36}:\d+$/.test(l.id)) throw new TypeError('Invalid opaque locator'); }
export function validateCondition(c) {
  exact(c, ['kind', 'locator', 'property', 'equals']); validateLocator(c.locator);
  if (c.kind !== 'ax' || (['exists', 'enabled', 'focused', 'selected'].includes(c.property) ? typeof c.equals !== 'boolean' : ['value', 'title'].includes(c.property) ? typeof c.equals !== 'string' || c.equals.length > 4000 : true)) throw new TypeError('Unsupported condition');
  return c;
}

/** A single private stdio process. No auto restart, request queue, shell, or replay. */
export class AXClient {
  #child; #pending; #buffer = Buffer.alloc(0); #fenced = false; #stderrBytes = 0;
  #activationAttempted = false; #exit; #closed; #spawnError; #closure; #resolveClosure;
  constructor({ binary, timeoutMs = 5000, maxResponseBytes = 262144 } = {}) {
    if (typeof binary !== 'string' || !isAbsolute(binary) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 262144) throw new TypeError('Explicit absolute native binary and bounded limits required');
    this.timeoutMs = timeoutMs; this.maxResponseBytes = maxResponseBytes;
    this.#closure = new Promise(resolve => { this.#resolveClosure = resolve; });
    this.#child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.#child.stdout.on('data', b => this.#receive(b));
    this.#child.stderr.on('data', b => { this.#stderrBytes += b.length; if (this.#stderrBytes > 65536) this.#fence('stderr_limit', 'Native stderr limit exceeded'); });
    this.#child.on('error', e => { this.#spawnError = e.message; this.#fence('native_error', e.message); });
    this.#child.once('exit', (code, signal) => { this.#exit = {code, signal}; this.#fence('native_exit', `Native helper exited (${code ?? signal})`); });
    this.#child.once('close', (code, signal) => {
      this.#closed = {pid: this.#child.pid ?? null, code, signal, exitObserved: !!this.#exit, closeObserved: true, ...(this.#spawnError ? {spawnError: this.#spawnError} : {})};
      this.#resolveClosure(this.#closed);
    });
    this.#child.stdin.on('error', e => this.#fence('write_failed', e.message));
  }
  get fenced() { return this.#fenced; }
  #fence(code, text) {
    if (this.#fenced) return; this.#fenced = true;
    const p = this.#pending; this.#pending = undefined;
    if (p) { clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort); p.reject(new AXProtocolError(code, text, p.mutation ? 'unknown' : 'none')); }
    this.#child.stdin.destroy(); this.#child.kill('SIGTERM');
  }
  #receive(bytes) {
    if (this.#fenced) return;
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    if (this.#buffer.length > this.maxResponseBytes) return this.#fence('output_limit', 'Native response exceeds byte limit');
    let index;
    while ((index = this.#buffer.indexOf(10)) >= 0) {
      const line = this.#buffer.subarray(0, index); this.#buffer = this.#buffer.subarray(index + 1);
      let response; try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { return this.#fence('malformed_response', 'Invalid native JSON/UTF-8'); }
      const p = this.#pending;
      if (!p || !plain(response) || response.requestId !== p.id || typeof response.ok !== 'boolean' || Object.keys(response).some(k => !['requestId', 'ok', 'result', 'error'].includes(k))) return this.#fence('protocol_mismatch', 'Unexpected native response/requestId');
      if (response.ok && (!plain(response.result) || Object.hasOwn(response, 'error')) || !response.ok && (!plain(response.error) || typeof response.error.code !== 'string' || typeof response.error.message !== 'string' || Object.keys(response.error).some(k => !['code', 'message', 'effect', 'evidence'].includes(k)) || (Object.hasOwn(response.error, 'evidence') && (!plain(response.error.evidence) || JSON.stringify(response.error.evidence).length > 65536)) || !['none', 'unknown'].includes(response.error.effect) || Object.hasOwn(response, 'result'))) return this.#fence('malformed_response', 'Invalid native result/error');
      this.#pending = undefined; clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort);
      if (response.ok) p.resolve(response.result);
      else {
        p.reject(new AXProtocolError(response.error.code, response.error.message, response.error.effect, response.error.evidence));
        // Every native failure fences this process. A caller must explicitly create/select a new session.
        this.#fence('native_fenced', response.error.message);
      }
    }
  }
  request(op, payload = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.#fenced) return Promise.reject(new AXProtocolError('fenced', 'Helper is fenced; explicit new host session required'));
    if (this.#pending) return Promise.reject(new AXProtocolError('busy', 'One request is already active; no implicit queue'));
    if (!['probe', 'enumerate', 'select', 'inspect', 'validate', 'check', 'action', 'activate'].includes(op) || !plain(payload) || ownProtocolKey(payload)) return Promise.reject(new TypeError('Invalid native request'));
    if (signal?.aborted) return Promise.reject(new AXProtocolError('cancelled', 'Cancelled before send'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) return Promise.reject(new TypeError('Invalid timeout'));
    if (op === 'activate') {
      try { exact(payload, ['target']); validateTarget(payload.target); } catch (error) { return Promise.reject(error); }
      if (this.#activationAttempted) return Promise.reject(new AXProtocolError('activation_already_attempted', 'One activation attempt per helper session'));
    }
    const id = randomUUID(); let bytes;
    try { bytes = Buffer.from(`${JSON.stringify({ requestId: id, op, ...payload })}\n`); } catch (e) { return Promise.reject(e); }
    if (bytes.length > 32768) return Promise.reject(new AXProtocolError('input_limit', 'Native request exceeds 32KiB'));
    if (op === 'activate') this.#activationAttempted = true;
    return new Promise((resolve, reject) => {
      const abort = () => this.#fence('cancelled', 'Cancelled in flight; native outcome is uncertain');
      const timer = setTimeout(() => this.#fence('timeout', 'Native request timed out; session fenced'), timeoutMs);
      this.#pending = { id, resolve, reject, timer, signal, abort, mutation: op === 'action' || op === 'activate' };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      this.#child.stdin.write(bytes, e => { if (e) this.#fence('write_failed', e.message); });
    });
  }
  probe(options) { return this.request('probe', {}, options); }
  enumerate(options) { return this.request('enumerate', {}, options); }
  select(target, options) { return this.request('select', { target: validateTarget(target) }, options); }
  activate(target, options) { return this.request('activate', { target: validateTarget(target) }, options); }
  inspect(limits = {}, options) {
    if (!plain(limits) || Object.keys(limits).some(k => !['maxNodes', 'maxDepth', 'maxBytes', 'timeoutMs'].includes(k))) throw new TypeError('Invalid inspect limits');
    for (const [key, max] of [['maxNodes', 300], ['maxDepth', 20], ['maxBytes', 131072], ['timeoutMs', 3000]]) if (Object.hasOwn(limits, key) && (!Number.isInteger(limits[key]) || limits[key] < (key === 'maxBytes' ? 1024 : 1) || limits[key] > max)) throw new TypeError(`Invalid ${key}`);
    return this.request('inspect', { limits }, options);
  }
  close() { this.#fence('closed', 'Host closed native helper'); }
  async closeAndWait({timeoutMs = 5000} = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid cleanup timeout');
    this.close();
    let timer;
    const unconfirmed = () => new AXProtocolError('AX_CLEANUP_UNCONFIRMED', 'Owned helper physical exit/stdio closure is not confirmed', 'none', {
      pid: this.#child.pid ?? null, exitObserved: !!this.#exit, closeObserved: !!this.#closed, timeoutMs,
    });
    try {
      const result = await Promise.race([this.#closure, new Promise((_, reject) => { timer = setTimeout(() => reject(unconfirmed()), timeoutMs); })]);
      const noProcessSpawned = result.pid === null && !!result.spawnError;
      if (!result.exitObserved && !noProcessSpawned) throw unconfirmed();
      return {status: 'closed', evidence: {...result, physicalExitConfirmed: result.exitObserved, noProcessSpawned}};
    } finally { clearTimeout(timer); }
  }
}
function ownProtocolKey(p) { return ['requestId', 'op'].some(k => Object.hasOwn(p, k)); }
function errorEvidence(e) { return { native: true, code: e.code || 'adapter_error', message: String(e.message || e).slice(0, 2000), effect: e.effect || 'none', ...(e.nativeEvidence ? { nativeEvidence: structuredClone(e.nativeEvidence) } : {}) }; }
export function createAXAdapters({ client } = {}) {
  if (!(client instanceof AXClient)) throw new TypeError('AXClient required');
  return {
    target: { validate: async (identity, ctx = {}) => { try { return await client.request('validate', { target: validateTarget(identity) }, ctx); } catch (e) { return { status: 'unknown', evidence: errorEvidence(e) }; } } },
    checks: { evaluate: async (condition, ctx = {}) => { try { return await client.request('check', { target: validateTarget(ctx.binding?.target), condition: validateCondition(condition) }, ctx); } catch (e) { return { status: 'unknown', evidence: errorEvidence(e) }; } } },
    action: { execute: async (action, ctx = {}) => { try { return await client.request('action', { target: validateTarget(ctx.binding?.target), action: validateAction(action) }, ctx); } catch (e) { return { status: e.effect === 'unknown' ? 'unknown' : 'rejected', evidence: errorEvidence(e) }; } } },
  };
}
