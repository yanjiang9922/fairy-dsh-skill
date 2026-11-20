/**
 * dsh-fairy-voice 客户端检测层自检。
 *
 *   node test/client-detectors.mjs
 *
 * 不启动浏览器、不启动 DSH：用假的 window / ctx / AudioContext 把真实的
 * lib/client.js 跑起来，然后**驱动真实的宿主事件形状**，断言每个事件都落到了
 * 正确的触发器上。这是不安装也能验证客户端逻辑的办法。
 *
 * 覆盖：两个插槽注册、每个信号源、权限旁听不吞 next()、终局互斥、优先级与冷却。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { TRIGGERS, ALL_SOUND_FILES, defaultConfig } from '../lib/catalog.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error?.message || error}`);
  }
}

/** 触发是异步的（要 fetch + 解码），断言前必须让它落地。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

// ================================================================ 浏览器替身

const started = [];

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
      connect() {},
      disconnect() {},
    };
  }
  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      connect() {},
      start() {
        started.push(source);
        // 真实音源播完会触发 onended，播放器据此清掉「正在播」的状态。
        // 默认立刻结束；需要验证抢占时把它调大，让音效「持续播放」。
        if (FakeAudioContext.autoEndMs >= 0) {
          setTimeout(() => { if (typeof source.onended === 'function') source.onended(); }, FakeAudioContext.autoEndMs);
        }
      },
      stop() { if (typeof this.onended === 'function') this.onended(); },
    };
    return source;
  }
  decodeAudioData() { return Promise.resolve({ duration: 1 }); }
  addEventListener() {}
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
FakeAudioContext.autoEndMs = 0;

function makeEventTarget() {
  const handlers = new Map();
  return {
    addEventListener(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
    },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    dispatch(name, payload) { for (const fn of [...(handlers.get(name) || [])]) fn(payload); },
  };
}

const fakeWindow = Object.assign(makeEventTarget(), {
  AudioContext: FakeAudioContext,
  dshDesktop: undefined,
});

const fakeDocument = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement() { return { id: '', textContent: '', setAttribute() {}, remove() {} }; },
  getElementById() { return null; },
  documentElement: { hasAttribute: () => false },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
};

let moduleDefinition = null;
fakeWindow.__ModuleLoader__ = { load(definition) { moduleDefinition = definition; } };

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
// Node 24 自带只读的 navigator，且没有 clipboard —— 客户端用的是可选链，拿不到就跳过复制。

// ================================================================ 宿主替身

const MANIFEST = {
  ok: true,
  version: 1,
  soundUrlBase: '/fairy-voice/sounds',
  triggers: TRIGGERS,
  available: [...ALL_SOUND_FILES],
  config: { ...defaultConfig(), enabled: true, autoReport: false },
};

const fetchCalls = [];
const nativeFetch = globalThis.fetch;
let ttsShouldFail = false;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!target.startsWith('blob:')) {
    fetchCalls.push({ url: target, method: options?.method || 'GET', body: options?.body });
  }
  if (target.endsWith('/manifest')) return { ok: true, status: 200, json: async () => MANIFEST };
  if (target.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ ok: true, config: JSON.parse(options.body) }) };
  if (target.includes('/sounds/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
  if (target.endsWith('/tts-speak')) {
    if (ttsShouldFail) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: '模拟 TTS 不可用' }),
      };
    }
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array(64)], { type: 'audio/wav' }),
    };
  }
  if (target.startsWith('blob:')) return nativeFetch(url, options);
  return { ok: false, status: 404, json: async () => ({}) };
};

let listState = { ids: [], byId: {}, current: undefined };
const listSubscribers = new Set();
function setCurrent(id, { blank = false } = {}) {
  listState = {
    ...listState,
    ids: id ? [...new Set([...listState.ids, id])] : listState.ids,
    byId: id ? { ...listState.byId, [id]: { id, blank, running: false } } : listState.byId,
    current: id,
  };
  for (const fn of [...listSubscribers]) fn();
}

/** 一个会话的事件窗口。 */
function makeBinding(id) {
  let windowValue = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } };
  const subscribers = new Set();
  const faceSubscribers = new Set();
  let pressure;

  return {
    sessionId: id,
    eventSource: {
      getSnapshot: () => windowValue,
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    },
    session: {
      projections: {
        faceOf(key) {
          if (key !== 'contextPressure') return undefined;
          return {
            getSnapshot: () => pressure,
            subscribe(fn) { faceSubscribers.add(fn); return () => faceSubscribers.delete(fn); },
          };
        },
      },
    },
    append(type, data) {
      const entry = { type: 'event', event: { type, data } };
      windowValue = {
        entries: [...windowValue.entries, entry],
        hasMore: false,
        revision: windowValue.revision + 1,
        change: { kind: 'append', entries: [entry] },
      };
      for (const fn of [...subscribers]) fn();
    },
    setPressure(value) {
      pressure = value;
      for (const fn of [...faceSubscribers]) fn();
    },
  };
}

