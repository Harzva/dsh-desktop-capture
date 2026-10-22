'use strict';
const path = require('node:path');
const { MacAppCapture } = require('./lib/app-observation-macos.cjs');
const { MacRecordingBackend } = require('./lib/app-recording-native.cjs');
function createHostCapture({ electron, getWindow, getRecordingWindow = getWindow, isDemoBusy = () => false, closeDemo = async () => {} }) {
  if (!electron || typeof getWindow !== 'function' || typeof getRecordingWindow !== 'function') throw new TypeError('electron and window getters are required');
  if (typeof isDemoBusy !== 'function' || typeof closeDemo !== 'function') throw new TypeError('demo lifecycle callbacks must be functions');
  const capture = new MacAppCapture({ electron });
  const recording = new MacRecordingBackend({ electron, capture, getWindow: getRecordingWindow, helperPath: path.join(__dirname, 'native', 'recording-helper') });
  let closed = false, closing = null;
  const pending = new Set();
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const backend = {
    capture, recording,
    get busy() { return pending.size > 0 || capture.busy || recording.active || recording.blocked || !!isDemoBusy(); },
    loadDemoComponents() {
      const operation = (async () => {
        if (closed) throw failure('APP_OBSERVATION_CLOSED', 'Capture host is closed');
        // Importing definitions does not create an AX client, discover voices/tools,
        // request permission or start a native process. The trusted host does that.
        const components = await import('./demo/index.mjs');
        if (closed) throw failure('APP_OBSERVATION_CLOSED', 'Capture host is closed');
        return { components, helperPath: path.join(__dirname, 'native', 'demo-ax-helper') };
      })();
      pending.add(operation);
      const clear = () => pending.delete(operation); operation.then(clear, clear);
      return operation;
    },
    captureSelf(window, { signal } = {}) {
      const check = () => {
        if (closed) throw failure('APP_OBSERVATION_CLOSED', 'Capture host is closed');
        if (signal?.aborted) throw failure('ABORTED', 'Capture cancelled');
        if (!window || window !== getWindow() || window.isDestroyed() || !window.isVisible() || window.isMinimized()) throw failure('APP_OBSERVATION_UNAVAILABLE', 'Host window is unavailable');
      };
      const operation = (async () => {
        check();
        const image = await window.webContents.capturePage();
        check();
        if (!image || image.isEmpty()) throw failure('APP_OBSERVATION_EMPTY', 'Captured image is empty');
        return { image, metadata: { sourceLabel: 'OpenBot', targetName: 'OpenBot' } };
      })();
      pending.add(operation);
      const clear = () => pending.delete(operation); operation.then(clear, clear);
      return operation;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // A demo/export owns the same recorder. Confirm its lifecycle ended first.
        // On failure keep its backend/Stop handle and do not falsely close capture.
        await closeDemo();
        await Promise.allSettled([...pending]);
        let error;
        try { await recording.close(); } catch (cause) { error = cause; }
        try { await capture.close(); } catch (cause) { error ||= cause; }
        if (error) throw error;
      })();
      const clear = () => { closing = null; }; closing.then(clear, clear);
      return closing;
    }
  };
  return backend;
}
module.exports = { createHostCapture, MacAppCapture, MacRecordingBackend };
