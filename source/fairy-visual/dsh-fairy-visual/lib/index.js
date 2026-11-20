// Host half of dsh-fairy-visual.
//
// Upstream targets DSH 0.1.1-rc.2, where a plugin owned a settings namespace
// through `settingsNamespace()` + `SettingsService.register()`. DSH deleted the
// helper in 0.1.2-alpha.1 and the `register` method in 0.1.7 (namespaces are
// derived from a plugin's Config schema now), so on this host the visual plugin
// had no way to persist `enabled` / `theme` / `mascotVisible` at all.
//
// This host half therefore owns its own tiny store instead of borrowing the
// host's: one JSON document under `~/.dsh/fairy-visual/`, reachable over one
// same-origin route (`GET`/`POST /fairy-visual/settings`) that the browser half
// binds to. That keeps the plugin's settings page working across DSH versions
// that have no namespace API, and it keeps the document private (0600, atomic
// rename) instead of living inside the profile's cordis config.
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
} from 'dsh-fairy-contracts';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

const settingsNamespaceName = FAIRY_VISUAL_SETTINGS_NAMESPACE;
const FAIRY_VISUAL_SETTINGS = settingsNamespaceName;
const FAIRY_IDENTITY_SETTINGS = FAIRY_IDENTITY_SETTINGS_NAMESPACE;
const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

const SETTINGS_FILE = join(homedir(), '.dsh', 'fairy-visual', 'settings.json');
const SETTINGS_ROUTE = '/fairy-visual/settings';
// Boot animation: a loop-free MP4 the browser half plays over the first paint.
// Served from the host (not embedded in the bundle) because a 14 s 1080p clip
// is several megabytes and would bloat every page load.
const BOOT_VIDEO = join(homedir(), '.dsh', 'fairy-visual', 'boot.mp4');
const BOOT_VIDEO_ROUTE = '/fairy-visual/boot.mp4';
const BOOT_GREETING_AUDIO = join(homedir(), '.dsh', 'fairy-visual', 'boot-fairy-original.wav');
const BOOT_GREETING_AUDIO_ROUTE = '/fairy-visual/boot-fairy-original.wav';
const MAX_BODY_BYTES = 16 * 1024;
let settingsReadAnnounced = false;
let bootGreetingAudioAnnounced = false;

const VISUAL_DEFAULTS = Object.freeze({
  version: FAIRY_VISUAL_SETTINGS_VERSION,
  enabled: false,
  theme: 'dark',
  mascotVisible: true,
  mascotScale: 1,
  mascotAnimationSpeed: 1,
  powerMode: 'normal',
  composerDockHeight: 132,
});

const IDENTITY_DEFAULTS = Object.freeze({
  mode: 'ling',
  customName: '',
  secondAssistant: '',
  household: [],
});

export const FairyVisualSettings = z.object({
  version: z.number().step(1).default(FAIRY_VISUAL_SETTINGS_VERSION),
  enabled: z.boolean().default(false),
  theme: z.union(['dark', 'light']).default('dark'),
  mascotVisible: z.boolean().default(true),
  mascotScale: z.number().step(0.01).min(0.55).max(1).default(1),
  mascotAnimationSpeed: z.union([z.const(0.7), z.const(1), z.const(1.5)]).default(1),
  powerMode: z.union(['normal', 'low-power']).default('normal'),
  composerDockHeight: z.number().step(1).min(132).max(420).default(132),
});

export const FairyIdentitySettings = z.object({
  mode: z.union(['ling', 'zhe', 'custom']).default('ling'),
  customName: z.string().default(''),
  secondAssistant: z.string().default(''),
  household: z.array(z.string()).default([]),
});

export const name = 'dsh-fairy-visual';

/** Project only known visual fields, coercing each to its accepted range. */
function sanitizeVisual(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isInteger(raw.version) && raw.version >= 1) out.version = raw.version;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (raw.theme === 'dark' || raw.theme === 'light') out.theme = raw.theme;
  if (typeof raw.mascotVisible === 'boolean') out.mascotVisible = raw.mascotVisible;
  if (Number.isFinite(raw.mascotScale)) {
    out.mascotScale = Math.min(1, Math.max(0.55, Math.round(raw.mascotScale * 100) / 100));
  }
  if (raw.mascotAnimationSpeed === 0.7 || raw.mascotAnimationSpeed === 1 || raw.mascotAnimationSpeed === 1.5) {
    out.mascotAnimationSpeed = raw.mascotAnimationSpeed;
  }
  if (raw.powerMode === 'normal' || raw.powerMode === 'low-power') out.powerMode = raw.powerMode;
  if (Number.isFinite(raw.composerDockHeight)) {
    out.composerDockHeight = Math.min(420, Math.max(132, Math.round(raw.composerDockHeight)));
  }
  return out;
}

/** Project only known identity fields. */
function sanitizeIdentity(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.mode === 'ling' || raw.mode === 'zhe' || raw.mode === 'custom') out.mode = raw.mode;
  if (typeof raw.customName === 'string') out.customName = raw.customName.slice(0, 40);
  if (typeof raw.secondAssistant === 'string') out.secondAssistant = raw.secondAssistant.slice(0, 40);
  if (Array.isArray(raw.household)) {
    out.household = raw.household
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return out;
}

async function readState() {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') diagnostics.warn('settings.read', { file: 'settings.json' }, error);
    parsed = {};
  }
  return {
    visual: { ...VISUAL_DEFAULTS, ...sanitizeVisual(parsed?.visual) },
    identity: { ...IDENTITY_DEFAULTS, ...sanitizeIdentity(parsed?.identity) },
  };
}