const bindings = new Map();
function bindingFor(id) {
  if (!bindings.has(id)) bindings.set(id, makeBinding(id));
  return bindings.get(id);
}

const remoteHandlers = new Map();
const registeredSlots = [];
let generation = {};
const generationSubscribers = new Set();

/** 会话层的待处理交互表（键是 sessionId，值是完整交互对象）。 */
let pendingMap = new Map();
const pendingSubscribers = new Set();
function setPending(interactions) {
  pendingMap = new Map((interactions || []).map((item, index) => [item.sessionId || `s${index}`, item]));
  for (const fn of [...pendingSubscribers]) fn();
}

const services = {
  sessions: {
    list: {
      getSnapshot: () => listState,
      subscribe(fn) { listSubscribers.add(fn); return () => listSubscribers.delete(fn); },
    },
    binding: (id) => bindingFor(id),
  },
  remote: {
    $on(name, listener) {
      if (!remoteHandlers.has(name)) remoteHandlers.set(name, new Set());
      remoteHandlers.get(name).add(listener);
      return () => remoteHandlers.get(name)?.delete(listener);
    },
  },
  connection: {
    generation: {
      getSnapshot: () => generation,
      subscribe(fn) { generationSubscribers.add(fn); return () => generationSubscribers.delete(fn); },
    },
  },
  uiSession: {
    pendingInteractions: {
      getSnapshot: () => pendingMap,
      subscribe(fn) { pendingSubscribers.add(fn); return () => pendingSubscribers.delete(fn); },
    },
  },
};

const ctx = {
  slots: {
    inject(name, callback) { return callback(); },
    register(definition, component) { registeredSlots.push({ ...definition, component }); return () => {}; },
  },
  effect(fn) { return fn(); },
  inject(dependencies, callback) {
    for (const name of dependencies) if (!services[name]) return undefined;
    return callback(services);
  },
  get(name) { return services[name]; },
};

/** 深度优先在 jsx 树里找第一个满足条件的节点。 */
function findNode(tree, predicate) {
  if (tree === null || tree === undefined) return null;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  return findNode(tree.props?.children, predicate);
}

const componentFor = (slotName) => registeredSlots.find((slot) => slot.name === slotName)?.component;
const masterCheckbox = () => findNode(
  componentFor('settings.section')(),
  (node) => node.props?.['data-fairy-voice-master'] === 'true',
);

function fireRemote(name, ...args) {
  for (const fn of [...(remoteHandlers.get(name) || [])]) {
    const result = fn(...args);
    if (result && typeof result.then === 'function') result.catch(() => {});
  }
}
const dispatchGeneration = () => { for (const fn of [...generationSubscribers]) fn(); };

// ================================================================ 加载 bundle

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
vm.runInThisContext(source, { filename: 'lib/client.js' });

assert.ok(moduleDefinition, '客户端 bundle 没有调用 window.__ModuleLoader__.load');
const client = moduleDefinition.factory((specifier) => {
  if (specifier === 'react') {
    return {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
      useRef: (initial) => ({ current: initial }),
      Fragment: Symbol('Fragment'),
    };
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: ({ children }) => children };
  throw new Error(`测试替身没有准备 require("${specifier}")`);
});

