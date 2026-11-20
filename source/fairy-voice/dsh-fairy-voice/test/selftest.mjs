/**
 * dsh-fairy-voice 自检。
 *
 * 不启动 DSH、不碰你真实的 ~/.dsh：全程在临时目录里跑，结束自动清理。
 *   node test/selftest.mjs
 *
 * 覆盖：
 *   1. 目录 ↔ 素材一对一（清单里有的一定在磁盘上，磁盘上没有清单外的多余文件）
 *   2. 宿主路由能起来：status / manifest / config 读写
 *   3. 音效静态服务：正常返回 audio/wav，且挡得住目录穿越
 *   4. 首次播种：空目录启动后会自己填满
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   ${name}`); })
    .catch((error) => { failures += 1; console.error(`  FAIL ${name}\n       ${error?.message || error}`); });
}

// ---------------------------------------------------------------- 1. 素材

const { TRIGGERS, ALL_SOUND_FILES, defaultConfig } = await import('../lib/catalog.js');

console.log('\n[1] 触发器目录 ↔ 素材');

await check('触发器 id 唯一', () => {
  const ids = TRIGGERS.map((trigger) => trigger.id);
  assert.equal(new Set(ids).size, ids.length, '有重复的触发器 id');
});

await check('每个触发器都有素材且优先级合法', () => {
  for (const trigger of TRIGGERS) {
    assert.ok(trigger.files.length > 0, `${trigger.id} 没有素材`);
    assert.ok(['low', 'medium', 'high'].includes(trigger.priority), `${trigger.id} 优先级非法`);
  }
});

await check('清单里的素材全部存在于 assets/sounds', async () => {
  const dir = path.join(PKG, 'assets', 'sounds');
  const onDisk = new Set((await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.wav')));
  const missing = ALL_SOUND_FILES.filter((file) => !onDisk.has(file));
  assert.deepEqual(missing, [], `缺少素材：${missing.join(', ')}`);
});

await check('磁盘上没有清单外的多余 wav', async () => {
  const dir = path.join(PKG, 'assets', 'sounds');
  const onDisk = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.wav'));
  const orphans = onDisk.filter((file) => !ALL_SOUND_FILES.includes(file));
  assert.deepEqual(orphans, [], `多余素材：${orphans.join(', ')}`);
});

await check('覆盖 pi-fairy 清单里的全部 44 段', () => {
  assert.equal(ALL_SOUND_FILES.length, 44, `期望 44 段，实际 ${ALL_SOUND_FILES.length}`);
});

await check('默认配置结构完整', () => {
  const config = defaultConfig();
  assert.equal(typeof config.enabled, 'boolean');
  assert.equal(config.enabled, false, '默认必须是关的（与上游约定一致）');
  for (const trigger of TRIGGERS) {
    assert.equal(typeof config.triggers[trigger.id], 'boolean', `${trigger.id} 缺少默认开关`);
    assert.deepEqual(
      config.soundSelections[trigger.id],
      trigger.files,
      `${trigger.id} 默认应选中全部素材`,
    );
  }
  assert.equal(config.startupVoice.enabled, true);
  assert.equal(config.startupVoice.preset, 'full');
  assert.equal(config.startupVoice.greetingEnabled, true);
  assert.equal(config.startupVoice.greetingPauseMs, 1500);
});

// ---------------------------------------------------------------- 2/3/4. 宿主

console.log('\n[2] 宿主路由');

const sandbox = await mkdtemp(path.join(tmpdir(), 'fairy-voice-selftest-'));
process.env.DSH_HOME = sandbox;

const host = await import('../lib/index.js');

const routes = [];
const fakeCtx = {
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['webServer']);
    callback({
      effect: (fn) => fn(),
      webServer: {
        register: (route) => {
          const conflict = routes.find((item) => item.kind === route.kind && item.path === route.path);
          assert.equal(conflict, undefined, `路由重复注册：${route.kind} ${route.path}`);
          routes.push(route);
          return () => {};
        },
      },
    });
  },
};

host.apply(fakeCtx);
// 播种是启动时异步跑的；按实际完成情况等待，避免慢磁盘下测试与复制竞态。
const seededSoundDir = path.join(sandbox, 'fairy-voice', 'sounds');
const seedDeadline = Date.now() + 5000;
while (Date.now() < seedDeadline) {
  const present = existsSync(seededSoundDir)
    ? new Set((await readdir(seededSoundDir)).filter((name) => name.toLowerCase().endsWith('.wav')))
    : new Set();
  if (ALL_SOUND_FILES.every((file) => present.has(file))) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function findRoute(kind, routePath) {
  const route = routes.find((item) => item.kind === kind && item.path === routePath);
  assert.ok(route, `没有注册 ${kind} ${routePath}`);
  return route;
}

/** 最小 http 响应替身：支持 writeHead/end 与被 pipe。 */
function fakeResponse() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  stream.status = 0;
  stream.headers = {};
  stream.writeHead = (status, headers) => { stream.status = status; stream.headers = headers || {}; };
  stream.body = () => Buffer.concat(chunks);
  return stream;
}

