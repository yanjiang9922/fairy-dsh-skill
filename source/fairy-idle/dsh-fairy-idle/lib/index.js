import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Fairy idle lines: the host owns the WAV pool and exposes it over two
 * same-origin routes. The browser half decides *when* to play. */

const IDLE_DIR = path.join(os.homedir(), '.dsh', 'fairy-voice', 'idle');
const POOL_ROUTE = '/fairy-idle/pool.json';
const AUDIO_PREFIX = '/fairy-idle/audio/';
/* Play order is a curated set: 3+4+5 ship as one continuous take. */
const ORDER = [
  { id: 'group-345', file: 'group-345.wav', label: '快递三连' },
  { id: 'line-02', file: 'line-02.wav', label: '发呆的样子很好看' },
  { id: 'line-06', file: 'line-06.wav', label: '马桶上的沉思者' },
  { id: 'line-07', file: 'line-07.wav', label: '模仿您的声音' },
  { id: 'line-08', file: 'line-08.wav', label: '编织您的梦' },
  { id: 'line-09', file: 'line-09.wav', label: '双倍耗电' },
  { id: 'line-10', file: 'line-10.wav', label: '偷懒的机会' },
  { id: 'line-11', file: 'line-11.wav', label: '王者归来' },
];

function listPool() {
  return ORDER.filter((entry) => {
    try {
      return fs.statSync(path.join(IDLE_DIR, entry.file)).isFile();
    } catch {
      return false;
    }
  }).map((entry) => ({
    id: entry.id,
    label: entry.label,
    url: `${AUDIO_PREFIX}${entry.file}`,
    bytes: fs.statSync(path.join(IDLE_DIR, entry.file)).size,
  }));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function handlePool(_request, response) {
  try {
    sendJson(response, 200, { directory: IDLE_DIR, lines: listPool() });
  } catch (error) {
    sendJson(response, 500, { error: String(error && error.message ? error.message : error) });
  }
}

function audioHandler(file) {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }
    const target = path.join(IDLE_DIR, file);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Content-Length', String(stat.size));
    response.setHeader('Cache-Control', 'public, max-age=3600');
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(target).on('error', () => response.destroy()).pipe(response);
  };
}

export const name = 'dsh-fairy-idle';

export function apply(ctx) {
  ctx.inject(['webServer'], (ws) => {
    ws.effect(() => ws.webServer.register({ kind: 'exact', path: POOL_ROUTE, handler: handlePool }), 'dsh-fairy-idle pool route');
    for (const entry of ORDER) {
      const route = `${AUDIO_PREFIX}${entry.file}`;
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: route, handler: audioHandler(entry.file) }), `dsh-fairy-idle audio ${entry.file}`);
    }
  });
}