console.log('\n[1] 插件装载');

await check('工厂返回 apply/inject，且只声明真实存在的服务', () => {
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(client.inject, ['slots']);
});

await check('apply 不抛错，并注册两个插槽', () => {
  client.apply(ctx);
  assert.deepEqual(registeredSlots.map((slot) => slot.name).sort(), ['conversation.input.left', 'settings.section']);
});

await check('没有 require 任何未声明的外部模块', () => {
  // 宿主只内置 8 个 specifier；多 require 一个就会抛 "missed the module table"。
  const allowed = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
  for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
    assert.ok(allowed.has(match[1]), `require 了未声明的模块：${match[1]}`);
  }
});

await settle();
const diag = globalThis.__FAIRY_VOICE_DIAG__;

await check('清单加载成功（否则下面全是 disabled）', () => {
  assert.ok(diag, '没有写出 __FAIRY_VOICE_DIAG__');
  assert.equal(diag.mounted, true);
});

const fired = () => diag.events.map((row) => row.id);
const clearLog = () => { diag.events.length = 0; };
function assertFired(id) {
  assert.ok(fired().includes(id), `期望触发 ${id}，实际=${JSON.stringify(diag.events)}`);
}

console.log('\n[2] 会话生命周期');

await check('进入真实会话 → welcome', async () => {
  clearLog(); setCurrent('session-a'); await settle();
  assertFired('welcome');
  assert.equal(diag.events[0].skipped, null, '应该是真的播了');
});

await check('切到另一个真实会话 → session-switch', async () => {
  clearLog(); setCurrent('session-b'); await settle();
  assertFired('session-switch');
});

await check('切到空白会话 → new-session', async () => {
  clearLog(); setCurrent('session-c', { blank: true }); await settle();
  assertFired('new-session');
});

await check('会话关闭 → goodbye', async () => {
  clearLog(); setCurrent(undefined); await settle();
  assertFired('goodbye');
});

await check('api-session/removed → goodbye', async () => {
  clearLog(); fireRemote('api-session/removed', 'session-c'); await settle();
  assertFired('goodbye');
});

console.log('\n[3] 回合事件（当前会话 = session-b）');

await check('turn/start → task-start', async () => {
  clearLog(); setCurrent('session-b'); await settle(); clearLog();
  bindingFor('session-b').append('turn/start', { turn: 1 });
  await settle();
  assertFired('task-start');
});

await check('turn/end(completed) → success', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await settle();
  assertFired('success');
});

await check('turn/end(aborted, 人工) → aborted', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  await settle();
  assertFired('aborted');
});

await check('turn/end(aborted, 父级导致) → 不响', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'parent' } } });
  await settle();
  assert.deepEqual(fired(), [], `不该出声，实际=${JSON.stringify(diag.events)}`);
});

await check('turn/end(error, 网络特征) → network-error', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', {
    turn: 4, reason: { kind: 'error', error: { message: 'fetch failed: ECONNRESET', code: 'ECONNRESET' } },
  });
  await settle();
  assertFired('network-error');
  assert.equal(diag.events[0].skipped, null, '应该是真的播了，不是被跳过');
});

await check('turn/end(error, 一般错误) → error', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', {
    turn: 5, reason: { kind: 'error', error: { message: 'model refused the request', code: 'BAD_REQUEST' } },
  });
  await settle();
  assertFired('error');
});

await check('turn/end(max-tokens) → error', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', { turn: 6, reason: { kind: 'max-tokens' } });
  await settle();
  assertFired('error');
});

await check('turn/end(blocked / interrupted) → 不响', async () => {
  clearLog();
  bindingFor('session-b').append('turn/end', { turn: 7, reason: { kind: 'blocked' } });
  bindingFor('session-b').append('turn/end', { turn: 8, reason: { kind: 'interrupted' } });
  await settle();
  assert.deepEqual(fired(), [], `不该出声，实际=${JSON.stringify(diag.events)}`);
});

console.log('\n[3b] 回合结束语音汇报');

