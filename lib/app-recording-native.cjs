'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const err = (code, message) => Object.assign(new Error(message), { code });
const limit = 128 * 1024 * 1024;
const DEFAULT_AUDIO_MODE = 'system-and-microphone';
const AUDIO_MODES = ['system', DEFAULT_AUDIO_MODE];
const OWNED_OPTIONS = new Set(['outputDir', 'audioMode', 'maxDurationSeconds', 'signal', 'guard', 'cleanupGuard', 'recordingId', 'scope']);
const targetKeys = ['bundle', 'launchDate', 'pid', 'windowId'];
const validTarget = target => target && Object.keys(target).sort().join() === targetKeys.join() &&
  Number.isSafeInteger(target.windowId) && target.windowId > 0 && Number.isSafeInteger(target.pid) && target.pid > 0 &&
  typeof target.bundle === 'string' && target.bundle.length <= 256 && Number.isFinite(target.launchDate) && target.launchDate > 0;
const sameTarget = (a, b) => validTarget(a) && validTarget(b) && targetKeys.every(key => a[key] === b[key]);
const targetCheckFailure = error => ['APP_RECORDING_TARGET_CLOSED', 'APP_OBSERVATION_UNAVAILABLE', 'TARGET_CLOSED'].includes(error?.code);
const DIAGNOSTIC_PREFIX = 'OPENBOT_RECORDING_DIAGNOSTIC ';
const DIAGNOSTIC_PHASES = new Set(['content-requested', 'content-ready', 'streams-configured',
  'system-start-requested', 'system-start-completed', 'system-start-failed', 'system-start-returned',
  'video-start-requested', 'video-start-completed', 'video-start-failed', 'video-start-returned',
  'recording-started', 'first-system-audio', 'first-microphone', 'first-video', 'system-stop-before-ready',
  'media-video-missing', 'media-audio-missing', 'media-duration-nonfinite', 'media-duration-empty', 'media-duration-overlimit']);
