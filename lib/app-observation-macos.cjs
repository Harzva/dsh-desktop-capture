'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const MAX_FILE = 64 * 1024 * 1024;
const TARGET_TTL = 10 * 60 * 1000;
const TARGET_ID = /^[a-f0-9]{32}$/;
const error = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => error('APP_OBSERVATION_UNAVAILABLE', '目标应用窗口已关闭、隐藏或不可用，请切换到目标应用后重试');
const identity = app => app && Number.isSafeInteger(app.pid) && app.pid > 0 && typeof app.bundle === 'string' && app.bundle.length <= 1024 &&
  typeof app.name === 'string' && app.name.length <= 1024 && Number.isFinite(app.launchDate) && app.launchDate > 0;
const same = (a, b) => a.pid === b.pid && a.bundle === b.bundle && a.launchDate === b.launchDate;

class MacAppCapture {
  constructor({ electron, ownPid = process.pid, platform = process.platform, spawnProcess = spawn, fileSystem = fs,
    tempRoot = os.tmpdir(), scriptPath = path.join(__dirname, 'app-observation-macos.jxa'), now = Date.now,
    captureTimeout = 15000, queryTimeout = 5000, killGrace = 250, killTimeout = 1500 } = {}) {
    Object.assign(this, { electron, ownPid, platform, spawnProcess, fs: fileSystem, tempRoot, scriptPath,
      now, captureTimeout, queryTimeout, killGrace, killTimeout });
    this.lifetime = new AbortController(); this.children = new Set(); this.pendingCaptures = new Set(); this.targets = new Map(); this.closed = false; this.busy = false;
  }
  _check(signal) {
    if (this.closed) throw error('APP_OBSERVATION_CLOSED', '截图服务已关闭');
    if (signal?.aborted) throw this._cancelled(signal);
  }
  _cancelled(signal) {
    return this.closed ? error('APP_OBSERVATION_CLOSED', '截图服务已关闭') :
      signal?.reason?.code === 'APP_OBSERVATION_TIMEOUT' ? signal.reason : error('ABORTED', '截图已取消');
  }
  async _guard(guard, signal) {
    this._check(signal);
    let aborted;
    const cancelled = new Promise((resolve, reject) => {
      aborted = () => reject(this._cancelled(signal));
      signal.addEventListener('abort', aborted, { once: true });
    });
    try { await Promise.race([Promise.resolve().then(() => { this._check(signal); return guard(); }), cancelled]); this._check(signal); }
    finally { signal.removeEventListener('abort', aborted); }
  }
  _permission() { return this.platform === 'darwin' ? this.electron.systemPreferences.getMediaAccessStatus('screen') : 'unsupported'; }
  status() { return { screenPermission: this._permission(), supported: this.platform === 'darwin' && !this.closed }; }
  _requirePermission() {
    if (this._permission() !== 'granted') throw error('APP_OBSERVATION_PERMISSION_REQUIRED', '请在系统设置中允许 OpenBot 录制屏幕');
  }
  _pruneTargets() {
    for (const [id, target] of this.targets) if (target.expiresAt <= this.now()) this.targets.delete(id);
    while (this.targets.size > 256) this.targets.delete(this.targets.keys().next().value);
  }
  _launch(command, args, { signal, timeout, input, onLine, maxOutput = 65536 } = {}) {
    this._check(signal);
    const child = this.spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let resolve, reject, failure, settled = false, closing = false, buffer = '', bytes = 0, stderrBytes = 0;
    const timers = [], decoder = new StringDecoder('utf8');
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const record = { child, done, stop: null };
    this.children.add(record);
    const finish = (cause, closed) => {
      if (closed) this.children.delete(record);
      if (settled) return;
      settled = true; timers.forEach(clearTimeout); signal?.removeEventListener('abort', aborted);
      cause ? reject(cause) : resolve();
    };
    const stop = cause => {
      if (cause && !failure) failure = cause;
      if (closing || settled) return done;
      closing = true;
      try { child.kill('SIGTERM'); } catch (e) { failure ||= e; }
      timers.push(setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { failure ||= e; }
        timers.push(setTimeout(() => finish(error('APP_OBSERVATION_CLOSE_FAILED', '截图子进程未能关闭'), false), this.killTimeout));
      }, this.killGrace));
      return done;
    };
    record.stop = stop;
    const aborted = () => { stop(this._cancelled(signal)); };
    child.on('error', e => { failure ||= error('APP_OBSERVATION_HELPER_FAILED', e.message); stop(failure); });
    child.on('close', (code, sig) => {
      if (!failure && !closing && (code !== 0 || sig)) failure = error('APP_OBSERVATION_HELPER_FAILED', '系统截图进程失败');
      if (!failure && buffer.trim()) failure = error('APP_OBSERVATION_PROTOCOL', '系统进程返回不完整数据');
      finish(failure, true);
    });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutput) return stop(error('APP_OBSERVATION_LIMIT', '系统进程输出过大'));
      if (!onLine) return;
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { if (line) onLine(JSON.parse(line), child.pid); }
        catch (e) { stop(e.code ? e : error('APP_OBSERVATION_PROTOCOL', '应用跟踪数据无效')); break; }
      }
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop(error('APP_OBSERVATION_LIMIT', '系统进程输出过大')); });
    if (timeout) timers.push(setTimeout(() => stop(error('APP_OBSERVATION_TIMEOUT', '系统截图操作超时')), timeout));
    signal?.addEventListener('abort', aborted, { once: true });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    if (signal?.aborted) aborted();
    // The owner may attach its result handler after requesting cancellation.
    done.catch(() => {});
    return record;
  }
  async start() {
    this._check();
    if (this.platform !== 'darwin' || this.script) return;
    if (!this.starting) this.starting = this.fs.readFile(this.scriptPath, 'utf8').then(script => { this._check(); this.script = script; });
    try { await this.starting; } finally { this.starting = null; }
  }
  async _request(mode, request, signal) {
    await this.start(); this._check(signal);
    let result;
    const rec = this._launch('/usr/bin/osascript', ['-l', 'JavaScript', '-', mode, JSON.stringify(request)],
      { input: this.script, signal, timeout: this.queryTimeout, maxOutput: mode === 'list' ? 1024 * 1024 : 65536, onLine: value => {
        if (result !== undefined) throw error('APP_OBSERVATION_PROTOCOL', '系统进程返回重复数据'); result = value;
      } });
    await rec.done; this._check(signal);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('APP_OBSERVATION_PROTOCOL', '应用窗口数据无效');
    return result;
  }
  async _query(app, windowId, signal) {
    const result = await this._request('query', { app, windowId }, signal);
    if (result.error) throw unavailable();
    if (!identity(result.app) || !same(result.app, app) || result.windowId !== windowId) throw unavailable();
    return windowId;
  }
  // Resolve the opaque capability once; subsequent validation keeps that exact identity.
  async resolveRecordingTarget(targetId, { signal, guard = () => {} } = {}) {
    this._check(signal); this._requirePermission(); this._pruneTargets();
    const selected = typeof targetId === 'string' && TARGET_ID.test(targetId) ? this.targets.get(targetId) : null;
    if (!selected) throw unavailable();
    const app = Object.freeze({ ...selected.app });
    const windowId = selected.windowId;
    const validate = async () => {
      this._check(signal); await guard(); this._requirePermission();
      await this._query(app, windowId, signal); this._check(signal);
    };
    await validate();
    return Object.freeze({ app, windowId, validate });
  }
  listApplications(options) { return this._operation(context => this._list(context), options, this.queryTimeout); }
  async _list({ signal, guard = () => {} }) {
    this._check(signal);
    if (this.platform !== 'darwin') throw unavailable();
    if (this.busy) throw error('APP_OBSERVATION_BUSY', '正在读取或截取应用窗口，请稍候');
    this.busy = true;
    try {
      await this._guard(guard, signal); this._requirePermission();
      const result = await this._request('list', { ownPid: this.ownPid }, signal);
      await this._guard(guard, signal); this._requirePermission();
      if (!Array.isArray(result.applications) || result.applications.length > 100) throw error('APP_OBSERVATION_PROTOCOL', '应用列表数据无效');
      // Validate the whole response before publishing any new target capability.
      for (const target of result.applications) {
        if (!identity(target?.app) || target.app.pid === this.ownPid || target.app.bundle === 'com.apple.osascript' || target.app.name === 'osascript' ||
          !Number.isSafeInteger(target.windowId) || target.windowId <= 0 || typeof target.windowTitle !== 'string' || target.windowTitle.length > 256) {
          throw error('APP_OBSERVATION_PROTOCOL', '应用列表数据无效');
        }
      }
      this._pruneTargets();
      const applications = result.applications.map(target => {
        const key = JSON.stringify([target.app.pid, target.app.bundle, target.app.launchDate, target.windowId]);
        let targetId = [...this.targets].find(([, item]) => item.key === key)?.[0];
        if (!targetId) do { targetId = crypto.randomBytes(16).toString('hex'); } while (this.targets.has(targetId));
        // Refresh order/expiry for rediscovered windows without changing their ID.
        this.targets.delete(targetId);
        this.targets.set(targetId, { ...target, key, expiresAt: this.now() + TARGET_TTL });
        return { targetId, name: target.app.name, windowTitle: target.windowTitle };
      });
      this._pruneTargets();
      return { ok: true, applications };
    } finally { this.busy = false; }
  }
  _operation(run, options, timeout) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(error('APP_OBSERVATION_TIMEOUT', '系统截图操作超时')), timeout);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options?.signal ? [options.signal] : [])]);
    const pending = run({ ...options, signal });
    this.pendingCaptures.add(pending);
    const clear = () => { clearTimeout(timer); this.pendingCaptures.delete(pending); };
    pending.then(clear, clear);
    return pending;
  }
  capture(source, options) { return this._operation(context => this._capture(source, context), options, this.captureTimeout); }
  async _capture(source, { signal, guard = () => {}, targetId } = {}) {
    this._check(signal);
    if ((source !== 'application' && source !== 'screen') || (source === 'screen' && targetId !== undefined)) throw error('APP_OBSERVATION_INVALID', '截图来源无效');
    if (this.platform !== 'darwin') throw unavailable();
    if (this.busy) throw error('APP_OBSERVATION_BUSY', '正在截图，请稍候');
    this.busy = true;
    let directory;
    try {
      await this._guard(guard, signal); this._check(signal);
      if (this._permission() !== 'granted') throw error('APP_OBSERVATION_PERMISSION_REQUIRED', '请在系统设置中允许 OpenBot 录制屏幕');
      let target, windowId, args, metadata;
      if (source === 'application') {
        this._pruneTargets();
        const selected = typeof targetId === 'string' && TARGET_ID.test(targetId) ? this.targets.get(targetId) : null;
        if (!selected) throw unavailable();
        target = selected.app;
        windowId = await this._query(target, selected.windowId, signal);
        args = ['-x', '-o', '-l', String(windowId), '-t', 'png'];
        metadata = { source, sourceLabel: '应用窗口', targetName: target.name, windowTitle: this.targets.get(targetId)?.windowTitle || '', windowId };
      } else {
        const display = this.electron.screen.getDisplayNearestPoint(this.electron.screen.getCursorScreenPoint());
        const b = display?.bounds;
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isSafeInteger) || b.width <= 0 || b.height <= 0) throw unavailable();
        args = ['-x', '-R', [b.x, b.y, b.width, b.height].join(','), '-t', 'png'];
        metadata = { source, sourceLabel: '当前屏幕', targetName: display.label || '当前屏幕', displayId: display.id };
      }
      await this._guard(guard, signal); this._check(signal);
      directory = await this.fs.mkdtemp(path.join(this.tempRoot, 'openbot-observation-'));
      await this.fs.chmod(directory, 0o700); this._check(signal);
      const filename = path.join(directory, 'capture.png');
      await this.fs.writeFile(filename, '', { flag: 'wx', mode: 0o600 });
      if (this._permission() !== 'granted') throw error('APP_OBSERVATION_PERMISSION_REQUIRED', '请在系统设置中允许 OpenBot 录制屏幕');
      await this._launch('/usr/sbin/screencapture', [...args, filename], { signal, timeout: this.captureTimeout }).done;
      this._check(signal);
      if (target) await this._query(target, windowId, signal);
      await this._guard(guard, signal); this._check(signal);
      if (this._permission() !== 'granted') throw error('APP_OBSERVATION_PERMISSION_REQUIRED', '屏幕录制权限已改变，请重新授权');
      const handle = await this.fs.open(filename, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
      let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE) throw error('APP_OBSERVATION_LIMIT', '截图为空或过大');
        await handle.chmod(0o600); bytes = await handle.readFile();
        if (!bytes.length || bytes.length > MAX_FILE) throw error('APP_OBSERVATION_LIMIT', '截图为空或过大');
      } finally { await handle.close(); }
      const image = this.electron.nativeImage.createFromBuffer(bytes);
      if (!image || image.isEmpty()) throw error('APP_OBSERVATION_EMPTY', '系统截图为空');
      this._check(signal);
      return { image, metadata };
    } finally {
      try { if (directory) await this.fs.rm(directory, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.targets.clear(); this.lifetime.abort();
    this.closing = (async () => {
      const records = [...this.children];
      const results = await Promise.allSettled(records.map(rec => rec.stop(error('APP_OBSERVATION_CLOSED', '截图服务已关闭'))));
      await Promise.allSettled([...this.pendingCaptures, ...(this.starting ? [this.starting] : [])]);
      const failed = results.find(result => result.status === 'rejected' && result.reason.code === 'APP_OBSERVATION_CLOSE_FAILED');
      if (failed) throw failed.reason;
    })().catch(cause => { this.closing = null; throw cause; });
    return this.closing;
  }
}
module.exports = { MacAppCapture };