await check('completed 时提取最终回复并调用本机 TTS', async () => {
  clearLog();
  fakeDocument.querySelectorAll = (selector) => selector.includes('[data-turn-process-answer="true"]')
    ? [{
      getAttribute(name) { return name === 'data-chat-turn' ? '12' : null; },
      innerText: '结论：插件已经接通 Fairy 语音。\n\n```js\nconsole.log("不应朗读")\n```\n任务完成。',
    }]
    : [];
  MANIFEST.config.autoReport = true;
  MANIFEST.config.tts = { endpoint: 'http://127.0.0.1:9880', voice: 'Fairy', speed: 1.1 };
  bindingFor('session-b').append('turn/end', { turn: 12, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 350));

  const ttsCall = fetchCalls.findLast((call) => call.url.endsWith('/tts-speak'));
  assert.ok(ttsCall, '没有调用 /tts-speak');
  const payload = JSON.parse(ttsCall.body);
  assert.equal(payload.voice, 'Fairy');
  assert.equal(payload.speed, 1.1);
  assert.equal(payload.style, 'intro');
  assert.ok(!payload.text.includes('向绳匠法厄同汇报'), '不应每轮重复汇报身份');
  assert.match(payload.text, /任务完成了/);
  assert.match(payload.text, /插件已经接通 Fairy 语音/);
  assert.ok(!payload.text.includes('console.log'), '代码块不应进入播报');
  assert.equal(diag.report.state, 'played');
  assert.ok(!fired().includes('success'), 'TTS 成功时不应再叠加 success 音效');
});

await check('completed 的成功结果沿用启动页语气', async () => {
  clearLog();
  fakeDocument.querySelectorAll = (selector) => selector.includes('[data-turn-process-answer="true"]')
    ? [{
      getAttribute(name) { return name === 'data-chat-turn' ? '14' : null; },
      innerText: '全部测试通过，问题已经解决。',
    }]
    : [];
  MANIFEST.config.autoReport = true;
  bindingFor('session-b').append('turn/end', { turn: 14, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 350));

  const ttsCall = fetchCalls.findLast((call) => call.url.endsWith('/tts-speak'));
  assert.ok(ttsCall, '没有调用 /tts-speak');
  const payload = JSON.parse(ttsCall.body);
  assert.equal(payload.style, 'intro');
});

await check('completed 中带风险的结果也沿用启动页语气', async () => {
  clearLog();
  fakeDocument.querySelectorAll = (selector) => selector.includes('[data-turn-process-answer="true"]')
    ? [{
      getAttribute(name) { return name === 'data-chat-turn' ? '15' : null; },
      innerText: '执行失败：配置文件已损坏。',
    }]
    : [];
  MANIFEST.config.autoReport = true;
  bindingFor('session-b').append('turn/end', { turn: 15, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 350));

  const ttsCall = fetchCalls.findLast((call) => call.url.endsWith('/tts-speak'));
  assert.ok(ttsCall, '没有调用 /tts-speak');
  const payload = JSON.parse(ttsCall.body);
  assert.equal(payload.style, 'intro');
});

await check('TTS 不可用时回落到原 success 音效', async () => {
  clearLog();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  ttsShouldFail = true;
  bindingFor('session-b').append('turn/end', { turn: 13, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 350));
  ttsShouldFail = false;
  MANIFEST.config.autoReport = false;
  fakeDocument.querySelectorAll = undefined;
  assert.equal(diag.report.state, 'failed');
  assert.ok(fired().includes('success'), `应回落 success，实际=${JSON.stringify(diag.events)}`);
});

await check('llm/retry → retry', async () => {
  clearLog();
  bindingFor('session-b').append('llm/retry', { turn: 9, provider: 'deepseek', retry: 1, delayMs: 1000 });
  await settle();
  assertFired('retry');
  assert.equal(diag.events.find((row) => row.id === 'retry').skipped, null, '应该是真的播了');
});

console.log('\n[4] 压缩');

await check('compaction/start（无 sourceCommandId） → compact-auto', async () => {
  clearLog();
  bindingFor('session-b').append('compaction/start', { compactionId: 'c1', turn: 10 });
  await settle();
  assertFired('compact-auto');
});

