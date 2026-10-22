'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const err = (code, message) => Object.assign(new Error(message), { code });
const limit = 128 * 1024 * 1024;
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
  _permissions() {
    const status = this.status();
    if (!status.supported) throw err('APP_RECORDING_UNSUPPORTED', status.message);
    if (status.screenPermission !== 'granted' || status.microphonePermission !== 'granted') throw err('APP_RECORDING_PERMISSION_REQUIRED', '请在系统设置中允许屏幕录制和麦克风权限');
  }
  async start({ source, targetId, outputDir, maxDurationSeconds = 180, signal, guard = () => {} } = {}) {
    if (!['app', 'application', 'screen'].includes(source) || (source !== 'application' && targetId !== undefined) ||
        !path.isAbsolute(outputDir || '') || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 180) throw err('APP_RECORDING_INVALID', '录屏参数无效');
    if (this.active) throw err('APP_RECORDING_BUSY', '已有录屏正在进行');
    this._permissions();
    this.active = true;
    let child, checkTarget = async () => {}, directory, targetName;
    try {
      const check = async () => {
        if (signal?.aborted) throw err('ABORTED', '录屏已取消');
        await guard(); this._permissions(); await checkTarget();
        if (signal?.aborted) throw err('ABORTED', '录屏已取消');
      };
      await check();
      const request = { maxDurationSeconds };
      if (source === 'application') {
        const target = await this.capture.resolveRecordingTarget(targetId, { signal, guard });
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
      return await this._session(child, { directory, maxDurationSeconds, check, signal, targetName });
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
  _session(child, { directory, maxDurationSeconds, check, signal, targetName }) {
    this.sessionChild = child;
    let resolveStart, rejectStart, resolveEnd, rejectEnd, started = false, result, failure, settled = false, cancelRequested = false, closed = false;
    let buffer = '', outputBytes = 0, stderrBytes = 0, checking = false, stopSent = false, terminating = false;
    const decoder = new StringDecoder('utf8'), timers = [];
    const ready = new Promise((yes, no) => { resolveStart = yes; rejectStart = no; });
    const finished = new Promise((yes, no) => { resolveEnd = yes; rejectEnd = no; });
    finished.catch(() => {});
    const terminate = cause => {
      failure ||= cause;
      if (terminating || settled) return;
      terminating = true;
      if (!stopSent) { stopSent = true; try { child.stdin.write('cancel\n'); } catch {} }
      timers.push(setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, Math.min(1000, this.closeTimeout / 6)));
      timers.push(setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, Math.min(4000, this.closeTimeout * 2 / 3)));
      timers.push(setTimeout(() => finish(closed ? err('APP_RECORDING_TIMEOUT', '录屏结果校验超时') : err('APP_RECORDING_CLOSE_FAILED', '录屏进程未能结束')), this.closeTimeout));
    };
    const abort = () => { cancelRequested = true; terminate(err('ABORTED', '录屏已取消')); };
    const finish = cause => {
      if (settled) return;
      settled = true;
      if (!closed) { this.blocked = true; this.active = true; }
      timers.forEach(clearTimeout); clearInterval(interval); signal?.removeEventListener('abort', abort);
      if (cause) { rejectStart(cause); rejectEnd(cause); } else resolveEnd(result);
    };
    const session = {
      finished, targetName,
      stop: () => {
        if (!settled && !stopSent) { stopSent = true; child.stdin.write('stop\n'); timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '录屏结束超时')), 95000)); }
        return finished;
      },
      cancel: async () => { if (!settled) abort(); await finished.catch(error => { if (error.code === 'APP_RECORDING_CLOSE_FAILED' && !closed) throw error; }); }
    };
    this.currentSession = session;
    const interval = setInterval(async () => {
      if (checking || settled || result) return;
      checking = true;
      try { await check(); const file = path.join(directory, 'recording.mp4'); const stat = await fsp.lstat(file).catch(() => null); if (stat?.size > limit) throw err('APP_RECORDING_LIMIT', '录屏超过128MiB'); }
      catch (error) { terminate(error); } finally { checking = false; }
    }, 750);
    timers.push(setTimeout(() => { if (!started) terminate(err('APP_RECORDING_TIMEOUT', '录屏启动超时')); }, 20000));
    timers.push(setTimeout(() => terminate(err('APP_RECORDING_TIMEOUT', '录屏超时未结束')), maxDurationSeconds * 1000 + 120000));
    child.stdin.on('error', () => {});
    child.on('error', error => terminate(err('APP_RECORDING_HELPER_FAILED', error.message)));
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) terminate(err('APP_RECORDING_PROTOCOL', '录屏进程输出过大')); });
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 65536) return terminate(err('APP_RECORDING_PROTOCOL', '录屏进程输出过大'));
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'started' && !started && !result && !failure) { started = true; resolveStart(session); }
          else if (value.type === 'finished' && started && !result && !failure) result = value.result;
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
        if (cancelRequested || code !== 0 || !started || !result || buffer.trim()) throw err('APP_RECORDING_FAILED', '录屏未正常完成');
        await check(); await this._validateResult(result, directory); await check(); finish();
      } catch (error) { finish(error); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return ready;
  }
  async _validateResult(result, directory) {
    if (!Number.isInteger(result.width) || result.width <= 0 || result.width > 4096 || !Number.isInteger(result.height) || result.height <= 0 || result.height > 4096 ||
        !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > 180 ||
        result.audio?.system !== true || result.audio?.microphone !== true || result.systemAudioScope !== 'system-wide' ||
        !Number.isSafeInteger(result.audioSampleCounts?.system) || result.audioSampleCounts.system <= 0 ||
        !Number.isSafeInteger(result.audioSampleCounts?.microphone) || result.audioSampleCounts.microphone <= 0 ||
        !Number.isFinite(result.audioSampleDurationSeconds?.system) || result.audioSampleDurationSeconds.system <= 0 ||
        !Number.isFinite(result.audioSampleDurationSeconds?.microphone) || result.audioSampleDurationSeconds.microphone <= 0 ||
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