/** 最小 http 请求替身：需要可异步迭代（读 body）。 */
function fakeRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

async function call(kind, routePath, options = {}) {
  const route = findRoute(kind, routePath);
  const req = fakeRequest(options.method || 'GET', options.url || routePath, options.body);
  const res = fakeResponse();
  await route.handler(req, res);
  // 静态音效是 pipe 过来的，必须等流真正 flush 完再断言，否则读到空 body。
  await new Promise((resolve) => {
    if (res.writableFinished) { resolve(); return; }
    res.on('finish', resolve);
    res.on('error', resolve);
  });
  return res;
}

await check('注册了 5 条路由且无冲突', () => {
  assert.equal(routes.length, 5, `期望 5 条，实际 ${routes.length}`);
});

await check('首次启动把 44 段素材播种到临时目录', async () => {
  const res = await call('exact', '/fairy-voice/status');
  assert.equal(res.status, 200);
  const value = JSON.parse(res.body().toString('utf8'));
  assert.equal(value.ok, true);
  assert.equal(value.available, 44, `播种后应就绪 44 段，实际 ${value.available}`);
  assert.deepEqual(value.missing, []);
  assert.ok(existsSync(path.join(sandbox, 'fairy-voice', 'sounds', 'welcome-1.wav')), 'welcome-1.wav 没有被播种');
});

await check('manifest 带出全部触发器与配置', async () => {
  const res = await call('exact', '/fairy-voice/manifest');
  const value = JSON.parse(res.body().toString('utf8'));
  assert.equal(value.triggers.length, TRIGGERS.length);
  assert.equal(value.soundUrlBase, '/fairy-voice/sounds');
  assert.equal(value.config.enabled, false);
  assert.equal(value.config.autoReport, true);
  assert.equal(value.config.startupVoice.preset, 'full');
  for (const trigger of TRIGGERS) {
    assert.deepEqual(
      value.config.soundSelections[trigger.id],
      trigger.files,
      `旧配置缺少 soundSelections 时，${trigger.id} 应默认全选`,
    );
  }
  assert.ok(Array.isArray(value.ttsVoices), 'manifest 应带出可选音色');
});

await check('每段语音可单独选择且非法文件名会被过滤', async () => {
  const res = await call('exact', '/fairy-voice/config', {
    method: 'POST',
    body: {
      soundSelections: {
        welcome: ['welcome-2.wav', 'welcome-2.wav', 'welcome-4.wav', 'evil.wav', 42],
      },
    },
  });
  const saved = JSON.parse(res.body().toString('utf8')).config;
  assert.deepEqual(saved.soundSelections.welcome, ['welcome-2.wav', 'welcome-4.wav']);
  assert.deepEqual(
    saved.soundSelections.goodbye,
    TRIGGERS.find((trigger) => trigger.id === 'goodbye').files,
    '修改一个事件不应重置其他事件的选择',
  );
});

await check('空语音选择会保存且不影响其他事件', async () => {
  const res = await call('exact', '/fairy-voice/config', {
    method: 'POST',
    body: { soundSelections: { 'task-start': [] } },
  });
  const saved = JSON.parse(res.body().toString('utf8')).config;
  assert.deepEqual(saved.soundSelections['task-start'], []);
  assert.deepEqual(saved.soundSelections.welcome, ['welcome-2.wav', 'welcome-4.wav']);
});