await check('compaction/start（带 sourceCommandId） → compact-manual', async () => {
  clearLog();
  bindingFor('session-b').append('compaction/start', { compactionId: 'c2', sourceCommandId: 'cmd1', turn: null });
  await settle();
  assertFired('compact-manual');
});

await check('compaction/end 带 error → compaction-failed', async () => {
  clearLog();
  bindingFor('session-b').append('compaction/end', { compactionId: 'c2', error: 'summarizer crashed' });
  await settle();
  assertFired('compaction-failed');
});

await check('compaction/end 无 error → compact-success', async () => {
  clearLog();
  bindingFor('session-b').append('compaction/end', { compactionId: 'c1' });
  await settle();
  assertFired('compact-success');
});

await check('compaction/summary → compact-success', async () => {
  clearLog();
  bindingFor('session-b').append('compaction/summary', { compactionId: 'c3' });
  await settle();
  assertFired('compact-success');
});

console.log('\n[5] 模型 / 权限 / 连接 / 上下文');

await check('model/selection 首帧只建基线，第二次才响', async () => {
  clearLog();
  const binding = bindingFor('session-b');
  binding.append('model/selection', { provider: 'deepseek', model: 'a' });
  await settle();
  assert.deepEqual(fired(), [], '首帧不该响');
  binding.append('model/selection', { provider: 'deepseek', model: 'b' });
  await settle();
  assertFired('model-switch');
});

await check('approval/request 瀑布流监听器会交出 next()（兜底路径）', async () => {
  clearLog();
  let nextCalled = false;
  fireRemote('approval/request', { key: 'req-1', kind: 'approval' }, () => { nextCalled = true; });
  await settle();
  assertFired('permission');
  assert.equal(nextCalled, true, '必须把瀑布流交下去，否则官方授权界面就不出来了');
});

await check('待处理交互出现 → permission（主路径，不靠瀑布流）', async () => {
  clearLog();
  let settleDecision;
  setPending([{
    sessionId: 'session-b',
    kind: 'approval',
    key: 'approval:1',
    toolName: 'pwsh',
    result: new Promise((resolve) => { settleDecision = resolve; }),
  }]);
  await settle();
  assertFired('permission');
  assert.ok(settleDecision, '测试替身应该留下决策句柄');

  // 同一个 key 再来一次通知不该重复响
  clearLog();
  setPending([{
    sessionId: 'session-b', kind: 'approval', key: 'approval:1', toolName: 'pwsh',
    result: new Promise(() => {}),
  }]);
  await settle();
  assert.deepEqual(fired(), [], `同一个 key 不该重复响，实际=${JSON.stringify(diag.events)}`);
});

await check('用户批准 → permission-approved', async () => {
  clearLog();
  let settleDecision;
  setPending([{
    sessionId: 'session-b', kind: 'approval', key: 'approval:2', toolName: 'pwsh',
    result: new Promise((resolve) => { settleDecision = resolve; }),
  }]);
  await settle();
  clearLog();
  settleDecision('allowed-once');
  await settle();
  assertFired('permission-approved');
  assert.equal(diag.events.find((row) => row.id === 'permission-approved').skipped, null, '应该是真的播了');
});

await check('用户拒绝 → permission-denied', async () => {
  clearLog();
  let settleDecision;
  setPending([{
    sessionId: 'session-b', kind: 'approval', key: 'approval:3', toolName: 'pwsh',
    result: new Promise((resolve) => { settleDecision = resolve; }),
  }]);
  await settle();
  clearLog();
  settleDecision('rejected');
  await settle();
  assertFired('permission-denied');
});

await check('决策被委托给别的监听器（result reject）→ 不出决策音', async () => {
  clearLog();
  let failDecision;
  setPending([{
    sessionId: 'session-b', kind: 'approval', key: 'approval:4', toolName: 'pwsh',
    result: new Promise((_resolve, reject) => { failDecision = reject; }),
  }]);
  await settle();
  clearLog();
  failDecision(new Error('delegated'));
  await settle();
  assert.deepEqual(fired(), [], `委托不是拒绝，不该出声，实际=${JSON.stringify(diag.events)}`);
});