function diagnosticEvent(line) {
  if (!line.startsWith(DIAGNOSTIC_PREFIX) || line.length > 512) return;
  try {
    const value = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
        !DIAGNOSTIC_PHASES.has(value.phase) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 3600000 ||
        Object.keys(value).some(key => !['schemaVersion', 'phase', 'elapsedMs', 'sampleCount'].includes(key))) return;
    const sample = value.phase.startsWith('first-');
    if (sample ? !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 1 || value.sampleCount > 1000000 : value.sampleCount !== undefined) return;
    return { phase: value.phase, elapsedMs: value.elapsedMs, ...(sample ? { sampleCount: value.sampleCount } : {}) };
  } catch {} // Unrecognized native stderr is never copied into an error or log.
}
class MacRecordingBackend {
  constructor({ electron, capture, getWindow, helperPath, platform = process.platform, release = os.release(), spawnProcess = spawn, closeTimeout = 6000 } = {}) {
    Object.assign(this, { electron, capture, getWindow, platform, release, spawnProcess, closeTimeout });
    this.helperPath = helperPath || path.join(__dirname, '..', 'native', 'recording-helper');
    this.active = false; this.blocked = false; this.sessionChild = null; this.currentSession = null;
  }
  status() {
    let executable = false;
    try {
      const stat = fs.lstatSync(this.helperPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && (stat.mode & 0o111)) {
        fs.accessSync(this.helperPath, fs.constants.X_OK); executable = true;
      }
    } catch {}
    const supported = this.platform === 'darwin' && Number(this.release.split('.')[0]) >= 24 && executable && !this.blocked;
    return { supported, screenPermission: this.platform === 'darwin' ? this.electron.systemPreferences.getMediaAccessStatus('screen') : 'unsupported',
      microphonePermission: this.platform === 'darwin' ? this.electron.systemPreferences.getMediaAccessStatus('microphone') : 'unsupported',
      ...(!supported ? { message: this.blocked ? '录屏进程尚未确认关闭，已阻止开始新录屏' : '录屏需要 macOS 15+ 和已安装的录屏组件' } : {}) };
  }
  _permissions(audioMode = DEFAULT_AUDIO_MODE) {
    const status = this.status();
    if (!status.supported) throw err('APP_RECORDING_UNSUPPORTED', status.message);
    if (status.screenPermission !== 'granted' || (audioMode === DEFAULT_AUDIO_MODE && status.microphonePermission !== 'granted')) throw err('APP_RECORDING_PERMISSION_REQUIRED', audioMode === 'system' ? '请在系统设置中允许屏幕与系统声音录制' : '请在系统设置中允许屏幕录制和麦克风权限');
  }
  start(options = {}) { return this.#start(options); }
  async startOwnedWindow(window, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Reflect.ownKeys(options).some(key => !OWNED_OPTIONS.has(key)) ||
        typeof this.capture?.resolveOwnedWindow !== 'function') throw err('APP_RECORDING_INVALID', '宿主窗口录屏参数无效');
    // A private method argument, never a request field or exported Symbol, carries
    // the trusted resolver. Ordinary start() cannot request an arbitrary window.
    const captured = { ...options };
    return this.#start({ ...captured, source: 'application' }, () => this.capture.resolveOwnedWindow(window, {
      signal: captured.signal, guard: captured.guard
    }));
  }
  async #start({ source, targetId, outputDir, audioMode = DEFAULT_AUDIO_MODE, maxDurationSeconds = 180, signal, guard = () => {}, cleanupGuard } = {}, ownedResolver) {
    if (!AUDIO_MODES.includes(audioMode) || !['app', 'application', 'screen'].includes(source) || (source !== 'application' && targetId !== undefined) ||
        !path.isAbsolute(outputDir || '') || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 180) throw err('APP_RECORDING_INVALID', '录屏参数无效');
    if (this.active) throw err('APP_RECORDING_BUSY', '已有录屏正在进行');
    this._permissions(audioMode);
    this.active = true;
    let child, checkTarget = async () => {}, directory, targetName;
    try {
      const check = async () => {
        if (signal?.aborted) throw err('ABORTED', '录屏已取消');
        await guard(); this._permissions(audioMode); await checkTarget();
        if (signal?.aborted) throw err('ABORTED', '录屏已取消');
      };
      await check();
      const request = { maxDurationSeconds, audioMode };
      if (source === 'application') {
        const target = await (ownedResolver ? ownedResolver() : this.capture.resolveRecordingTarget(targetId, { signal, guard }));
        if (ownedResolver && (!validTarget({ windowId: target?.windowId, pid: target?.app?.pid, bundle: target?.app?.bundle, launchDate: target?.app?.launchDate }) ||
            target.app.pid !== this.capture.ownPid || typeof target.validate !== 'function')) throw err('APP_RECORDING_TARGET_CLOSED', '宿主窗口原生身份无效');
        Object.assign(request, { windowId: target.windowId, pid: target.app.pid, bundle: target.app.bundle, launchDate: target.app.launchDate });
        checkTarget = target.validate; targetName = target.app.name || '应用窗口';
      } else if (source === 'app') {
        const window = this.getWindow();
        if (!window || window.isDestroyed()) throw err('APP_RECORDING_TARGET_CLOSED', 'OpenBot窗口已关闭');
        targetName = 'OpenBot';
        const mediaId = window.getMediaSourceId();
        const match = /^window:([1-9]\d*):\d+$/.exec(mediaId);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw err('APP_RECORDING_TARGET_CLOSED', '无法识别OpenBot窗口');
        Object.assign(request, { windowId: Number(match[1]), pid: process.pid });
        checkTarget = async () => { if (this.getWindow() !== window || window.isDestroyed() || window.getMediaSourceId() !== mediaId) throw err('APP_RECORDING_TARGET_CLOSED', 'OpenBot窗口已关闭或改变'); };
      } else {
        const display = this.electron.screen.getDisplayNearestPoint(this.electron.screen.getCursorScreenPoint());
        if (!Number.isInteger(display?.id) || display.id <= 0) throw err('APP_RECORDING_TARGET_CLOSED', '无法识别当前屏幕');
        request.displayId = display.id; targetName = display.label || '当前屏幕';
        checkTarget = async () => { if (!this.electron.screen.getAllDisplays().some(d => d.id === display.id)) throw err('APP_RECORDING_TARGET_CLOSED', '所选屏幕已断开'); };
      }
      await check();
      // Caller owns a fresh private session directory; reject links and existing content.
      const stat = await fsp.lstat(outputDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fsp.readdir(outputDir)).length) throw err('APP_RECORDING_INVALID', '录屏目录必须为空的独立目录');
      await fsp.chmod(outputDir, 0o700); directory = await fsp.realpath(outputDir);
      request.outputDir = directory;
      await check();
      child = this.spawnProcess(this.helperPath, [JSON.stringify(request)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return await this._session(child, { directory, maxDurationSeconds, check, cleanupGuard, signal, targetName, request });
    } catch (error) {
      if (child && this.sessionChild === child) { try { child.kill('SIGKILL'); } catch {} }
      if (!this.sessionChild) this.active = false;
      throw error;
    }
  }
  async close() {
    // Keep this handle even when readiness failed: the child may still collect.
    // A later physical close releases it and makes repeated close calls succeed.
    if (this.currentSession) await this.currentSession.cancel();
    if (this.sessionChild || this.blocked) throw err('APP_RECORDING_CLOSE_FAILED', '录屏进程尚未确认关闭');
  }
  _session(child, { directory, maxDurationSeconds, check, cleanupGuard, signal, targetName, request }) {
    this.sessionChild = child;
    let resolveStart, rejectStart, resolveEnd, rejectEnd, started = false, result, failure, settled = false, cancelRequested = false, closed = false;
    let targetLostRequested = false, partialResult, frozenTarget;
    if (validTarget({ windowId: request.windowId, pid: request.pid, bundle: request.bundle, launchDate: request.launchDate })) {
      frozenTarget = Object.freeze({ windowId: request.windowId, pid: request.pid, bundle: request.bundle, launchDate: request.launchDate });
    }
    const cleanupCheck = async () => {
      if (signal?.aborted) throw err('ABORTED', '录屏已取消');
      if (typeof cleanupGuard !== 'function') throw err('APP_RECORDING_PROTOCOL', '缺少录屏封存权限守卫');
      await cleanupGuard(); this._permissions(request.audioMode);
      if (signal?.aborted) throw err('ABORTED', '录屏已取消');
    };
    let buffer = '', outputBytes = 0, stderrBytes = 0, checking = false, stopSent = false, terminating = false;
    const decoder = new StringDecoder('utf8'), timers = [];
    const stderrDecoder = new StringDecoder('utf8'), diagnosticEvents = [], diagnosticPhases = new Set();
    let stderrBuffer = '', diagnosticLogged = false;
    const withFailureDiagnostics = cause => {
      if (!['APP_RECORDING_TIMEOUT', 'APP_RECORDING_FAILED'].includes(cause.code)) return cause;
      cause.recordingDiagnostics = { schemaVersion: 1, events: diagnosticEvents.map(event => ({ ...event })) };
      if (!diagnosticLogged) {
        diagnosticLogged = true;
        const label = cause.code === 'APP_RECORDING_TIMEOUT' ? 'OPENBOT_RECORDING_TIMEOUT' : 'OPENBOT_RECORDING_FAILED';
        process.stderr.write(`${label} ${JSON.stringify(cause.recordingDiagnostics)}\n`);
      }
      return cause;
    };
    const ready = new Promise((yes, no) => { resolveStart = yes; rejectStart = no; });
    const finished = new Promise((yes, no) => { resolveEnd = yes; rejectEnd = no; });
    finished.catch(() => {});
    const terminate = cause => {
      failure ||= withFailureDiagnostics(cause);
      if (terminating || settled) return;
      terminating = true;
      if (!stopSent) { stopSent = true; try { child.stdin.write('cancel\n'); } catch {} }
      timers.push(setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, Math.min(1000, this.closeTimeout / 6)));
      timers.push(setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, Math.min(4000, this.closeTimeout * 2 / 3)));
      timers.push(setTimeout(() => finish(closed ? err('APP_RECORDING_TIMEOUT', '录屏结果校验超时') : err('APP_RECORDING_CLOSE_FAILED', '录屏进程未能结束')), this.closeTimeout));
    };
    const drainTargetLoss = async cause => {
      if (!started || !request.windowId || !targetCheckFailure(cause) || typeof cleanupGuard !== 'function') return terminate(cause);
      try { await cleanupCheck(); } catch (error) { return terminate(error); }
      if (settled || terminating || closed || targetLostRequested) return;
      targetLostRequested = true;
      // The native side must confirm missing original identity, then immediately stop
      // both streams. This hint never authorizes continued capture or retargeting.
      try { child.stdin.write('target-lost\n'); } catch (error) { return terminate(error); }
      timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '目标窗口丢失后的录屏结束超时')), 95000));
    };
    const abort = () => { cancelRequested = true; terminate(err('ABORTED', '录屏已取消')); };
    const finish = cause => {
      if (settled) return;
      settled = true;
      if (!closed) { this.blocked = true; this.active = true; }
      timers.forEach(clearTimeout); clearInterval(interval); signal?.removeEventListener('abort', abort);
      if (cause) {
        // A close failure can supersede timeout, but must retain its safe evidence.
        if (failure?.recordingDiagnostics) cause.recordingDiagnostics = failure.recordingDiagnostics;
        rejectStart(cause); rejectEnd(cause);
      } else resolveEnd(result);
    };
    const session = {
      finished, targetName,
      get target() { return frozenTarget; },
      stop: () => {
        if (!settled && !stopSent) { stopSent = true; child.stdin.write('stop\n'); timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '录屏结束超时')), 95000)); }
        return finished;
      },
      cancel: async () => { if (!settled && !targetLostRequested && !partialResult) abort(); await finished.catch(error => { if (error.code === 'APP_RECORDING_CLOSE_FAILED' && !closed) throw error; }); }
    };
    this.currentSession = session;
    const interval = setInterval(async () => {
      if (checking || settled || result || closed) return;
      checking = true;
      try { if (targetLostRequested || partialResult) await cleanupCheck(); else await check(); const file = path.join(directory, 'recording.mp4'); const stat = await fsp.lstat(file).catch(() => null); if (stat?.size > limit) throw err('APP_RECORDING_LIMIT', '录屏超过128MiB'); }
      catch (error) { await drainTargetLoss(error); } finally { checking = false; }
    }, 750);
    timers.push(setTimeout(() => { if (!started) terminate(err('APP_RECORDING_TIMEOUT', '录屏启动超时')); }, 20000));
    timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '录屏超时未结束')), maxDurationSeconds * 1000 + 120000));
    child.stdin.on('error', () => {});
    child.on('error', error => terminate(err('APP_RECORDING_HELPER_FAILED', error.message)));
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) return terminate(err('APP_RECORDING_PROTOCOL', '录屏进程输出过大'));
      stderrBuffer += stderrDecoder.write(chunk);
      let end;
      while ((end = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, end); stderrBuffer = stderrBuffer.slice(end + 1);
        const event = diagnosticEvent(line);
        if (event && !diagnosticPhases.has(event.phase) && diagnosticEvents.length < DIAGNOSTIC_PHASES.size) {
          diagnosticPhases.add(event.phase); diagnosticEvents.push(event);
        }
      }
    });
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 65536) return terminate(err('APP_RECORDING_PROTOCOL', '录屏进程输出过大'));
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'started' && !started && !result && !failure) {
            if (request.windowId && value.target !== undefined) {
              if (!validTarget(value.target) || value.target.windowId !== request.windowId || value.target.pid !== request.pid ||
                  (frozenTarget && !sameTarget(frozenTarget, value.target))) throw err('APP_RECORDING_PROTOCOL', '录屏原始目标身份无效');
              frozenTarget = Object.freeze({ ...value.target });
            }
            started = true; resolveStart(session);
          }
          else if (value.type === 'finished' && started && !result && !partialResult && !failure && !targetLostRequested) result = value.result;
          else if (value.type === 'target-lost' && started && !result && !partialResult && !failure && frozenTarget &&
                   sameTarget(frozenTarget, value.target) && ['partial', 'unusable'].includes(value.mediaState) &&
                   Object.keys(value).every(key => ['type', 'mediaState', 'target', 'video'].includes(key))) {
            partialResult = value;
            // Already draining: never turn this terminal event into generic cancel.
            targetLostRequested = true;
            timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '录屏进程未关闭')), this.closeTimeout));
          }
          else if (value.type === 'error') terminate(err('APP_RECORDING_FAILED', String(value.message || '系统录屏失败').slice(0, 1000)));
          else throw err('APP_RECORDING_PROTOCOL', '录屏协议顺序无效');
        } catch (error) { terminate(error.code ? error : err('APP_RECORDING_PROTOCOL', '录屏进程返回无效数据')); }
      }
    });
    child.on('close', async code => {
      closed = true;
      if (this.sessionChild === child) { this.sessionChild = null; this.currentSession = null; this.blocked = false; this.active = false; }
      if (settled) return;
      try {
        if (failure) throw failure;
        if (partialResult) {
          if (cancelRequested || code !== 1 || buffer.trim()) throw err('APP_RECORDING_PROTOCOL', '录屏部分结果未正常关闭');
          await cleanupCheck();
          const partialMedia = await this._validatePartial(partialResult, directory, frozenTarget);
          await cleanupCheck();
          throw Object.assign(err('APP_RECORDING_TARGET_LOST', '所选原始窗口已消失，录屏未完成'), { partialMedia });
        }
        if (cancelRequested || code !== 0 || !started || !result || buffer.trim()) throw err('APP_RECORDING_FAILED', '录屏未正常完成');
        await check(); await this._validateResult(result, directory, request.audioMode, maxDurationSeconds); await check(); finish();
      } catch (error) { finish(error); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return ready;
  }
  async _validatePartial(value, directory, target) {
    if (!sameTarget(value.target, target)) throw err('APP_RECORDING_PROTOCOL', '录屏部分结果身份无效');
    const video = value.video;
    if (value.mediaState === 'partial') {
      if (!video || Object.keys(video).sort().join() !== 'durationSeconds,height,name,width' || video.name !== 'recording.mp4' ||
          !Number.isInteger(video.width) || video.width <= 0 || video.width > 4096 ||
          !Number.isInteger(video.height) || video.height <= 0 || video.height > 4096 ||
          !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || video.durationSeconds > 180) throw err('APP_RECORDING_PROTOCOL', '录屏部分视频无效');
    } else if (video !== undefined) throw err('APP_RECORDING_PROTOCOL', '不可用录屏不得声明可播放视频');
    const root = await fsp.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || await fsp.realpath(directory) !== directory) throw err('APP_RECORDING_PROTOCOL', '录屏部分目录无效');
    const names = (await fsp.readdir(directory)).sort();
    if (names.length > 9 || names.some(name => !/^(?:recording\.mp4|window-input\.mp4|system-input\.m4a|frame-[0-5]\.jpg)$/.test(name))) throw err('APP_RECORDING_PROTOCOL', '录屏部分文件名无效');
    if (value.mediaState === 'partial' && (!names.includes('recording.mp4') || !names.some(name => /^frame-[0-5]\.jpg$/.test(name)))) throw err('APP_RECORDING_PROTOCOL', '录屏部分缺少解码帧证据');
    const files = []; let totalBytes = 0;
    for (const name of names) {
      const handle = await fsp.open(path.join(directory, name), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        totalBytes += before.size;
        if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size <= 0 || totalBytes > limit) throw err('APP_RECORDING_LIMIT', '录屏部分文件为空或过大');
        await handle.chmod(0o600); await handle.sync();
        const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!bytesRead) throw err('APP_RECORDING_PROTOCOL', '录屏部分文件读取不完整');
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        const after = await handle.stat(), named = await fsp.lstat(path.join(directory, name));
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev) throw err('APP_RECORDING_PROTOCOL', '录屏部分文件在封存时改变');
        files.push({ name, size: before.size, sha256: hash.digest('hex') });
      } finally { await handle.close(); }
    }
    return { schemaVersion: 1, stopReason: 'target-lost', mediaState: value.mediaState, publishable: false,
      target: { ...target }, files, ...(video ? { video: { ...video } } : {}) };
  }
  async _validateResult(result, directory, audioMode = DEFAULT_AUDIO_MODE, maxDurationSeconds = 180) {
    const microphone = audioMode === DEFAULT_AUDIO_MODE;
    if (!Number.isInteger(result.width) || result.width <= 0 || result.width > 4096 || !Number.isInteger(result.height) || result.height <= 0 || result.height > 4096 ||
        !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > Math.min(180, maxDurationSeconds) ||
        !AUDIO_MODES.includes(audioMode) || (result.audioMode === undefined ? DEFAULT_AUDIO_MODE : result.audioMode) !== audioMode ||
        result.audio?.system !== true || result.audio?.microphone !== microphone || result.systemAudioScope !== 'system-wide' ||
        !Number.isSafeInteger(result.audioSampleCounts?.system) || result.audioSampleCounts.system <= 0 ||
        !Number.isSafeInteger(result.audioSampleCounts?.microphone) || (microphone ? result.audioSampleCounts.microphone <= 0 : result.audioSampleCounts.microphone !== 0) ||
        !Number.isFinite(result.audioSampleDurationSeconds?.system) || result.audioSampleDurationSeconds.system <= 0 ||
        !Number.isFinite(result.audioSampleDurationSeconds?.microphone) || (microphone ? result.audioSampleDurationSeconds.microphone <= 0 : result.audioSampleDurationSeconds.microphone !== 0) ||
        !Number.isInteger(result.audioTrackCount) || result.audioTrackCount < 1 || !['manual', 'time-limit', 'size-limit'].includes(result.stopReason) ||
        !Array.isArray(result.frames) || result.frames.length < 1 || result.frames.length > 6) throw err('APP_RECORDING_PROTOCOL', '录屏结果无效');
    let previousTime = -1;
    const files = [result.videoPath, ...result.frames.map(frame => {
      if (!Number.isFinite(frame.atSeconds) || frame.atSeconds < 0 || frame.atSeconds <= previousTime || frame.atSeconds > result.durationSeconds + 1) throw err('APP_RECORDING_PROTOCOL', '视频帧时间无效');
      previousTime = frame.atSeconds;
      return frame.path;
    })];
    if (result.videoPath !== path.join(directory, 'recording.mp4') || new Set(files).size !== files.length) throw err('APP_RECORDING_PROTOCOL', '录屏文件路径无效');
    let totalBytes = 0;
    for (const file of files) {
      if (typeof file !== 'string' || path.dirname(file) !== directory) throw err('APP_RECORDING_PROTOCOL', '录屏输出越界');
      const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); totalBytes += stat.size; if (!stat.isFile() || stat.size <= 0 || totalBytes > limit) throw err('APP_RECORDING_LIMIT', '录屏文件为空或过大'); await handle.chmod(0o600); }
      finally { await handle.close(); }
    }
  }
}
module.exports = { MacRecordingBackend };
