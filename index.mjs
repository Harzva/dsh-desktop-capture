import { Buffer } from 'node:buffer';
export const name = 'openbot-desktop-capture';
export const inject = ["tools", "desktopCapture"];
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const PARAMS = { type: 'object', properties: {
  action: { type: 'string', enum: ['list-apps', 'record', 'recording-status', 'stop-recording', 'read-recording'], description: 'list-apps lists windows. record captures real video with system audio and microphone for 1–30 seconds. recording-status checks recording; stop-recording stops an owned recording. read-recording returns one sampled frame, not audio.' },
  source: { type: 'string', enum: ['app', 'application', 'screen'], description: 'app (default): OpenBot itself; application: a chosen application window, requires targetId from list-apps; screen: entire display at the pointer.' },
  targetId: { type: 'string', minLength: 32, maxLength: 32, description: 'Opaque window target returned by list-apps. Only with source=application. Refresh the list if expired.' },
  captureId: { type: 'string', minLength: 32, maxLength: 32, description: 'Read an existing attached screenshot. Use alone.' },
  recordingId: { type: 'string', minLength: 32, maxLength: 32, description: 'Owned recording ID, only for read-recording or stop-recording.' },
  durationSeconds: { type: 'integer', minimum: 1, maximum: 30, description: 'record duration, default 10 seconds.' },
  frameIndex: { type: 'integer', minimum: 0, maximum: 5, description: 'read-recording sampled frame index, default 0. Use frameCount from the result.' }
}, additionalProperties: false };
function validate(args) {
  const invalid = () => fail('INVALID_PARAMS', '截图参数无效');
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid();
  const keys = Object.keys(args);
  if (args.action === 'record') {
    if (keys.some(k => !['action','source','targetId','durationSeconds'].includes(k))) invalid();
    if (args.durationSeconds !== undefined && (!Number.isInteger(args.durationSeconds) || args.durationSeconds < 1 || args.durationSeconds > 30)) invalid();
  } else if (args.action === 'read-recording' || args.action === 'stop-recording') {
    if (!/^[a-f0-9]{32}$/.test(args.recordingId || '') || keys.some(k => !['action','recordingId', ...(args.action === 'read-recording' ? ['frameIndex'] : [])].includes(k))) invalid();
    if (args.frameIndex !== undefined && (!Number.isInteger(args.frameIndex) || args.frameIndex < 0 || args.frameIndex > 5)) invalid();
    return;
  } else if (args.action !== undefined) {
    if (!['list-apps','recording-status'].includes(args.action) || keys.length !== 1) invalid(); return;
  } else if (keys.some(k => !['captureId','source','targetId'].includes(k))) invalid();
  if (args.captureId !== undefined) { if (!/^[a-f0-9]{32}$/.test(args.captureId) || Object.keys(args).length !== 1) invalid(); return; }
  if (args.source !== undefined && !['app','application','screen'].includes(args.source)) invalid();
  if (args.source === 'application' ? !/^[a-f0-9]{32}$/.test(args.targetId || '') : args.targetId !== undefined) invalid();
}
export const inputSchema = PARAMS;
function urlsFrom(value) {
  const urls = [];
  if (typeof value?.dataUrl === 'string') urls.push(value.dataUrl);
  for (const item of value?.content || []) if (item.type === 'image_url') urls.push(item.image_url?.url);
  for (const frame of value?.frames || []) if (typeof frame.dataUrl === 'string') urls.push(frame.dataUrl);
  const unique = [...new Set(urls)];
  if (unique.length > 6) fail('APP_OBSERVATION_LIMIT', 'Too many images');
  return unique;
}
function imageData(url) {
  if (typeof url !== 'string' || url.length > 28 * 1024 * 1024) fail('APP_OBSERVATION_INVALID', 'Invalid captured image');
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match) fail('APP_OBSERVATION_INVALID', 'Expected captured PNG or JPEG bytes');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 20 * 1024 * 1024 || data.toString('base64') !== match[2]) fail('APP_OBSERVATION_INVALID', 'Invalid image encoding');
  return { data, mediaType: match[1], name: match[1] === 'image/png' ? 'capture.png' : 'frame.jpg' };
}
function metadata(value) {
  const copy = { ...value }; delete copy.dataUrl; delete copy.content;
  if (Array.isArray(copy.frames)) copy.frames = copy.frames.map(frame => { const safe = { ...frame }; delete safe.dataUrl; return safe; });
  return JSON.parse(JSON.stringify(copy));
}
export function apply(ctx) {
  if (typeof ctx.desktopCapture?.observe !== 'function') fail('APP_OBSERVATION_UNAVAILABLE', 'A device host must provide desktopCapture.observe');
  ctx.tools.register({
    name: 'app_observe', description: 'Observe the connected desktop device. Choose a window using list-apps, capture app/application/screen, or record real system-wide audio and microphone for 1–30 seconds. Read-recording returns sampled frames, not proof of watching or hearing the whole recording. No automatic permission requests or target fallback.',
    parameters: PARAMS,
    timeoutMs: 180000,
    output: {
      schema: { type: 'object', properties: { metadata: {}, images: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['metadata', 'images'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.metadata) }, ...value.images.map(attachment => ({ type: 'image', attachment }))]
    },
    async execute(args, exec) {
      validate(args);
      if (exec.signal.aborted) throw exec.signal.reason || Error('Aborted');
      const value = await ctx.desktopCapture.observe(args, { signal: exec.signal, agent: exec.agent, callId: exec.callId });
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('APP_OBSERVATION_INVALID', 'Device host returned invalid data');
      const images = [];
      const urls = urlsFrom(value);
      if (urls.length && typeof ctx.desktopCapture.saveImage !== 'function') fail('APP_OBSERVATION_UNAVAILABLE', 'Device host must persist images using the DSH attachment service');
      for (const url of urls) {
        if (exec.signal.aborted) throw exec.signal.reason || Error('Aborted');
        const attachment = await ctx.desktopCapture.saveImage(imageData(url), exec);
        if (!attachment || typeof attachment.attachmentId !== 'string' || !attachment.attachmentId || !Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0 || !Number.isSafeInteger(attachment.width) || attachment.width <= 0 || !Number.isSafeInteger(attachment.height) || attachment.height <= 0) fail('APP_OBSERVATION_INVALID', 'Attachment service returned invalid image reference');
        images.push(attachment);
      }
      const expectsImage = args.action === undefined || args.action === 'read-recording' || args.action === 'record';
      if (expectsImage && !images.length) fail('APP_OBSERVATION_EMPTY', 'Device host returned no captured image bytes');
      if (exec.signal.aborted) throw exec.signal.reason || Error('Aborted');
      return { metadata: metadata(value), images };
    }
  });
}