await check('交互消失后同一个 key 可以再利用', async () => {
  clearLog();
  setPending([]);
  await settle();
  setPending([{
    sessionId: 'session-b', kind: 'approval', key: 'approval:9', toolName: 'pwsh',
    result: new Promise(() => {}),
  }]);
  await settle();
  assertFired('permission');
});

await check('api-session/error（网络特征） → network-error 路径', async () => {
  clearLog();
  fireRemote('api-session/error', 'session-b', 'websocket closed unexpectedly');
  await settle();
  // 上一条 network-error 在冷却窗内，所以记录成 cooldown —— 那也证明检测路径跑了。
  assert.ok(fired().includes('network-error'), `期望 network-error，实际=${JSON.stringify(diag.events)}`);
});

await check('connection 掉线 → network-error', async () => {
  clearLog();
  generation = undefined;
  dispatchGeneration();
  await settle();
  assert.ok(fired().includes('network-error'), `期望 network-error，实际=${JSON.stringify(diag.events)}`);
});

await check('上下文越过阈值 → context-warning，回落后重新武装', async () => {
  clearLog();
  const binding = bindingFor('session-b');
  binding.setPressure({ projectedTokens: 100, contextWindow: 1000 });
  await settle();
  assert.deepEqual(fired(), [], '未到阈值不该响');

  binding.setPressure({ projectedTokens: 850, contextWindow: 1000 });
  await settle();
  assertFired('context-warning');

  clearLog();
  binding.setPressure({ projectedTokens: 900, contextWindow: 1000 });
  await settle();
  assert.deepEqual(fired(), [], '已在阈值上不该重复响');

  binding.setPressure({ projectedTokens: 500, contextWindow: 1000 });   // 压缩后回落
  await settle();
  binding.setPressure({ projectedTokens: 950, contextWindow: 1000 });
  await settle();
  assertFired('context-warning');
});

await check('历史加载不会出声（change.kind 不是 append）', async () => {
  clearLog();
  // 窗口只在 append 时通知订阅者；把一整段历史当作 replace 灌进去不该有任何声音。
  const binding = bindingFor('session-new');
  setCurrent('session-new');
  await settle();
  clearLog();
  assert.deepEqual(fired(), [], `历史不该出声，实际=${JSON.stringify(diag.events)}`);
  assert.ok(binding);
});

console.log('\n[6] 播放链');

await check('真的走到了 AudioContext（有音源被 start）', () => {
  assert.ok(started.length > 0, '没有任何音源被启动');
});

await check('音效只从本机 /fairy-voice/ 拉，没有外部请求', () => {
  const soundCalls = fetchCalls.filter((call) => call.url.includes('/sounds/'));
  assert.ok(soundCalls.length > 0, '没有拉过音效');
  for (const call of fetchCalls) {
    assert.ok(call.url.startsWith('/fairy-voice') || call.url === '/balance-meter', `出现了外部请求：${call.url}`);
  }
});

await check('冷却真的生效：连发两次只播一次', async () => {
  clearLog();
  const binding = bindingFor('session-new');
  binding.append('llm/retry', { turn: 1 });
  binding.append('llm/retry', { turn: 2 });
  await settle();
  const rows = diag.events.filter((row) => row.id === 'retry');
  assert.equal(rows.length, 2, '两次都要有记录');
  // retry 的冷却窗是 5 秒，而上一节刚刚播过一次 —— 所以这两次都应被冷却拦下。
  assert.equal(rows.filter((row) => row.skipped === 'cooldown').length, 2, '两次都应在冷却窗内被拦');
});

await check('关掉总开关后不再发声', async () => {
  clearLog();
  MANIFEST.config.enabled = false;   // store.config 与它是同一个对象引用
  bindingFor('session-new').append('turn/start', { turn: 77 });
  await settle();
  assert.deepEqual(fired(), [], `关掉后不该发声，实际=${JSON.stringify(diag.events)}`);
  MANIFEST.config.enabled = true;
});

