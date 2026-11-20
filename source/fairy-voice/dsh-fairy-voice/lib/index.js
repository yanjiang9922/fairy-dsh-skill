/**
 * dsh-fairy-voice — 宿主侧。
 *
 * 职责只有三件，都是「客户端做不到」的事：
 *   1. 解析音效目录，并在首次启动时从包内 assets/sounds 播种到 ~/.dsh/fairy-voice/sounds
 *   2. 读写配置 ~/.dsh/fairy-voice/config.json（旧包名留下的 ~/.dsh/pi-voice/ 会被沿用，见 resolveDataDir）
 *   3. 通过 webServer 把 WAV、配置和本机 GPT-SoVITS 合成结果暴露给浏览器
 *
 * 自动汇报只连接 127.0.0.1 上的 GPT-SoVITS；对话内容不会发往第三方。
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_SOUND_FILES, TRIGGERS, defaultConfig } from './catalog.js';

export const name = 'dsh-fairy-voice';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLED_SOUNDS = path.join(PLUGIN_ROOT, 'assets', 'sounds');

const ROUTE_BASE = '/fairy-voice';
const SOUND_ROUTE_PREFIX = `${ROUTE_BASE}/sounds`;

/** 日志前缀，方便在宿主日志里一眼认出是谁在说话。 */
function log(level, message, detail) {
  const line = `[fairy-voice] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (detail === undefined) sink(line);
  else sink(line, detail);
}

/** DSH 数据目录：优先 $DSH_HOME，回落 ~/.dsh —— 与上游 Fairy 的约定一致。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(homedir(), '.dsh');
}

/**
 * 数据目录。
 *
 *   ~/.dsh/fairy-voice/   本包（也是上游 Fairy 的约定）
 *   ~/.dsh/pi-voice/      旧包名 dsh-pi-voice 留下的目录 —— 只在上面那个还不存在时沿用
 *
 * 只判断一次：老用户升级过来时，配置与自换音效原地生效，不需要手动搬。
 * 一旦新目录被建出来，此后一律以新目录为准，不会在两个目录之间来回跳。
 */
function resolveDataDir() {
  const dshHome = resolveDshHome();
  const current = path.join(dshHome, 'fairy-voice');
  if (existsSync(current)) return current;
  const legacy = path.join(dshHome, 'pi-voice');
  if (existsSync(legacy)) {
    log('warn', `沿用旧数据目录 ${legacy}（由旧包名 dsh-pi-voice 留下）；` +
      `想迁到 ${current} 就把旧目录改名后重启 DSH`);
    return legacy;
  }
  return current;
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_SOUNDS_DIR = path.join(DATA_DIR, 'sounds');

/** 仅供自检读取：让 test/data-dir.mjs 能在子进程里断言解析结果。 */
export const __DATA_DIR__ = DATA_DIR;

/** 音效目录最终取值：配置里的显式路径 > 默认目录。 */
function resolveSoundsDir(config) {
  const configured = typeof config?.soundsDir === 'string' ? config.soundsDir.trim() : '';
  if (configured === '') return DEFAULT_SOUNDS_DIR;
  return path.isAbsolute(configured) ? configured : path.resolve(DATA_DIR, configured);
}

// ---------------------------------------------------------------- 配置读写

let cachedConfig = null;
let writeChain = Promise.resolve();

/**
 * 读配置。失败一律回落默认值：坏掉的配置文件不该让插件起不来。
 * 未知字段被保留（前向兼容），已知字段做类型收敛。
 */
async function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', '配置文件读取失败，改用默认值', error?.message || error);
  }
  const merged = mergeConfig(raw);
  cachedConfig = merged;
  return merged;
}

/** 把任意输入收敛成一份合法配置。 */
function mergeConfig(raw) {
  const base = defaultConfig();
  const input = raw && typeof raw === 'object' ? raw : {};
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  const triggers = { ...base.triggers };
  if (input.triggers && typeof input.triggers === 'object') {
    for (const trigger of TRIGGERS) {
      if (trigger.id in input.triggers) triggers[trigger.id] = input.triggers[trigger.id] === true;
    }
  }
  const soundSelections = { ...base.soundSelections };
  if (input.soundSelections && typeof input.soundSelections === 'object') {
    for (const trigger of TRIGGERS) {
      if (!(trigger.id in input.soundSelections)) continue;
      const selection = input.soundSelections[trigger.id];
      if (!Array.isArray(selection)) continue;
      soundSelections[trigger.id] = [
        ...new Set(selection.filter((file) => (
          typeof file === 'string' && trigger.files.includes(file)
        ))),
      ];
    }
  }
  const inputTts = input.tts && typeof input.tts === 'object' ? input.tts : {};
  const inputStartup = input.startupVoice && typeof input.startupVoice === 'object'
    ? input.startupVoice
    : {};
  const endpoint = typeof inputTts.endpoint === 'string' && /^https?:\/\//i.test(inputTts.endpoint.trim())
    ? inputTts.endpoint.trim().replace(/\/+$/, '')
    : base.tts.endpoint;
  const voiceName = typeof inputTts.voice === 'string'
    ? path.basename(inputTts.voice.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    : base.tts.voice;
  const startupPreset = ['full', 'short', 'custom'].includes(inputStartup.preset)
    ? inputStartup.preset
    : base.startupVoice.preset;
  return {
    version: base.version,
    enabled: input.enabled === true,
    muted: input.muted === true,
    volume: number(input.volume, base.volume, 0, 1),
    triggers,
    soundSelections,
    activityMinutes: number(input.activityMinutes, base.activityMinutes, 1, 24 * 60),
    contextWarningRatio: number(input.contextWarningRatio, base.contextWarningRatio, 0.1, 0.99),
    quotaWarningAmount: number(input.quotaWarningAmount, base.quotaWarningAmount, 0, 1_000_000),
    soundsDir: typeof input.soundsDir === 'string' ? input.soundsDir : '',
    packGain: number(input.packGain, base.packGain, 0.05, 8),
    autoReport: input.autoReport !== false,
    startupVoice: {
      enabled: inputStartup.enabled !== false,
      preset: startupPreset,
      customText: typeof inputStartup.customText === 'string'
        ? inputStartup.customText.slice(0, 1000)
        : base.startupVoice.customText,
      greetingEnabled: inputStartup.greetingEnabled !== false,
      greetingPauseMs: number(
        inputStartup.greetingPauseMs,
        base.startupVoice.greetingPauseMs,
        0,
        5000,
      ),
    },
    tts: {
      endpoint,
      voice: voiceName || base.tts.voice,
      speed: number(inputTts.speed, base.tts.speed, 0.5, 2),
    },
  };
}

/**
 * 写配置。串行化 + 先写临时文件再 rename：
 * 设置面板可能被连点，不能出现半个 JSON。
 */
function writeConfig(patch) {
  writeChain = writeChain.then(async () => {
    const current = cachedConfig ?? (await readConfig());
    const next = mergeConfig({
      ...current,
      ...patch,
      triggers: { ...current.triggers, ...(patch?.triggers || {}) },
      soundSelections: {
        ...(current.soundSelections || {}),
        ...(patch?.soundSelections || {}),
      },
      startupVoice: { ...(current.startupVoice || {}), ...(patch?.startupVoice || {}) },
      tts: { ...(current.tts || {}), ...(patch?.tts || {}) },
    });
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, CONFIG_FILE);
    cachedConfig = next;
    return next;
  }).catch((error) => {
    log('error', '配置写入失败', error?.message || error);
    throw error;
  });
  return writeChain;
}

// ---------------------------------------------------------------- 目录播种

let seeded = false;

/**
 * 确保音效目录存在且装满。
 * 只补缺失文件，绝不覆盖同名文件 —— 你自己换掉的音效不会被下次启动冲掉。
 */
async function ensureSoundsDir(config) {
  const dir = resolveSoundsDir(config);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    log('error', '音效目录创建失败', { dir, error: error?.message || error });
    return dir;
  }
  if (!seeded && path.resolve(dir) === path.resolve(DEFAULT_SOUNDS_DIR)) {
    seeded = true;
    let copied = 0;
    for (const file of ALL_SOUND_FILES) {
      const target = path.join(dir, file);
      try {
        await stat(target);
        continue;
      } catch { /* 不存在才补 */ }
      try {
        await copyFile(path.join(BUNDLED_SOUNDS, file), target);
        copied += 1;
      } catch (error) {
        log('warn', `音效播种失败：${file}`, error?.message || error);
      }
    }
    if (copied > 0) log('info', `已播种 ${copied} 个音效到 ${dir}`);
  }
  return dir;
}

/** 目录里实际有哪些候选音频（只认清单内的名字）。 */
async function listAvailable(dir) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  return ALL_SOUND_FILES.filter((file) => present.has(file.toLowerCase()));
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx) {
  /* 首次启动把目录建出来（幂等、失败不致命）。
   * 使用者得知道音效该放哪儿 —— 建目录比在文档里说一句有用。 */
  void (async () => {
    const config = await readConfig();
    await ensureSoundsDir(config);
  })().catch((error) => log('warn', '启动初始化失败', error?.message || error));

  const handlers = {
    /** 存活与目录状态，设置面板的「开始自检」据此报数。 */
    async status(req, res) {
      const config = cachedConfig ?? (await readConfig());
      const dir = await ensureSoundsDir(config);
      const available = await listAvailable(dir);
      sendJson(res, 200, {
        ok: true,
        version: 2,
        dataDir: DATA_DIR,
        soundsDir: dir,
        soundsDirSource: config.soundsDir ? 'config' : 'default',
        expected: ALL_SOUND_FILES.length,
        available: available.length,
        missing: ALL_SOUND_FILES.filter((file) => !available.includes(file)),
        triggers: TRIGGERS.length,
      });
    },
    /** 清单：客户端据此渲染面板并解析文件名，避免两端各存一份目录。 */
    async manifest(req, res) {
      const config = cachedConfig ?? (await readConfig());
      const dir = await ensureSoundsDir(config);
      const available = await listAvailable(dir);
      sendJson(res, 200, {
        ok: true,
        version: 2,
        soundUrlBase: SOUND_ROUTE_PREFIX,
        triggers: TRIGGERS,
        available,
        ttsVoices: await listTtsVoices(),
        config,
      });
    },
    async config(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, config: cachedConfig ?? (await readConfig()) });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      try {
        const patch = await readJsonBody(req);
        const next = await writeConfig(patch);
        sendJson(res, 200, { ok: true, config: next });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
    },
    /** 音效静态服务。prefix 路由一次覆盖全部文件。 */
    async sound(req, res) {
      const config = cachedConfig ?? (await readConfig());
      const dir = await ensureSoundsDir(config);
      let rel = '';
      try {
        rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(SOUND_ROUTE_PREFIX.length));
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad path' });
        return;
      }
      rel = rel.replace(/^\/+/, '');
      // 目录穿越防护：只允许清单内的裸文件名。
      if (rel === '' || rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const allowed = ALL_SOUND_FILES.find((file) => file.toLowerCase() === rel.toLowerCase());
      if (!allowed) {
        sendJson(res, 404, { ok: false, error: 'not in manifest' });
        return;
      }
      const file = path.join(dir, allowed);
      let info;
      try {
        info = await stat(file);
      } catch {
        sendJson(res, 404, { ok: false, error: 'missing on disk' });
        return;
      }
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400',
        ETag: etag,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    },
  
  /* TTS SPEAK ROUTE: proxy one utterance to the local GPT-SoVITS API and return
   * wav bytes. Going through the host keeps CORS out of the picture and keeps the
   * voice/model choice in one place (the fairy-voice config). */
  async ttsSpeak(req, res) {
    try {
      const body = await readJsonBody(req);
      const text = String(body.text || '').slice(0, 2000);
      if (!text.trim()) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'text required' }));
        return;
      }
      const cfg = await readConfig();
      const tts = (cfg && cfg.tts) || {};
      const endpoint = String(tts.endpoint || 'http://127.0.0.1:9880').replace(/\/+$/, '');
      const voice = path.basename(String(body.voice || tts.voice || 'Fairy').trim());
      const style = normalizeTtsStyle(body.style);
      const speed = Number(body.speed);
      const voiceRoot = path.join(TTS_VOICES_DIR, voice);
      if (path.dirname(voiceRoot) !== path.resolve(TTS_VOICES_DIR) && !voiceRoot.startsWith(`${path.resolve(TTS_VOICES_DIR)}${path.sep}`)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid voice' }));
        return;
      }
      for (const file of ['gpt.ckpt', 'sovits.pth', 'ref.wav']) {
        if (!existsSync(path.join(voiceRoot, file))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `voice file missing: ${voice}/${file}` }));
          return;
        }
      }

      await ensureTtsService(endpoint);
      await selectTtsVoice(endpoint, voiceRoot, voice);

      const reference = resolveTtsReference(voiceRoot, style);
      const styleSettings = TTS_STYLES[style];
      const baseSpeed = Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : tts.speed;
      const payload = {
        text,
        text_lang: String(body.text_lang || 'zh'),
        ref_audio_path: reference.audioPath,
        prompt_text: reference.promptText,
        prompt_lang: String(body.prompt_lang || 'zh'),
        top_k: styleSettings.topK,
        top_p: styleSettings.topP,
        temperature: styleSettings.temperature,
        text_split_method: 'cut1',
        batch_size: 1,
        speed_factor: Math.min(2, Math.max(0.5, Number(baseSpeed || 1) * styleSettings.speedFactor)),
        fragment_interval: styleSettings.fragmentInterval,
        seed: styleSettings.seed ?? -1,
        parallel_infer: true,
        repetition_penalty: styleSettings.repetitionPenalty,
        media_type: 'wav',
        streaming_mode: false,
      };
      const response = await fetch(endpoint + '/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.text();
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'tts failed', detail: detail.slice(0, 500) }));
        return;
      }
      const rawBuffer = Buffer.from(await response.arrayBuffer());
      const buffer = compressWavPauses(rawBuffer, {
        maxGapMs: styleSettings.maxGapMs,
        leadMs: styleSettings.leadMs,
        tailMs: styleSettings.tailMs,
      });
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(buffer.length),
        'cache-control': 'no-store',
      });
      res.end(buffer);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((error && error.message) || error) }));
    }
  }
};

  ctx.inject(['webServer'], (ws) => ws.effect(() => {
    const disposers = [
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/status`, handler: handlers.status }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/manifest`, handler: handlers.manifest }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/config`, handler: handlers.config }),
      ws.webServer.register({ kind: 'prefix', path: SOUND_ROUTE_PREFIX, handler: handlers.sound }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/tts-speak`, handler: handlers.ttsSpeak }),
    ];
    return () => disposers.forEach((dispose) => { try { dispose?.(); } catch { /* 卸载期忽略 */ } });
  }));

  /* 开机问候和第一轮汇报都可能早于 TTS 冷启动完成。插件加载时先把服务
   * 预热起来，首个 /tts-speak 请求会复用同一个启动 Promise，不会重复拉起。 */
  void readConfig()
    .then((config) => ensureTtsService(config?.tts?.endpoint || 'http://127.0.0.1:9880'))
    .catch((error) => log('warn', 'Fairy 语音预热失败', error?.message || error));
}

/* ---- TTS helpers ---------------------------------------------------------- */
const TTS_VOICES_DIR = process.env.DSH_TTS_VOICES || 'D:/GPT-SoVITS/voices';
const TTS_START_SCRIPT = process.env.DSH_TTS_START_SCRIPT || 'D:/GPT-SoVITS/start-api.bat';
const TTS_START_TIMEOUT_MS = 120_000;
let ttsStartPromise = null;

const TTS_STYLES = Object.freeze({
  neutral: Object.freeze({
    speedFactor: 1.01,
    topK: 10,
    topP: 0.8,
    temperature: 0.67,
    repetitionPenalty: 1.3,
    fragmentInterval: 0.1,
    maxGapMs: 160,
    leadMs: 25,
    tailMs: 65,
  }),
  warm: Object.freeze({
    speedFactor: 1,
    topK: 10,
    topP: 0.78,
    temperature: 0.65,
    repetitionPenalty: 1.31,
    fragmentInterval: 0.09,
    maxGapMs: 150,
    leadMs: 30,
    tailMs: 65,
  }),
  focused: Object.freeze({
    speedFactor: 1.02,
    topK: 9,
    topP: 0.76,
    temperature: 0.62,
    repetitionPenalty: 1.32,
    fragmentInterval: 0.07,
    maxGapMs: 130,
    leadMs: 25,
    tailMs: 55,
  }),
  alert: Object.freeze({
    speedFactor: 1.06,
    topK: 10,
    topP: 0.78,
    temperature: 0.64,
    repetitionPenalty: 1.31,
    fragmentInterval: 0.06,
    maxGapMs: 110,
    leadMs: 20,
    tailMs: 50,
  }),
  playful: Object.freeze({
    speedFactor: 0.99,
    topK: 10,
    topP: 0.78,
    temperature: 0.66,
    repetitionPenalty: 1.3,
    fragmentInterval: 0.1,
    maxGapMs: 160,
    leadMs: 30,
    tailMs: 65,
  }),
  cold: Object.freeze({
    speedFactor: 1.01,
    topK: 9,
    topP: 0.76,
    temperature: 0.62,
    repetitionPenalty: 1.32,
    fragmentInterval: 0.08,
    maxGapMs: 135,
    leadMs: 25,
    tailMs: 55,
  }),
  intro: Object.freeze({
    speedFactor: 0.94,
    topK: 9,
    topP: 0.76,
    temperature: 0.64,
    repetitionPenalty: 1.32,
    fragmentInterval: 0.03,
    seed: 42,
    maxGapMs: 260,
    leadMs: 50,
    tailMs: 120,
  }),
});

function normalizeTtsStyle(value) {
  const style = String(value || '').trim().toLowerCase();
  return Object.hasOwn(TTS_STYLES, style) ? style : 'warm';
}

function resolveTtsReference(voiceRoot, style) {
  const audioPath = path.join(voiceRoot, `ref-${style}.wav`);
  const fallbackAudio = path.join(voiceRoot, 'ref.wav');
  const selectedAudio = existsSync(audioPath) ? audioPath : fallbackAudio;
  const matchingText = selectedAudio === fallbackAudio
    ? path.join(voiceRoot, 'ref.txt')
    : path.join(voiceRoot, `ref-${style}.txt`);
  const fallbackText = path.join(voiceRoot, 'ref.txt');
  const selectedText = existsSync(matchingText) ? matchingText : fallbackText;
  return {
    audioPath: selectedAudio,
    promptText: readTextFile(selectedText),
  };
}

function readTextFile(target) {
  try { return readFileSync(target, 'utf8').trim(); } catch { return ''; }
}

/**
 * GPT-SoVITS 会在句段之间留下随机的长静音。保留自然的气口，但把超过
 * 超过风格上限的空白压回上限，避免自动汇报听起来像在逐句等待。
 * 冷静、预警和首发使用不同上限，保留 Fairy 克制而连贯的节奏。
 * 只处理常见的 16-bit PCM WAV；遇到其他格式就原样返回。
 */
function compressWavPauses(input, { maxGapMs = 240, leadMs = 80, tailMs = 120 } = {}) {
  try {
    if (input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') {
      return input;
    }

    let cursor = 12;
    let format = null;
    let dataOffset = -1;
    let dataLength = 0;
    let dataChunkOffset = -1;
    while (cursor + 8 <= input.length) {
      const id = input.toString('ascii', cursor, cursor + 4);
      const size = input.readUInt32LE(cursor + 4);
      if (id === 'fmt ' && cursor + 24 <= input.length) {
        format = {
          audioFormat: input.readUInt16LE(cursor + 8),
          channels: input.readUInt16LE(cursor + 10),
          sampleRate: input.readUInt32LE(cursor + 12),
          bitsPerSample: input.readUInt16LE(cursor + 22),
        };
      } else if (id === 'data') {
        dataChunkOffset = cursor;
        dataOffset = cursor + 8;
        dataLength = Math.min(size, input.length - dataOffset);
        break;
      }
      cursor += 8 + size + (size % 2);
    }

    if (!format || dataOffset < 0 || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
      return input;
    }
    if (format.channels < 1 || format.channels > 8 || format.sampleRate < 8000) return input;

    const bytesPerFrame = format.channels * 2;
    const frames = Math.floor(dataLength / bytesPerFrame);
    if (frames < 1) return input;
    const blockFrames = Math.max(1, Math.round(format.sampleRate * 0.01));
    const blocks = Math.ceil(frames / blockFrames);
    const active = new Uint8Array(blocks);
    for (let block = 0; block < blocks; block += 1) {
      const start = block * blockFrames;
      const end = Math.min(frames, start + blockFrames);
      let sumSquares = 0;
      let samples = 0;
      for (let frame = start; frame < end; frame += 1) {
        const frameOffset = dataOffset + frame * bytesPerFrame;
        for (let channel = 0; channel < format.channels; channel += 1) {
          const sample = input.readInt16LE(frameOffset + channel * 2) / 32768;
          sumSquares += sample * sample;
          samples += 1;
        }
      }
      active[block] = Math.sqrt(sumSquares / Math.max(1, samples)) > 0.004 ? 1 : 0;
    }

    const runs = [];
    for (let block = 0; block < blocks; block += 1) {
      const start = block * blockFrames;
      const end = Math.min(frames, start + blockFrames);
      const last = runs[runs.length - 1];
      if (last && last.active === (active[block] === 1)) last.end = end;
      else runs.push({ active: active[block] === 1, start, end });
    }

    const maxGapFrames = Math.round(format.sampleRate * Math.max(0, maxGapMs) / 1000);
    const leadFrames = Math.round(format.sampleRate * Math.max(0, leadMs) / 1000);
    const tailFrames = Math.round(format.sampleRate * Math.max(0, tailMs) / 1000);
    const pieces = [];
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      let end = run.end;
      if (!run.active) {
        let cap = maxGapFrames;
        if (index === 0) cap = leadFrames;
        else if (index === runs.length - 1) cap = tailFrames;
        end = run.start + Math.min(run.end - run.start, cap);
      }
      if (end <= run.start) continue;
      pieces.push(input.subarray(
        dataOffset + run.start * bytesPerFrame,
        dataOffset + end * bytesPerFrame,
      ));
    }

    const data = Buffer.concat(pieces);
    if (!data.length) return input;
    const output = Buffer.concat([input.subarray(0, dataOffset), data]);
    output.writeUInt32LE(output.length - 8, 4);
    output.writeUInt32LE(data.length, dataChunkOffset + 4);
    return output;
  } catch {
    return input;
  }
}

export function __compressWavPausesForTest(input, style = 'intro') {
  return compressWavPauses(input, TTS_STYLES[normalizeTtsStyle(style)]);
}

async function listTtsVoices() {
  let entries = [];
  try {
    entries = await readdir(TTS_VOICES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const voices = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((voice) =>
      ['gpt.ckpt', 'sovits.pth', 'ref.wav'].every((file) => existsSync(path.join(TTS_VOICES_DIR, voice, file))))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return voices;
}

async function canReachTts(endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    await fetch(endpoint + '/', { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureTtsService(endpoint) {
  if (await canReachTts(endpoint)) return;

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  const isLocalDefault = url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && (url.port || '80') === '9880';
  if (!isLocalDefault) return;

  if (!ttsStartPromise) {
    ttsStartPromise = startTtsService(endpoint).finally(() => {
      ttsStartPromise = null;
    });
  }
  await ttsStartPromise;
}

async function startTtsService(endpoint) {
  if (!existsSync(TTS_START_SCRIPT)) {
    throw new Error(`TTS 服务未运行，且找不到启动脚本：${TTS_START_SCRIPT}`);
  }
  if (await canReachTts(endpoint)) return;

  log('info', `Fairy 语音服务未运行，正在启动 ${TTS_START_SCRIPT}`);
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', TTS_START_SCRIPT], {
    cwd: path.dirname(TTS_START_SCRIPT),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, DSH_TTS_VOICES: TTS_VOICES_DIR },
  });
  child.unref();
  ttsLoadedVoice = null;

  const deadline = Date.now() + TTS_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canReachTts(endpoint)) {
      log('info', 'Fairy 语音服务已就绪');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Fairy 语音服务在 ${TTS_START_TIMEOUT_MS / 1000} 秒内未就绪`);
}

let ttsLoadedVoice = null;

async function selectTtsVoice(endpoint, voiceRoot, voice) {
  const key = `${endpoint}\n${voiceRoot}`;
  if (ttsLoadedVoice === key) return;
  const requests = [
    ['gpt', `${endpoint}/set_gpt_weights?weights_path=${encodeURIComponent(path.join(voiceRoot, 'gpt.ckpt'))}`],
    ['sovits', `${endpoint}/set_sovits_weights?weights_path=${encodeURIComponent(path.join(voiceRoot, 'sovits.pth'))}`],
  ];
  for (const [kind, url] of requests) {
    const response = await fetch(url);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`切换 Fairy 音色失败（${kind}，HTTP ${response.status}）：${detail}`);
    }
  }
  ttsLoadedVoice = key;
}