async function writeState(state) {
  const directory = dirname(SETTINGS_FILE);
  const temporary = `${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  let handle = null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = null;
    await rename(temporary, SETTINGS_FILE);
    committed = true;
    await chmod(SETTINGS_FILE, 0o600);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* already closed */ }
    }
    if (!committed) {
      try { await unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') diagnostics.warn('settings.write', {}, error); }
    }
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/** Collect one bounded JSON request body. */
async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body too large'), { code: 'body-too-large' });
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Merge one accepted field (or a partial object) into the stored document. */
async function applyPatch(namespace, patch) {
  const state = await readState();
  if (namespace === FAIRY_IDENTITY_SETTINGS) {
    state.identity = { ...state.identity, ...sanitizeIdentity(patch) };
  } else if (namespace === FAIRY_VISUAL_SETTINGS) {
    state.visual = { ...state.visual, ...sanitizeVisual(patch) };
  } else {
    throw Object.assign(new Error('unknown settings namespace'), { code: 'unknown-namespace' });
  }
  await writeState(state);
  return state;
}

async function handleSettingsRequest(request, response) {
  if (request.method === 'GET') {
    // One lifetime marker: proves the browser half bound this route after a
    // page load, without logging every read.
    if (!settingsReadAnnounced) {
      settingsReadAnnounced = true;
      diagnostics.info('settings.read', { surface: 'host', route: SETTINGS_ROUTE });
    }
    sendJson(response, 200, await readState());
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'GET, POST' });
    response.end('Method Not Allowed');
    return;
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    diagnostics.warn('settings.body', {}, error);
    sendJson(response, 400, { error: 'invalid-request' });
    return;
  }
  const namespace = typeof body?.namespace === 'string' ? body.namespace : '';
  let patch = body?.patch;
  if (patch === undefined && typeof body?.field === 'string') patch = { [body.field]: body.value };
  try {
    const state = await applyPatch(namespace, patch || {});
    sendJson(response, 200, state);
  } catch (error) {
    diagnostics.warn('settings.patch', { namespace }, error);
    sendJson(response, error?.code === 'unknown-namespace' ? 400 : 500, { error: 'not-applied' });
  }
}

/* Range-aware video streaming: Chromium asks for byte ranges when it plays a
 * local MP4, and a full-body 200 response makes playback stutter or fail. */
function handleBootVideo(request, response) {
  let size;
  try {
    size = statSync(BOOT_VIDEO).size;
  } catch {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'boot-video-missing' }));
    return;
  }
  const base = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };
  const range = request.headers?.range;
  if (typeof range === 'string' && range.startsWith('bytes=')) {
    const [rawStart, rawEnd] = range.slice(6).split('-');
    const start = rawStart === '' ? 0 : Number(rawStart);
    const end = rawEnd === '' || rawEnd === undefined ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(BOOT_VIDEO, { start, end }).on('error', () => response.destroy()).pipe(response);
    return;
  }
  response.writeHead(200, { ...base, 'Content-Length': String(size) });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(BOOT_VIDEO).on('error', () => response.destroy()).pipe(response);
}

function handleBootGreetingAudio(request, response) {
  if (!bootGreetingAudioAnnounced) {
    bootGreetingAudioAnnounced = true;
    diagnostics.info('boot.greeting.audio.requested', {
      method: request.method || 'GET',
      ranged: typeof request.headers?.range === 'string',
    });
  }
  let size;
  try {
    size = statSync(BOOT_GREETING_AUDIO).size;
  } catch {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'boot-greeting-audio-missing' }));
    return;
  }
  const base = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };
  const range = request.headers?.range;
  if (typeof range === 'string' && range.startsWith('bytes=')) {
    const [rawStart, rawEnd] = range.slice(6).split('-');
    const start = rawStart === '' ? 0 : Number(rawStart);
    const end = rawEnd === '' || rawEnd === undefined ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(BOOT_GREETING_AUDIO, { start, end }).on('error', () => response.destroy()).pipe(response);
    return;
  }
  response.writeHead(200, { ...base, 'Content-Length': String(size) });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(BOOT_GREETING_AUDIO).on('error', () => response.destroy()).pipe(response);
}

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    // Legacy hosts (DSH < 0.1.7) still get a real settings namespace; newer
    // hosts have no `register` and use the route below instead.
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings;
      if (typeof settings?.register !== 'function') {
        diagnostics.info('settings.transport', {
          surface: 'host',
          host: 'dsh>=0.1.7',
          transport: 'plugin-route',
          namespaces: [FAIRY_VISUAL_SETTINGS, FAIRY_IDENTITY_SETTINGS],
        });
        return;
      }
      settings.register(FAIRY_VISUAL_SETTINGS, FairyVisualSettings);
      settings.register(FAIRY_IDENTITY_SETTINGS, FairyIdentitySettings);
    });

    ctx.inject(['webServer'], (ws) => {
      ws.effect(() => ws.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: handleSettingsRequest,
      }), 'dsh-fairy-visual settings route');
      diagnostics.info('settings.route.registered', { surface: 'host', path: SETTINGS_ROUTE });
      ws.effect(() => ws.webServer.register({
        kind: 'exact',
        path: BOOT_VIDEO_ROUTE,
        handler: handleBootVideo,
      }), 'dsh-fairy-visual boot video route');
      diagnostics.info('boot.route.registered', { surface: 'host', path: BOOT_VIDEO_ROUTE });
      ws.effect(() => ws.webServer.register({
        kind: 'exact',
        path: BOOT_GREETING_AUDIO_ROUTE,
        handler: handleBootGreetingAudio,
      }), 'dsh-fairy-visual boot greeting audio route');
      diagnostics.info('boot.greeting.route.registered', { surface: 'host', path: BOOT_GREETING_AUDIO_ROUTE });
    });
  }, { surface: 'host' });
}