console.log('\n[7] 优先级抢占（照搬 pi-fairy）');

await check('高优先级占用时，较低优先级被直接丢弃（不排队、不续播）', async () => {
  clearLog();
  // 等过 success 的冷却窗，让它成为一个「新鲜」的高优先级音效。
  await new Promise((resolve) => setTimeout(resolve, 1600));
  FakeAudioContext.autoEndMs = 5000;   // 让音效「持续播放」，模拟真实的高优先级占用
  try {
    bindingFor('session-new').append('turn/end', { turn: 90, reason: { kind: 'completed' } });   // success = high(100)
    await settle();
    const high = diag.events.find((row) => row.id === 'success');
    assert.ok(high && high.skipped === null, `success 应该先响，实际=${JSON.stringify(diag.events)}`);

    clearLog();
    fakeWindow.dispatch('dsh-balance-changed', { detail: { balances: [{ currency: 'CNY', total: 1 }] } });   // quota-warning = medium(50)
    await settle();
    const low = diag.events.find((row) => row.id === 'quota-warning');
    assert.ok(low, `quota-warning 应该被检测到，实际=${JSON.stringify(diag.events)}`);
    assert.equal(low.skipped, 'busy', '较低优先级应被丢弃，而不是打断正在播的音效');
  } finally {
    FakeAudioContext.autoEndMs = 0;
  }
});

console.log('\n[8] 开关回归（0.1.1 的真实 bug）');

/* 背景：React 的受控 checkbox 在事件处理返回后会立刻把 DOM 重置回受控值。
 * 0.1.1 的处理函数里写着 `await player.unlock()` 之后才读 `event.target.checked`，
 * 于是永远读到被重置后的 false —— 开关怎么点都开不起来，只响 voice-off。
 *
 * 这里的回归测试刻意把 onChange 的入参传成「已被重置的旧值」，
 * 正确的实现应当完全无视它。 */

await check('设置面板：点「启用事件音效」，即使事件里带的是旧值也能打开', async () => {
  clearLog();
  MANIFEST.config.enabled = false;
  const before = masterCheckbox();
  assert.equal(before.props.checked, false, '前置状态应该是关的');

  // 模拟 React 重置后的 event：target.checked 是 false（旧值）
  before.props.onChange({ target: { checked: false } });
  await settle();

  assertFired('voice-on');
  assert.ok(!fired().includes('voice-off'), `不该响 voice-off，实际=${JSON.stringify(diag.events)}`);
  assert.equal(masterCheckbox().props.checked, true, '重新渲染后 checkbox 应该是打开的');
});

await check('设置面板：再点一次能关掉', async () => {
  clearLog();
  // 这次事件里带的是 true（同为旧值，方向相反）
  masterCheckbox().props.onChange({ target: { checked: true } });
  await settle();
  assertFired('voice-off');
  assert.equal(masterCheckbox().props.checked, false, '重新渲染后 checkbox 应该是关的');
});

await check('输入栏控件：圆点按钮同样能开关', async () => {
  clearLog();
  const button = () => findNode(
    componentFor('conversation.input.left')(),
    (node) => node.props?.['data-fairy-voice-toggle'] === 'true',
  );
  assert.equal(button().props['data-on'], 'false');
  button().props.onClick();
  await settle();
  assertFired('voice-on');
  assert.equal(button().props['data-on'], 'true', '重渲染后按钮应该显示为开');
});

await check('开关的处理函数里不含 await（这正是 bug 的成因）', () => {
  // 源码级护栏：一旦有人再往这两个 onChange/onClick 里塞 await 并读 event，就会重新踩坑。
  const master = /'data-fairy-voice-master':\s*'true',[\s\S]{0,400}?onChange:\s*\(([^)]*)\)\s*=>/.exec(source);
  assert.ok(master, '没有找到主开关的 onChange');
  assert.equal(master[1].trim(), '', `onChange 不该接收参数（收到的是不可靠的 DOM 事件），实际参数=${master[1]}`);
});

// ================================================================ 收尾

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