await check('音效静态服务返回 audio/wav', async () => {
  const res = await call('prefix', '/fairy-voice/sounds', { url: '/fairy-voice/sounds/welcome-1.wav' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  const body = res.body();
  assert.equal(body.subarray(0, 4).toString('ascii'), 'RIFF', '不是一个 WAV 文件');
  assert.equal(body.length, res.headers['Content-Length']);
});

await check('音效服务挡得住目录穿越', async () => {
  for (const attack of ['/fairy-voice/sounds/../../config.json', '/fairy-voice/sounds/..%2f..%2fconfig.json', '/fairy-voice/sounds/sub/welcome-1.wav']) {
    const res = await call('prefix', '/fairy-voice/sounds', { url: attack });
    assert.ok(res.status === 404 || res.status === 400, `${attack} 竟然返回了 ${res.status}`);
  }
});

await check('清单外的文件名一律 404', async () => {
  const res = await call('prefix', '/fairy-voice/sounds', { url: '/fairy-voice/sounds/evil.wav' });
  assert.equal(res.status, 404);
});

await check('配置写入并回读', async () => {
  const written = await call('exact', '/fairy-voice/config', {
    method: 'POST',
    body: { enabled: true, volume: 0.35, triggers: { activity: true, input: false } },
  });
  assert.equal(written.status, 200);
  const saved = JSON.parse(written.body().toString('utf8')).config;
  assert.equal(saved.enabled, true);
  assert.equal(saved.volume, 0.35);
  assert.equal(saved.triggers.activity, true);

  const read = await call('exact', '/fairy-voice/config');
  const reread = JSON.parse(read.body().toString('utf8')).config;
  assert.equal(reread.enabled, true, '落盘的配置没有读回来');
  assert.equal(reread.volume, 0.35);
});

await check('非法值被收敛而不是写坏配置', async () => {
  const res = await call('exact', '/fairy-voice/config', {
    method: 'POST',
    body: { volume: 99, activityMinutes: -5, contextWarningRatio: 'nonsense', triggers: { welcome: 'yes' } },
  });
  const saved = JSON.parse(res.body().toString('utf8')).config;
  assert.equal(saved.volume, 1, 'volume 应该被夹到 1');
  assert.equal(saved.activityMinutes, 1, 'activityMinutes 应该被夹到 1');
  assert.equal(saved.contextWarningRatio, 0.8, '非法阈值应回落默认值');
  assert.equal(saved.triggers.welcome, false, '非 true 的开关应视为关');
});

await check('启动语音可单独配置且只合并指定字段', async () => {
  const res = await call('exact', '/fairy-voice/config', {
    method: 'POST',
    body: {
      startupVoice: {
        preset: 'custom',
        customText: '主人，Fairy 已就绪。',
        greetingEnabled: false,
        greetingPauseMs: 99999,
      },
    },
  });
  const saved = JSON.parse(res.body().toString('utf8')).config;
  assert.equal(saved.startupVoice.enabled, true, '未修改的启用状态应保留');
  assert.equal(saved.startupVoice.preset, 'custom');
  assert.equal(saved.startupVoice.customText, '主人，Fairy 已就绪。');
  assert.equal(saved.startupVoice.greetingEnabled, false);
  assert.equal(saved.startupVoice.greetingPauseMs, 5000, '停顿应夹到 5000ms');
});

await check('未知字段不会让配置结构崩掉', async () => {
  const res = await call('exact', '/fairy-voice/config', { method: 'POST', body: { 未来字段: { a: 1 } } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body().toString('utf8')).config.version, 2);
});

function makeToneWav({ firstMs, gapMs, secondMs, totalMs = 3000, sampleRate = 8000 }) {
  const frames = Math.round(sampleRate * totalMs / 1000);
  const firstFrames = Math.round(sampleRate * firstMs / 1000);
  const gapFrames = Math.round(sampleRate * gapMs / 1000);
  const secondFrames = Math.round(sampleRate * secondMs / 1000);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(frames * 2, 40);
  const writeTone = (start, count) => {
    for (let frame = start; frame < start + count; frame += 1) {
      wav.writeInt16LE(Math.round(Math.sin(frame / 8) * 2000), 44 + frame * 2);
    }
  };
  writeTone(0, firstFrames);
  writeTone(firstFrames + gapFrames, secondFrames);
  return wav;
}

await check('TTS 只裁掉超长空白，不把整句压扁', () => {
  const wav = makeToneWav({ firstMs: 100, gapMs: 1000, secondMs: 100 });
  const compressed = host.__compressWavPausesForTest(wav, 'intro');
  const dataSize = compressed.readUInt32LE(40);
  assert.ok(dataSize > 9000, `超长空白压得过狠，data=${dataSize}`);
  assert.ok(dataSize < 16000, `连续静音没有合并，data=${dataSize}`);
});

await check('TTS 保留正常换气停顿', () => {
  const wav = makeToneWav({ firstMs: 100, gapMs: 250, secondMs: 100 });
  const compressed = host.__compressWavPausesForTest(wav, 'intro');
  const dataSize = compressed.readUInt32LE(40);
  assert.ok(dataSize > 8500 && dataSize < 9500, `正常换气被压坏，data=${dataSize}`);
});

// ---------------------------------------------------------------- 收尾

await rm(sandbox, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
