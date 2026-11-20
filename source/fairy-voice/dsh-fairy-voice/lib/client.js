/**
 * dsh-fairy-voice — 客户端。
 *
 * 事件音效之外，还在每个回合结束时把最终结论压成一小段中文，
 * 通过宿主代理交给本机 GPT-SoVITS，用 Fairy 音色播报。
 * 对话内容不会发往外部服务；只读取当前回合已经显示在页面里的最终回复。
 *
 * 事件语义照搬上游 pi-fairy 的语音模块（modules/voice/README.md）：
 *   - 优先级抢占：high > medium > low，同级或更高才能打断当前播放
 *   - 终局互斥：network-error > error > aborted > success
 *   - 同类随机不连播
 *
 * 检测层刻意不放在 React 里。信号全部来自宿主已经公开的**类型化投影**：
 *
 *   ctx.sessions.list                     → welcome / session-switch / new-session
 *   binding(id).eventSource               → turn/start, turn/end(completed|error|aborted),
 *                                           llm/retry, compaction/*, model/selection
 *   binding(id).session.projections       → contextPressure（上下文占用）
 *   ctx.remote.$on('approval/request')    → 权限请求
 *   ctx.remote.$on('api-session/error')   → 会话级错误
 *   ctx.connection.generation             → 断连（网络错误）
 *   window.dshDesktop.refreshBalance()    → 余额
 *
 * 事件检测不抓 DOM：官方插件的 DOM 契约不少是**本地化文本**（aria-label、按钮文案），
 * 换语言就碎；而事件窗口里的 reason.kind 是结构化的，换版式不受影响。
 * 只有自动语音汇报需要读取当前回合已经渲染出的最终回复，此时才使用稳定的
 * data-chat-flow-kind / data-turn-process-answer 投影属性。
 */

window.__ModuleLoader__.load({
  id: 'dsh-fairy-voice',
  factory: (require) => {
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const Tooltip = primitives?.Tooltip || (({ children }) => children);

    const ENDPOINT = '/fairy-voice';
    const STYLE_ID = 'dsh-fairy-voice-style';
    const CONTROL_ATTRIBUTE = 'data-dsh-fairy-voice-control';
    const MAX_DIAGNOSTIC_ROWS = 14;

    // ================================================================ 诊断

    const diagnostics = {
      mounted: false,
      audioContextState: 'none',
      subscriptions: Object.create(null),
      events: [],
      notes: [],
      report: { state: 'idle', voice: null, at: 0, error: null, chars: 0 },
    };

    function note(message) {
      diagnostics.notes.push({ at: Date.now(), message: String(message) });
      if (diagnostics.notes.length > 40) diagnostics.notes.splice(0, diagnostics.notes.length - 40);
      try { console.warn(`[fairy-voice] ${message}`); } catch { /* 无所谓 */ }
    }

    function mark(name, value) {
      diagnostics.subscriptions[name] = value;
    }

    function recordEvent(id, file, skipped) {
      diagnostics.events.unshift({ at: Date.now(), id, file: file || null, skipped: skipped || null });
      if (diagnostics.events.length > MAX_DIAGNOSTIC_ROWS) diagnostics.events.length = MAX_DIAGNOSTIC_ROWS;
      // 便于在 DevTools 里直接看：__FAIRY_VOICE_DIAG__.events
      try { globalThis.__FAIRY_VOICE_DIAG__ = diagnostics; } catch { /* 无所谓 */ }
      // 宿主把渲染进程的 console 转发到日志里，排查"为什么没声"时有用。
      try { console.error('DSH_FAIRY_SFX ' + JSON.stringify({ id, file: file || null, result: skipped || 'played' })); } catch { /* 忽略 */ }
    }

    // ============================================================ 自动汇报

    const REPORT_LIMIT = 220;
    const REPORT_PRIORITY = 120;
    const STARTUP_PRESET_TEXT = Object.freeze({
      /* 空格本身就是试听稿的气口边界；不要擅自补回逗号或句号。 */
      full: '我是三型总序式集成泛用人工智能 您可以称呼我为 Fairy  根据您签署的用户协议 我将在所有环节上 辅佐您 协助您  完成自己的工作 很高兴为您服务，主人',
      short: '我是 Fairy，已经准备就绪。主人，请吩咐。',
    });

    function startupText(value) {
      const preset = ['full', 'short', 'custom'].includes(value?.preset) ? value.preset : 'full';
      if (preset === 'custom') {
        const custom = typeof value?.customText === 'string' ? value.customText.trim() : '';
        return custom || STARTUP_PRESET_TEXT.full;
      }
      return STARTUP_PRESET_TEXT[preset] || STARTUP_PRESET_TEXT.full;
    }

    function splitStartupSpeech(text) {
      const full = String(text || STARTUP_PRESET_TEXT.full).trim();
      const marker = '根据您签署的用户协议';
      const index = full.indexOf(marker);
      const parts = index > 0
        ? [
          { text: full.slice(0, index).trim(), speed: 1, pauseBeforeMs: 0 },
          { text: full.slice(index).trim(), speed: 0.96, pauseBeforeMs: 0 },
        ]
        : [{ text: full, speed: 1, pauseBeforeMs: 0 }];
      return parts.filter((part) => part.text);
    }

    function currentGreetingText() {
      const hour = new Date().getHours();
      const greeting = hour >= 5 && hour < 11 ? '早上好'
        : hour >= 11 && hour < 13 ? '中午好'
          : hour >= 13 && hour < 18 ? '下午好'
            : '晚上好';
      return `${greeting}，主人。`;
    }

    /**
     * 只保留适合朗读的纯文本。代码、表格、链接和 Markdown 标记都会被移除，
     * 避免 Fairy 把路径、反引号或一整段代码逐字念出来。
     */
    function cleanReportText(value) {
      return String(value || '')
        .replace(/\u0000/g, '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/[^\s)]+/gi, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
        .replace(/^\s*\|.*\|\s*$/gm, ' ')
        .replace(/[*_~]+/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    }

    function compactReportText(text, limit = REPORT_LIMIT) {
      const cleaned = cleanReportText(text);
      if (!cleaned) return '';
      const sentences = cleaned
        .split(/(?<=[。！？!?；;])\s*|\n+/u)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
        .filter((part) => !/^(?:主人|汇报|结论|摘要)[：:，,\s]*$/u.test(part));
      const picked = [];
      let used = 0;
      for (const sentence of sentences) {
        if (picked.includes(sentence)) continue;
        const normalized = /[。！？!?；;]$/u.test(sentence) ? sentence : `${sentence}。`;
        if (used + normalized.length > limit && picked.length > 0) break;
        picked.push(normalized);
        used += normalized.length;
        if (picked.length >= 3 || used >= limit) break;
      }
      const result = (picked.length > 0 ? picked.join('') : cleaned).replace(/\s+/g, ' ').trim();
      return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
    }

    function buildTurnReport(text, reason) {
      const prefix = {
        completed: '主人，任务完成了。',
        aborted: '主人，任务已经停止。',
        error: '主人，这次执行遇到了错误。',
        'network-error': '主人，网络连接出现问题，这次任务没有完成。',
        'max-tokens': '主人，模型的输出达到长度上限，这次任务没有完整结束。',
      }[reason] || '主人，这一轮已经结束。';
      if (reason !== 'completed') return prefix;
      const summary = compactReportText(text);
      return summary ? `${prefix}${summary}` : '主人，任务完成了。详细结果已经显示在对话里。';
    }

    function readFinalAnswerText(turn) {
      if (typeof document?.querySelectorAll !== 'function') return '';
      const targetTurn = turn == null ? '' : String(turn);
      const nodes = [...document.querySelectorAll(
        '[data-chat-flow-kind="assistant-step"][data-turn-process-answer="true"]',
      )];
      const exact = targetTurn
        ? nodes.find((candidate) => candidate.getAttribute('data-chat-turn') === targetTurn)
        : null;
      // DSH 的最终回复节点不一定带 data-chat-turn；此时只能取最新的最终回复。
      const node = exact || nodes[nodes.length - 1];
      return cleanReportText(node?.innerText || node?.textContent || '');
    }

    async function waitForFinalAnswer(turn, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      let last = '';
      let stableSince = 0;
      while (Date.now() < deadline) {
        const text = readFinalAnswerText(turn);
        if (text) {
          if (text === last) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= 180) return text;
          } else {
            last = text;
            stableSince = 0;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return last;
    }

    // ============================================================ 共享状态

    /* 引擎跑在 cordis 侧，两个插槽组件只是视图，所以状态放模块作用域。 */
    const listeners = new Set();

    const store = {
      ready: false,
      error: null,
      manifest: null,
      config: null,
      revision: 0,
      snapshot: { ready: false, error: null, manifest: null, config: null, revision: 0 },
    };

    function publish() {
      store.revision += 1;
      store.snapshot = {
        ready: store.ready,
        error: store.error,
        manifest: store.manifest,
        config: store.config,
        revision: store.revision,
      };
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* 视图报错不影响引擎 */ }
      }
    }

    function subscribeStore(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function readSnapshot() {
      return store.snapshot;
    }

    // ============================================================ 音频播放

    /**
     * WAV 播放器：URL → AudioBuffer → 按优先级播放或抢占。
     * 解码结果按 URL 缓存；32 kHz 单声道素材由浏览器的 decodeAudioData 自行重采样。
     */
    function createPlayer() {
      const buffers = new Map();
      let context = null;
      let master = null;
      let active = null;

      function readVolume() {
        const value = Number(store.config?.volume);
        return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8;
      }

      function ensureContext() {
        if (context) return context;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) { note('浏览器没有 AudioContext，无法播放音效'); return null; }
        context = new Ctor();
        master = context.createGain();
        master.gain.value = readVolume();
        master.connect(context.destination);
        diagnostics.audioContextState = context.state;
        try {
          context.addEventListener('statechange', () => { diagnostics.audioContextState = context.state; });
        } catch { /* 老浏览器没有 addEventListener */ }
        return context;
      }

      /** 浏览器自动播放策略：首次用户手势之前 AudioContext 是 suspended。 */
      async function unlock() {
        const ctx = ensureContext();
        if (!ctx) return false;
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch { /* 还没拿到手势，下次再说 */ }
        }
        diagnostics.audioContextState = ctx.state;
        return ctx.state === 'running';
      }

      async function load(url) {
        const cached = buffers.get(url);
        if (cached) return cached;
        const pending = (async () => {
          const response = await fetch(url, { cache: 'force-cache' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const ctx = ensureContext();
          if (!ctx) throw new Error('没有 AudioContext');
          return await ctx.decodeAudioData(bytes);
        })();
        buffers.set(url, pending);
        try {
          return await pending;
        } catch (error) {
          buffers.delete(url);
          throw error;
        }
      }

      function stopActive(fadeSeconds = 0.02) {
        if (!active) return;
        const current = active;
        active = null;
        try {
          if (fadeSeconds > 0 && context) {
            const now = context.currentTime;
            current.gain.gain.cancelScheduledValues(now);
            current.gain.gain.setValueAtTime(current.gain.gain.value, now);
            current.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
            current.source.stop(now + fadeSeconds);
          } else {
            current.source.stop();
          }
        } catch { /* 已经停了 */ }
      }

      /** 预热：拿到手势后先把常用音效解码好，第一次触发就没有延迟。 */
      async function warm(urls) {
        for (const url of urls) {
          try { await load(url); } catch { /* 单个失败不影响其他 */ }
        }
      }

      /** @returns {Promise<'played'|'busy'|'locked'|'failed'>} */
      async function play(url, priority, gainScale = 1) {
        const ctx = ensureContext();
        if (!ctx) return 'failed';
        if (ctx.state !== 'running' && !(await unlock())) return 'locked';
        if (active) {
          if (active.priority > priority) return 'busy';   // 低优先级不打断高优先级
          stopActive();
        }
        let buffer;
        try {
          buffer = await load(url);
        } catch (error) {
          note(`音效加载失败 ${url}：${error?.message || error}`);
          return 'failed';
        }
        // 解码是异步的，期间可能有更高优先级的音效抢占了。
        if (active && active.priority > priority) return 'busy';
        try {
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const gain = ctx.createGain();
          gain.gain.value = Math.min(1, Math.max(0, readVolume() * gainScale * Number(store.config?.packGain || 1)));
          source.connect(gain);
          gain.connect(master);
          const entry = { priority, source, gain };
          source.onended = () => { if (active === entry) active = null; };
          source.start();
          active = entry;
          return 'played';
        } catch (error) {
          note(`音效播放失败 ${url}：${error?.message || error}`);
          return 'failed';
        }
      }

      async function waitForIdle(maxWait = 60000) {
        if (!active) return 'idle';
        return new Promise((resolve) => {
          const startedAt = Date.now();
          const check = () => {
            if (!active) {
              resolve('idle');
              return;
            }
            if (Date.now() - startedAt >= maxWait) {
              resolve('timeout');
              return;
            }
            window.setTimeout(check, 50);
          };
          check();
        });
      }

      function dispose() {
        stopActive(0);
        buffers.clear();
        try { context?.close(); } catch { /* 已经关了 */ }
        context = null;
        master = null;
      }

      return { unlock, warm, play, waitForIdle, dispose };
    }

    // ============================================================ 事件引擎

    /** 触发器引擎：查表 → 按配置过滤 → 选文件（不连播）→ 优先级播放 → 记账。 */
    function createEngine(player) {
      const lastIndexByTrigger = new Map();
      const lastFiredAt = new Map();
      const triggerById = new Map();

      /* Browser autoplay policy keeps the AudioContext suspended until the page
       * has seen a gesture. A turn can finish before that, so remember the clip
       * and play it on the first gesture instead of losing it. */
      let pendingPlay = null;
      let pendingBound = false;
      function queuePendingPlay(url, priority) {
        pendingPlay = { url, priority };
        note('音频尚未解锁，已排队等待下一次点击/按键补播');
        if (pendingBound) return;
        pendingBound = true;
        const flush = () => {
          const job = pendingPlay;
          pendingPlay = null;
          if (!job) return;
          Promise.resolve()
            .then(() => player.unlock())
            .then(() => player.play(job.url, job.priority))
            .catch(() => {});
        };
        window.addEventListener('pointerdown', flush, { passive: true, capture: true });
        window.addEventListener('keydown', flush, { passive: true, capture: true });
      }

      function setManifest(manifest) {
        triggerById.clear();
        for (const trigger of manifest?.triggers || []) triggerById.set(trigger.id, trigger);
      }

      function pickFile(trigger) {
        const selected = store.config?.soundSelections?.[trigger.id];
        const files = (trigger.files || []).filter((file) => (
          !Array.isArray(selected) || selected.includes(file)
        ));
        if (files.length === 0) return null;
        if (files.length === 1) return files[0];
        const previous = lastIndexByTrigger.get(trigger.id);
        let index = 0;
        // 同类随机不连播：最多重试若干次，两条素材时不会死循环。
        for (let attempt = 0; attempt < 12; attempt += 1) {
          index = Math.floor(Math.random() * files.length);
          if (index !== previous) break;
        }
        lastIndexByTrigger.set(trigger.id, index);
        return files[index];
      }

      function urlFor(file) {
        return `${ENDPOINT}/sounds/${encodeURIComponent(file)}`;
      }

      async function fire(id, detail) {
        const trigger = triggerById.get(id);
        if (!trigger) return 'unknown';
        const config = store.config;
        const bypass = trigger.bypassMute === true;
        if (!bypass) {
          if (!config || config.enabled !== true) return 'disabled';
          if (config.muted === true) return 'muted';
          if (config.triggers && config.triggers[id] === false) return 'off';
        }

        const now = Date.now();
        const cooldown = Number(trigger.cooldownMs) || 0;
        if (cooldown > 0 && now - (lastFiredAt.get(id) || 0) < cooldown) {
          recordEvent(id, null, 'cooldown');
          return 'cooldown';
        }

        const file = pickFile(trigger);
        if (!file) return 'nofile';
        const available = store.manifest?.available;
        if (Array.isArray(available) && !available.includes(file)) {
          recordEvent(id, file, 'missing');
          return 'missing';
        }

        lastFiredAt.set(id, now);
        const priority = { low: 10, medium: 50, high: 100 }[trigger.priority] ?? 50;
        const result = await player.play(urlFor(file), priority);
        if (result === 'locked') {
          /* The page has not seen a user gesture yet, so the AudioContext is
           * still suspended. Replay this clip on the next gesture instead of
           * dropping it — otherwise a fresh reload looks like "nothing works". */
          queuePendingPlay(urlFor(file), priority);
        }
        recordEvent(id, file, result === 'played' ? null : result);
        return result;
      }

      async function preview(id, file) {
        const trigger = triggerById.get(id);
        if (!trigger || !trigger.files?.includes(file)) return 'unknown';
        const available = store.manifest?.available;
        if (Array.isArray(available) && !available.includes(file)) {
          recordEvent(id, file, 'missing');
          return 'missing';
        }
        const priority = { low: 10, medium: 50, high: 100 }[trigger.priority] ?? 50;
        const result = await player.play(urlFor(file), priority);
        if (result === 'locked') queuePendingPlay(urlFor(file), priority);
        recordEvent(id, file, result === 'played' ? null : result);
        return result;
      }

      return { setManifest, fire, preview, urlFor };
    }

    const player = createPlayer();
    const engine = createEngine(player);

    // ============================================================ 自动汇报播放

    /**
     * 回合结束后请求本机代理合成，再把 WAV 交给同一个播放器。
     * reportRevision 防止上一轮较慢的合成在下一轮开始后才播出来。
     */
    function createReporter(audioPlayer) {
      let revision = 0;
      let pendingUrl = null;
      let pendingBound = false;

      function update(patch) {
        Object.assign(diagnostics.report, patch);
        publish();
      }

      function enabled() {
        const config = store.config;
        return config?.autoReport === true && config?.muted !== true;
      }

      function revoke(url) {
        if (!url) return;
        try { URL.revokeObjectURL(url); } catch { /* 测试环境或旧浏览器 */ }
      }

      function queueLockedUrl(url) {
        if (pendingUrl && pendingUrl !== url) revoke(pendingUrl);
        pendingUrl = url;
        if (pendingBound) return;
        pendingBound = true;
        const flush = () => {
          const job = pendingUrl;
          pendingUrl = null;
          if (!job) return;
          Promise.resolve()
            .then(() => audioPlayer.unlock())
            .then(() => audioPlayer.play(job, REPORT_PRIORITY))
            .then((result) => {
              update({ state: result === 'played' ? 'played' : 'failed', at: Date.now() });
            })
            .catch((error) => update({ state: 'failed', error: String(error?.message || error), at: Date.now() }))
            .finally(() => revoke(job));
        };
        window.addEventListener('pointerdown', flush, { passive: true, capture: true });
        window.addEventListener('keydown', flush, { passive: true, capture: true });
      }

      async function speak(text, token, style = 'warm', speedOverride = null) {
        const config = store.config || {};
        const voice = config?.tts?.voice || 'Fairy';
        const requestedSpeed = Number(speedOverride);
        const speed = speedOverride != null && Number.isFinite(requestedSpeed)
          ? requestedSpeed
          : Number(config?.tts?.speed) || 1;
        update({ state: 'synthesizing', voice, chars: text.length, error: null, at: Date.now() });

        let objectUrl = '';
        try {
          const response = await fetch(`${ENDPOINT}/tts-speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, speed, style }),
          });
          if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
              const payload = await response.json();
              if (payload?.error) detail = String(payload.error);
            } catch { /* 响应不一定是 JSON */ }
            throw new Error(detail);
          }
          const blob = await response.blob();
          if (!blob?.size) throw new Error('TTS 返回了空音频');
          if (token !== revision) return 'superseded';
          objectUrl = URL.createObjectURL(blob);
          const result = await audioPlayer.play(objectUrl, REPORT_PRIORITY);
          if (token !== revision) {
            revoke(objectUrl);
            return 'superseded';
          }
          if (result === 'locked') {
            queueLockedUrl(objectUrl);
            objectUrl = '';
            update({ state: 'queued', voice, chars: text.length, error: null, at: Date.now() });
            return 'queued';
          }
          if (result !== 'played') throw new Error(`播放未完成：${result}`);
          update({ state: 'played', voice, chars: text.length, error: null, at: Date.now() });
          return 'played';
        } catch (error) {
          const message = String(error?.message || error);
          update({ state: 'failed', voice, chars: text.length, error: message, at: Date.now() });
          note(`自动语音汇报失败：${message}`);
          return 'failed';
        } finally {
          revoke(objectUrl);
        }
      }

      async function report(turn, reason) {
        if (!enabled()) return 'disabled';
        const token = ++revision;
        update({ state: 'collecting', voice: store.config?.tts?.voice || 'Fairy', chars: 0, error: null, at: Date.now() });
        const answer = reason === 'completed'
          ? await waitForFinalAnswer(turn)
          : '';
        if (token !== revision) return 'superseded';
        const text = buildTurnReport(answer, reason);
        return speak(text, token, 'intro');
      }

      async function preview() {
        if (store.config?.muted === true) return 'muted';
        const token = ++revision;
        return speak('主人，我是 Fairy。语音已经准备好了，接下来会由我向你汇报每个回合的结果。', token, 'intro');
      }

      async function previewStartup(text, greetingEnabled, greetingPauseMs) {
        if (store.config?.muted === true) return 'muted';
        await audioPlayer.unlock();
        const token = ++revision;
        let lastResult = 'disabled';
        for (const part of splitStartupSpeech(text || STARTUP_PRESET_TEXT.full)) {
          if (part.pauseBeforeMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, part.pauseBeforeMs));
            if (token !== revision) return 'superseded';
          }
          lastResult = await speak(part.text, token, 'intro', part.speed);
          if (lastResult !== 'played' || token !== revision) return lastResult;
          const playbackResult = await audioPlayer.waitForIdle();
          if (playbackResult !== 'idle' || token !== revision) return playbackResult;
        }
        if (greetingEnabled !== true) return lastResult;
        await new Promise((resolve) => window.setTimeout(
          resolve,
          Math.min(5000, Math.max(0, Number(greetingPauseMs) || 0)),
        ));
        if (token !== revision) return 'superseded';
        return speak(currentGreetingText(), token, 'intro');
      }

      function cancel() {
        revision += 1;
        if (pendingUrl) {
          revoke(pendingUrl);
          pendingUrl = null;
        }
        if (['collecting', 'synthesizing', 'queued'].includes(diagnostics.report.state)) {
          update({ state: 'cancelled', error: null, at: Date.now() });
        }
      }

      return { enabled, report, preview, previewStartup, cancel };
    }

    const reporter = createReporter(player);

    // ============================================================ 配置同步

    async function loadManifest() {
      try {
        const response = await fetch(`${ENDPOINT}/manifest`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        store.manifest = manifest;
        store.config = manifest.config;
        store.ready = true;
        store.error = null;
        engine.setManifest(manifest);
        publish();
        return manifest;
      } catch (error) {
        store.error = String(error?.message || error);
        store.ready = false;
        publish();
        return null;
      }
    }

    let configWriteTimer = null;
    let pendingConfigPatch = null;
    let localRevision = 0;

    function mergeConfigPatch(current, patch) {
      return {
        ...(current || {}),
        ...(patch || {}),
        triggers: { ...(current?.triggers || {}), ...(patch?.triggers || {}) },
        soundSelections: {
          ...(current?.soundSelections || {}),
          ...(patch?.soundSelections || {}),
        },
        startupVoice: { ...(current?.startupVoice || {}), ...(patch?.startupVoice || {}) },
        tts: { ...(current?.tts || {}), ...(patch?.tts || {}) },
      };
    }

    /** 乐观更新：界面立刻响应，落盘串行化。 */
    function patchConfig(patch) {
      localRevision += 1;
      const revision = localRevision;
      store.config = mergeConfigPatch(store.config, patch);
      pendingConfigPatch = mergeConfigPatch(pendingConfigPatch, patch);
      publish();
      clearTimeout(configWriteTimer);
      configWriteTimer = setTimeout(async () => {
        const body = pendingConfigPatch;
        pendingConfigPatch = null;
        try {
          const response = await fetch(`${ENDPOINT}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json();
          // 响应回来时如果本地又改过，就别用这份旧结果覆盖界面。
          if (revision !== localRevision) return;
          store.config = value.config;
          store.error = null;
          publish();
        } catch (error) {
          store.error = `配置保存失败：${error?.message || error}`;
          publish();
        }
      }, 220);
    }

    // ============================================================ 错误分类

    const NETWORK_PATTERN = /network|fetch|econn|etimedout|socket|offline|dns|tls|timeout|abort.*connect|502|503|504/i;

    /** 从结构化失败里区分网络错误与一般错误。只读字段，不依赖界面文案。 */
    function classifyFailure(...candidates) {
      const haystack = candidates
        .flatMap((value) => (value == null ? [] : [value]))
        .map((value) => {
          if (typeof value === 'string') return value;
          if (typeof value !== 'object') return String(value);
          return [value.code, value.kind, value.name, value.message, value.reason].filter(Boolean).join(' ');
        })
        .join(' ');
      return NETWORK_PATTERN.test(haystack) ? 'network-error' : 'error';
    }

    // ============================================================ 事件检测

    /**
     * 检测器：把宿主的事件流翻译成触发器 id。
     *
     * 每个订阅各自 try/catch —— 任何一个信号源换版式失效，其余照常工作，
     * 插件不会因此整个哑掉。
     */
    function createDetectors(ctx) {
      const disposers = [];
      let sessionUnsubscribe = null;
      let sessionBoundId = null;
      let observedModelSelection = false;
      let lastCurrent = null;
      let lastBindingInfo = null;

      function add(dispose) {
        if (typeof dispose === 'function') disposers.push(dispose);
      }

      function fire(id, detail) {
        void engine.fire(id, detail).catch((error) => note(`触发 ${id} 失败：${error?.message || error}`));
      }

      /** 自动汇报开启时由 Fairy 朗读；合成或播放失败再回落到事件提示音。 */
      function finishTurn(triggerId, data, reportReason) {
        if (!reporter.enabled()) {
          fire(triggerId, data);
          return;
        }
        void reporter.report(data.turn, reportReason)
          .then((result) => {
            if (result === 'failed' || result === 'disabled') fire(triggerId, data);
          })
          .catch((error) => {
            note(`回合语音汇报异常：${error?.message || error}`);
            fire(triggerId, data);
          });
      }

      // ---------------------------------------------------------- 会话切换

      /** 把事件窗口订到指定会话上；换会话必须重建，否则窗口停留在旧会话。 */
      function bindSession(sessions, sessionId) {
        if (sessionBoundId === sessionId) return;
        sessionBoundId = sessionId;
        observedModelSelection = false;
        if (sessionUnsubscribe) { try { sessionUnsubscribe(); } catch { /* 忽略 */ } sessionUnsubscribe = null; }
        if (!sessionId) {
          mark('会话事件窗口', '无当前会话');
          try { console.error('DSH_FAIRY_BIND ' + JSON.stringify({ sessionId: null })); } catch { /* 忽略 */ }
          return;
        }

        let binding;
        try {
          binding = sessions.binding?.(sessionId);
        } catch (error) {
          mark('会话事件窗口', `绑定失败：${error?.message || error}`);
          return;
        }
        try {
          console.error('DSH_FAIRY_BIND ' + JSON.stringify({
            sessionId: String(sessionId).slice(0, 8),
            hasBindingMethod: typeof sessions.binding === 'function',
            hasBinding: Boolean(binding),
            hasEventSource: Boolean(binding?.eventSource),
            bindingKeys: binding ? Object.keys(binding).slice(0, 8) : null,
          }));
        } catch { /* 忽略 */ }
        lastBindingInfo = {
          sessionId: String(sessionId).slice(0, 8),
          hasBindingMethod: typeof sessions.binding === 'function',
          hasBinding: Boolean(binding),
          hasEventSource: Boolean(binding?.eventSource),
        };
        if (!binding?.eventSource) { mark('会话事件窗口', '该会话没有事件窗口'); return; }

        const handle = (window) => {
          // 只认 append：replace/prepend 是历史加载，不该当成刚发生的事。
          if (window?.change?.kind !== 'append') return;
          for (const entry of window.change.entries || []) {
            if (entry?.type !== 'event') continue;
            const event = entry.event;
            try {
              routeEvent(event);
            } catch (error) {
              note(`处理事件 ${event?.type} 失败：${error?.message || error}`);
            }
          }
        };

        try {
          sessionUnsubscribe = binding.eventSource.subscribe(() => {
            try { handle(binding.eventSource.getSnapshot()); } catch (error) {
              note(`读取事件窗口失败：${error?.message || error}`);
            }
          });
          mark('会话事件窗口', String(sessionId).slice(0, 8));
        } catch (error) {
          mark('会话事件窗口', `订阅失败：${error?.message || error}`);
        }

        // 上下文占用：同一 binding 上的投影面，同样只在换会话时重建。
        try {
          const face = binding.session?.projections?.faceOf?.('contextPressure');
          if (face?.subscribe) {
            let armed = true;
            const read = () => {
              try {
                const pressure = face.getSnapshot();
                const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
                const total = pressure?.contextWindow;
                if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return;
                const ratio = used / total;
                const threshold = Number(store.config?.contextWarningRatio) || 0.8;
                if (ratio >= threshold) {
                  if (armed) { armed = false; fire('context-warning', { percent: Math.round(ratio * 100) }); }
                } else if (ratio < threshold - 0.05) {
                  armed = true;   // 压缩后回落到阈值以下才重新武装
                }
              } catch (error) {
                note(`读取上下文占用失败：${error?.message || error}`);
              }
            };
            add(face.subscribe(read));
            read();
            mark('上下文占用', '已订阅');
          } else {
            mark('上下文占用', '该宿主没有 contextPressure 投影');
          }
        } catch (error) {
          mark('上下文占用', `订阅失败：${error?.message || error}`);
        }
      }

      /** 会话事件 → 触发器。这里是终局互斥的唯一裁决点。 */
      function routeEvent(event) {
        const type = String(event?.type || '');
        const data = event?.data || {};
        switch (type) {
          case 'turn/start':
            reporter.cancel();
            fire('task-start', { turn: data.turn });
            return;
          case 'turn/end': {
            const reason = data.reason || {};
            switch (reason.kind) {
              case 'completed': finishTurn('success', { turn: data.turn }, 'completed'); return;
              case 'aborted':
                // 只对「人工停止」出声；父级/钩子/销毁导致的中断不打扰。
                if (!reason.reason || reason.reason.kind === 'user') {
                  finishTurn('aborted', { turn: data.turn }, 'aborted');
                }
                return;
              case 'error': {
                const failure = classifyFailure(reason.error);
                finishTurn(failure, { turn: data.turn }, failure);
                return;
              }
              case 'max-tokens':
                finishTurn('error', { turn: data.turn, reason: 'max-tokens' }, 'max-tokens');
                return;
              default:
                return;   // blocked / interrupted / 未来新增的 reason 一律不响
            }
          }
          case 'llm/retry':
            fire('retry', { provider: data.provider, attempt: data.retry });
            return;
          case 'compaction/start':
            // 带 sourceCommandId 或 turn 为空的，是 /compact 这类手工事务。
            fire(data.sourceCommandId != null || data.turn == null ? 'compact-manual' : 'compact-auto', { turn: data.turn });
            return;
          case 'compaction/summary':
            fire('compact-success', {});
            return;
          case 'compaction/end':
            fire(data.error ? 'compaction-failed' : 'compact-success', { error: data.error || null });
            return;
          case 'model/selection':
            // 打开会话时历史走 replace 不经过这里，所以首帧是真实基线。
            if (!observedModelSelection) { observedModelSelection = true; return; }
            fire('model-switch', {});
            return;
          default:
        }
      }

      function start() {
        // ---- 会话列表：welcome / session-switch / new-session
        ctx.inject(['sessions', 'uiSession'], (sctx) => {
          const sessions = sctx.sessions;
          if (!sessions?.list?.subscribe) { mark('会话列表', '宿主没有 sessions.list'); return; }
          /* DSH 0.2.x no longer carries `current` on the session-list snapshot:
           * the selected session lives in `uiSession.adapter.current`, whose
           * snapshot has `.key`. Fall back through both so the event window can
           * bind on any host generation. */
          const currentSource = sctx.uiSession?.adapter?.current;
          const readCurrent = (state) => {
            if (state && state.current) return state.current;
            try {
              const snapshot = currentSource?.getSnapshot?.();
              return snapshot?.key ?? snapshot?.sessionId ?? null;
            } catch {
              return null;
            }
          };
          const sync = () => {
            let state;
            try { state = sessions.list.getSnapshot(); } catch { return; }
            const current = readCurrent(state);
            const previous = lastCurrent;
            lastCurrent = current;
            bindSession(sessions, current);
            if (current === previous) return;

            if (current && !previous) { fire('welcome', { sessionId: current }); return; }
            if (current && previous) {
              const blank = state?.byId?.[current]?.blank === true;
              fire(blank ? 'new-session' : 'session-switch', { from: previous, to: current });
              return;
            }
            if (!current && previous) fire('goodbye', { from: previous });
          };
          add(sessions.list.subscribe(sync));
          if (currentSource?.subscribe) add(currentSource.subscribe(sync));
          sync();
          mark('会话列表', '已订阅');
        });

        // ---- 权限请求：只旁听，绝不接管瀑布流
        ctx.inject(['remote'], (rctx) => {
          const remote = rctx.remote;
          if (!remote?.$on) { mark('远程事件', '宿主没有 remote.$on'); return; }

          /* remote.$on 的返回值不保证是卸载函数，所以自己拿一个开关兜底。
           *
           * 两个坑：
           *   1. 各事件的参数个数不一样（api-session/error 是 (sessionId, message)），
           *      只转发第一个参数会把关键信息吞掉 —— 必须全量转发。
           *   2. approval/request 的最后一个参数是瀑布流的 next()，必须**无条件**调用；
           *      少调一次，官方的授权界面就不出来了，插件会把人挡在门外。 */
          const listen = (name, listener) => {
            let live = true;
            const wrapped = (...args) => {
              let delegate = null;
              if (typeof args[args.length - 1] === 'function') delegate = args.pop();
              if (live) {
                try { listener(...args); } catch (error) {
                  note(`${name} 处理失败：${error?.message || error}`);
                }
              }
              return delegate ? delegate() : undefined;
            };
            const result = remote.$on(name, wrapped);
            return typeof result === 'function' ? result : () => { live = false; };
          };

          /* 注意：这个 approval/request 监听器在**正常路径上不会被调用** ——
           * 官方的 dsh-client-ui-approval 先注册，它接管后不会调用 next()，
           * 瀑布流到不了这里。留着他只是为了「没有授权界面」的宿主兜底。
           * 真正的主信号是下面的 uiSession.pendingInteractions。 */
          add(listen('approval/request', (request) => {
            fire('permission', { source: 'waterfall', tool: request?.toolName });
          }));
          add(listen('api-session/removed', (sessionId) => fire('goodbye', { sessionId })));
          add(listen('api-session/error', (sessionId, message) => fire(classifyFailure(message), { sessionId })));
          mark('远程事件', '已订阅 approval/request + api-session/*');
        });

        /* ---- 权限请求与决策：真信号源。
         *
         * 官方授权插件把 PendingApproval 注册进会话层的待处理交互表，表里存的是
         * **完整对象**，带：
         *   kind      'approval'（还有 question / plan-review 等其它阻塞式弹窗）
         *   key       'approval:N'，可用来去重
         *   toolName  请求授权的工具
         *   result    promise —— 用户点完 resolve 成 'allowed-once' / 'rejected'
         *
         * 所以请求和决策都能拿到，且不碰瀑布流、不读 DOM、不受界面语言影响。
         * result 被 reject 表示「委托给了下一个监听器」或「请求被取消」——那不出声。 */
        ctx.inject(['uiSession'], (sctx) => {
          const direct = sctx.uiSession?.pendingInteractions;
          const statusSource = sctx.uiSession?.sessionStatus;
          /* DSH 0.2.x publishes a per-session status map whose entries carry
           * `pendingInteraction`, and no longer exposes a dedicated
           * pending-interactions map. Adapt that source to the observable shape
           * the rest of this detector expects. */
          const pending = direct?.subscribe && direct?.getSnapshot
            ? direct
            : statusSource?.subscribe && statusSource?.getSnapshot
              ? {
                subscribe: (listener) => statusSource.subscribe(listener),
                getSnapshot: () => {
                  const map = new Map();
                  let snapshot;
                  try { snapshot = statusSource.getSnapshot(); } catch { return map; }
                  if (!snapshot || typeof snapshot.forEach !== 'function') return map;
                  snapshot.forEach((value, sessionId) => {
                    const interaction = value && value.pendingInteraction;
                    if (interaction) map.set(sessionId, interaction);
                  });
                  return map;
                },
              }
              : null;
          if (!pending) {
            mark('待处理交互', '宿主没有待处理交互接口');
            return;
          }
          const watched = new Set();
          const sync = () => {
            let map;
            try { map = pending.getSnapshot(); } catch { return; }
            if (!map || typeof map.forEach !== 'function') return;
            const live = new Set();
            map.forEach((interaction) => {
              const key = String(interaction?.key ?? '');
              if (key === '') return;
              live.add(key);
              if (watched.has(key)) return;
              watched.add(key);

              fire('permission', { kind: interaction.kind, tool: interaction.toolName });

              const result = interaction.result;
              if (result && typeof result.then === 'function') {
                result.then(
                  (decision) => {
                    if (decision === 'allowed-once' || decision === 'allowed') fire('permission-approved', { decision });
                    else if (decision === 'rejected' || decision === 'denied') fire('permission-denied', { decision });
                    else note(`权限决策是未预期的取值：${String(decision)}`);
                  },
                  () => { /* 被委托给别的监听器，或请求被取消 —— 不该假装成拒绝 */ },
                );
              }
            });
            // 已经消失的交互从去重表里清掉，同一个 key 复用时还能再响。
            for (const key of [...watched]) if (!live.has(key)) watched.delete(key);
          };
          add(pending.subscribe(sync));
          sync();
          mark('待处理交互', '已订阅');
        });

        // ---- 连接：掉线即网络错误
        ctx.inject(['connection'], (cctx) => {
          const connection = cctx.connection;
          const generation = connection?.generation;
          if (!generation?.subscribe) { mark('连接状态', '宿主没有 connection.generation'); return; }
          let wasConnected = true;
          try { wasConnected = generation.getSnapshot() !== undefined; } catch { /* 当作已连 */ }
          add(generation.subscribe(() => {
            let connected = true;
            try { connected = generation.getSnapshot() !== undefined; } catch { return; }
            if (wasConnected && !connected) fire('network-error', { source: 'connection' });
            wasConnected = connected;
          }));
          mark('连接状态', '已订阅');
        });

        // ---- 离开页面：浏览器能给的最好信号（可能来不及播完）
        const onLeave = () => { void engine.fire('goodbye', {}).catch(() => {}); };
        window.addEventListener('pagehide', onLeave);
        add(() => window.removeEventListener('pagehide', onLeave));

        // ---- 余额：桌面壳的桥 + 官方余额挂件广播的事件
        const BALANCE_KEYS = ['total', 'totalBalance', 'available', 'balance'];
        let lastQuotaHit = 0;
        const inspectBalance = (detail) => {
          const balances = detail?.balances;
          if (!Array.isArray(balances) || balances.length === 0) return;
          const primary = balances.find((item) => item?.currency === 'CNY') || balances[0];
          const value = BALANCE_KEYS.map((key) => Number(primary?.[key])).find((candidate) => Number.isFinite(candidate));
          const limit = Number(store.config?.quotaWarningAmount) || 0;
          if (!Number.isFinite(value) || limit <= 0 || value > limit) return;
          if (Date.now() - lastQuotaHit < 300_000) return;   // 同一周期不重复打扰
          lastQuotaHit = Date.now();
          fire('quota-warning', { value, limit });
        };
        let balanceSignalSeen = false;
        const onBalanceEvent = (event) => {
          if (!balanceSignalSeen) {
            balanceSignalSeen = true;
            /* This host has no desktop bridge, but the balance widget (or a
             * compatible broadcaster) feeds the same window event, so the
             * trigger is live even though the startup label said otherwise. */
            mark('余额', '已收到 dsh-balance-changed');
          }
          inspectBalance(event?.detail);
        };
        window.addEventListener('dsh-balance-changed', onBalanceEvent);
        add(() => window.removeEventListener('dsh-balance-changed', onBalanceEvent));

        const bridge = window.dshDesktop;
        if (bridge && typeof bridge.refreshBalance === 'function') {
          const poll = () => {
            Promise.resolve()
              .then(() => bridge.refreshBalance())
              .then((detail) => { mark('余额', '桌面桥可用'); inspectBalance(detail); })
              .catch(() => mark('余额', '桌面桥读取失败'));
          };
          poll();
          const timer = setInterval(poll, 600_000);
          add(() => clearInterval(timer));
        } else {
          mark('余额', '没有 dshDesktop 桥，只能等 dsh-balance-changed 事件');
          /* This host has no bridge, but it does serve the balance meter on a
           * same-origin route. Poll it once shortly after boot (and then on a
           * slow interval) so the quota trigger works without depending on the
           * broadcaster's timing. */
          const readMeter = () => {
            if (typeof fetch !== 'function') return;
            fetch('/balance-meter', { headers: { accept: 'application/json' } })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error('meter-' + response.status))))
              .then((payload) => {
                const info = payload && payload.balance;
                if (!info || info.is_available === false) return;
                const rows = Array.isArray(info.balance_infos) ? info.balance_infos : [];
                const primary = rows.find((row) => row && row.currency === 'CNY') || rows[0];
                if (!primary) return;
                const total = Number(primary.total_balance);
                if (!Number.isFinite(total)) return;
                mark('余额', '已订阅 /balance-meter');
                inspectBalance({ balances: [{ currency: primary.currency || 'CNY', total, total_balance: total }] });
              })
              .catch(() => { /* keep the explanatory label; the event path may still fire */ });
          };
          const meterTimer = setTimeout(readMeter, 1200);
          const meterInterval = setInterval(readMeter, 600_000);
          add(() => { clearTimeout(meterTimer); clearInterval(meterInterval); });
        }

        // ---- 久坐提醒：宿主没有这个信号，自己起表
        let activityTimer = null;
        const armActivity = () => {
          const minutes = Math.max(1, Number(store.config?.activityMinutes) || 60);
          if (activityTimer && activityTimer.fairyVoiceMinutes === minutes) return;
          if (activityTimer) clearInterval(activityTimer);
          const timer = setInterval(() => fire('activity', { minutes }), minutes * 60_000);
          timer.fairyVoiceMinutes = minutes;
          activityTimer = timer;
        };
        armActivity();
        add(subscribeStore(armActivity));   // 设置面板改了间隔就重挂
        add(() => { if (activityTimer) clearInterval(activityTimer); });

        /* 排查用：启动 3 秒后把检测器的真实状态写进宿主日志（此时渲染进程的
         * console 转发一定已就绪），比在界面上逐行看图快得多。 */
        setTimeout(() => {
          try {
            console.error('DSH_FAIRY_STATE ' + JSON.stringify({
              ready: store.ready === true,
              error: store.error || null,
              manifestTriggers: Array.isArray(store.manifest?.triggers)
                ? store.manifest.triggers.length
                : typeof store.manifest?.triggers,
              available: Array.isArray(store.manifest?.available) ? store.manifest.available.length : null,
              current: lastCurrent ? String(lastCurrent).slice(0, 8) : null,
              binding: lastBindingInfo,
              configEnabled: store.config?.enabled === true,
              recent: diagnostics.events.slice(0, 3),
            }));
          } catch { /* 忽略 */ }
        }, 3000);
      }

      function stop() {
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch { /* 卸载期忽略 */ }
        }
        if (sessionUnsubscribe) { try { sessionUnsubscribe(); } catch { /* 忽略 */ } sessionUnsubscribe = null; }
        sessionBoundId = null;
      }

      return { start, stop };
    }

    let detectors = null;

    // ============================================================ 输入栏控件

    function ComposerControl() {
      const snapshot = React.useSyncExternalStore(subscribeStore, readSnapshot, readSnapshot);
      const config = snapshot.config;
      const enabled = config?.enabled === true;
      const volume = Number(config?.volume ?? 0.8);

      /* 注意：**不要**从 event.target.checked 取值。
       * React 的受控 checkbox 在事件处理返回后会立刻把 DOM 重置回受控值，
       * 所以只要处理函数里出现过 await，读到的就是被重置后的旧值 —— 表现是
       * 开关怎么点都开不起来（本插件 0.1.1 就栽在这里）。从受控值推下一个状态，
       * 与 DOM 时序无关。 */
      const setEnabled = (next) => {
        patchConfig({ enabled: next, muted: false });
        // 开关确认音无视静音：否则你没法确认按下去生效了。
        void engine.fire(next ? 'voice-on' : 'voice-off', {});
        if (next) {
          // 解锁与预热都是后台动作，不参与状态变更。
          void player.unlock().then(() => player.warm(
            ['welcome-1.wav', 'task-start-1.wav', 'success-1.wav', 'error.wav'].map((file) => engine.urlFor(file)),
          ));
        }
      };

      const label = !snapshot.ready
        ? (snapshot.error ? `音效服务不可用：${snapshot.error}` : '正在读取音效清单…')
        : enabled ? '关闭音效' : '开启音效';

      return jsx.jsxs('span', {
        className: 'dsh-fairy-voice-controls',
        role: 'group',
        'aria-label': 'Fairy 语音',
        [CONTROL_ATTRIBUTE]: 'true',
        children: [
          jsx.jsx(Tooltip, {
            label,
            children: jsx.jsx('button', {
              type: 'button',
              className: 'dsh-fairy-voice-toggle',
              'data-fairy-voice-toggle': 'true',
              'data-on': enabled ? 'true' : 'false',
              'aria-label': label,
              'aria-pressed': enabled,
              disabled: !snapshot.ready,
              onClick: () => setEnabled(!enabled),
              children: jsx.jsx('span', { className: 'dsh-fairy-voice-dot', 'aria-hidden': 'true' }),
            }),
          }),
          jsx.jsx(Tooltip, {
            label: `语音音量 ${Math.round(volume * 100)}%`,
            children: jsx.jsx('input', {
              className: 'dsh-fairy-voice-volume',
              'data-fairy-voice-volume': 'true',
              type: 'range', min: '0', max: '1', step: '0.05', value: volume,
              disabled: !snapshot.ready,
              'aria-label': '语音音量',
              onChange: (event) => patchConfig({ volume: Number(event.target.value) }),
              style: { '--dsh-fairy-voice-volume': `${Math.round(volume * 100)}%` },
            }),
          }),
        ],
      });
    }

    // ============================================================ 设置面板

    function StatusRow({ label, value, level }) {
      return jsx.jsxs('div', {
        className: 'dsh-fairy-voice-row',
        'data-fairy-voice-row': label,
        children: [
          jsx.jsx('span', { className: 'dsh-fairy-voice-row-label', children: label }),
          jsx.jsx('span', { className: 'dsh-fairy-voice-row-value', 'data-level': level || 'info', children: value }),
        ],
      });
    }

    function TriggerRow({ trigger, config, onToggle }) {
      const on = config?.triggers?.[trigger.id] !== false;
      const configuredFiles = config?.soundSelections?.[trigger.id];
      const selectedFiles = Array.isArray(configuredFiles)
        ? trigger.files.filter((file) => configuredFiles.includes(file))
        : trigger.files;
      const [expanded, setExpanded] = React.useState(false);
      const expandable = trigger.files.length > 1;

      const selectFiles = (files) => {
        patchConfig({ soundSelections: { [trigger.id]: files } });
      };

      const toggleFile = (file, checked) => {
        selectFiles(checked
          ? [...new Set([...selectedFiles, file])]
          : selectedFiles.filter((selected) => selected !== file));
      };

      return jsx.jsxs('div', {
        className: 'dsh-fairy-voice-trigger',
        'data-fairy-voice-trigger': trigger.id,
        'data-expanded': expanded ? 'true' : 'false',
        children: [
          jsx.jsxs('div', {
            className: 'dsh-fairy-voice-trigger-header',
            children: [
              expandable ? jsx.jsx('button', {
                type: 'button',
                className: 'dsh-fairy-voice-trigger-expand',
                title: expanded ? '收起声音列表' : '展开声音列表',
                'aria-label': `${expanded ? '收起' : '展开'} ${trigger.label} 声音列表`,
                'aria-expanded': expanded,
                'aria-controls': `dsh-fairy-voice-files-${trigger.id}`,
                'data-fairy-voice-trigger-expand': trigger.id,
                onClick: () => setExpanded((value) => !value),
                children: expanded ? '▾' : '▸',
              }) : jsx.jsx('span', {
                className: 'dsh-fairy-voice-trigger-expand-spacer',
                'aria-hidden': true,
              }),
              jsx.jsx('button', {
                type: 'button',
                className: 'dsh-fairy-voice-trigger-play',
                title: selectedFiles.length > 0 ? '从已选语音中随机试听' : '请先选择至少一段语音',
                'aria-label': `试听 ${trigger.label}`,
                disabled: selectedFiles.length === 0,
                onClick: () => { void player.unlock().then(() => engine.fire(trigger.id, { manual: true })); },
                children: '▶',
              }),
              jsx.jsx('label', {
                className: 'dsh-fairy-voice-trigger-label',
                title: trigger.note || '',
                children: [
                  jsx.jsx('input', {
                    type: 'checkbox', checked: on,
                    'data-fairy-voice-trigger-toggle': trigger.id,
                    onChange: (event) => onToggle(trigger.id, event.target.checked),
                  }),
                  jsx.jsx('span', { children: trigger.label }),
                  trigger.priority === 'high' ? jsx.jsx('em', { className: 'dsh-fairy-voice-tag', children: '可抢占' }) : null,
                  trigger.bypassMute ? jsx.jsx('em', { className: 'dsh-fairy-voice-tag', children: '无视静音' }) : null,
                ],
              }),
              jsx.jsx('span', {
                className: 'dsh-fairy-voice-trigger-files',
                'data-empty': selectedFiles.length === 0 ? 'true' : 'false',
                children: `${selectedFiles.length} / ${trigger.files.length} 段`,
              }),
            ],
          }),
          expanded && expandable ? jsx.jsxs('div', {
            className: 'dsh-fairy-voice-trigger-details',
            id: `dsh-fairy-voice-files-${trigger.id}`,
            children: [
              jsx.jsxs('div', {
                className: 'dsh-fairy-voice-selection-head',
                children: [
                  jsx.jsx('span', { children: '选择参与随机播放的语音' }),
                  jsx.jsxs('div', {
                    className: 'dsh-fairy-voice-selection-actions',
                    children: [
                      jsx.jsx('button', {
                        type: 'button',
                        onClick: () => selectFiles([...trigger.files]),
                        children: '全选',
                      }),
                      jsx.jsx('button', {
                        type: 'button',
                        onClick: () => selectFiles([]),
                        children: '全不选',
                      }),
                    ],
                  }),
                ],
              }),
              ...trigger.files.map((file, index) => jsx.jsxs('div', {
                className: 'dsh-fairy-voice-trigger-file',
                key: file,
                children: [
                  jsx.jsxs('label', {
                    className: 'dsh-fairy-voice-trigger-file-label',
                    children: [
                      jsx.jsx('input', {
                        type: 'checkbox',
                        checked: selectedFiles.includes(file),
                        'data-fairy-voice-file-toggle': `${trigger.id}:${file}`,
                        onChange: (event) => toggleFile(file, event.target.checked),
                      }),
                      jsx.jsx('span', { className: 'dsh-fairy-voice-trigger-file-index', children: `语音 ${index + 1}` }),
                      jsx.jsx('span', { className: 'dsh-fairy-voice-trigger-file-name', children: file }),
                    ],
                  }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'dsh-fairy-voice-trigger-file-play',
                    'data-fairy-voice-file-preview': `${trigger.id}:${file}`,
                    title: `试听 ${file}`,
                    'aria-label': `试听 ${trigger.label} 语音 ${index + 1}`,
                    onClick: () => { void player.unlock().then(() => engine.preview(trigger.id, file)); },
                    children: '试听',
                  }),
                ],
              }, file)),
              selectedFiles.length === 0 ? jsx.jsx('div', {
                className: 'dsh-fairy-voice-selection-empty',
                children: '未选择任何语音，此事件不会播放。',
              }) : null,
            ],
          }) : null,
        ],
      });
    }

    function FairyVoiceSettings() {
      const snapshot = React.useSyncExternalStore(subscribeStore, readSnapshot, readSnapshot);
      const manifest = snapshot.manifest;
      const config = snapshot.config;
      const [showDiag, setShowDiag] = React.useState(false);

      React.useEffect(() => { void loadManifest(); }, []);

      const groups = React.useMemo(() => {
        const map = new Map();
        for (const trigger of manifest?.triggers || []) {
          if (!map.has(trigger.group)) map.set(trigger.group, []);
          map.get(trigger.group).push(trigger);
        }
        return [...map.entries()];
      }, [manifest]);

      const expectedCount = React.useMemo(() => {
        const set = new Set();
        for (const trigger of manifest?.triggers || []) for (const file of trigger.files) set.add(file);
        return set.size;
      }, [manifest]);

      const soundCount = Array.isArray(manifest?.available) ? manifest.available.length : 0;
      const enabled = config?.enabled === true;
      const volume = Number(config?.volume ?? 0.8);
      const autoReport = config?.autoReport === true;
      const startupEnabled = config?.startupVoice?.enabled !== false;
      const startupPreset = ['full', 'short', 'custom'].includes(config?.startupVoice?.preset)
        ? config.startupVoice.preset
        : 'full';
      const startupCustomText = config?.startupVoice?.customText || '';
      const startupGreetingEnabled = config?.startupVoice?.greetingEnabled !== false;
      const startupGreetingPauseMs = Number(config?.startupVoice?.greetingPauseMs ?? 1500);
      const ttsVoice = config?.tts?.voice || 'Fairy';
      const ttsSpeed = Number(config?.tts?.speed ?? 1);
      const ttsVoices = Array.isArray(manifest?.ttsVoices) && manifest.ttsVoices.length > 0
        ? manifest.ttsVoices
        : ['Fairy'];
      const reportState = diagnostics.report.error
        ? `失败：${diagnostics.report.error}`
        : {
          idle: '尚未播报',
          collecting: '正在读取回复…',
          synthesizing: '正在合成…',
          queued: '等待音频解锁',
          played: '已播报',
          cancelled: '已取消',
          failed: '失败',
        }[diagnostics.report.state] || diagnostics.report.state;

      const numberField = (label, value, onChange, extra = {}) => jsx.jsxs('div', {
        className: 'dsh-fairy-voice-field',
        children: [
          jsx.jsx('span', { children: label }),
          jsx.jsx('input', { type: 'number', value, onChange: (event) => onChange(Number(event.target.value)), ...extra }),
        ],
      });

      return jsx.jsxs('div', {
        className: 'dsh-fairy-voice-panel',
        'data-fairy-voice-panel': 'true',
        children: [
          jsx.jsx('div', { className: 'dsh-fairy-voice-title', children: 'Fairy 语音' }),
          jsx.jsx('p', {
            className: 'dsh-fairy-voice-hint',
            children: '回合结束时用本机 Fairy 音色播报最终结论；事件音效可独立开关。回复只发送到本机 GPT-SoVITS，不经过第三方。',
          }),

          jsx.jsx('div', { className: 'dsh-fairy-voice-group', children: [
            jsx.jsx(StatusRow, {
              label: '服务',
              value: snapshot.ready ? '正常' : (snapshot.error ? `不可用：${snapshot.error}` : '读取中…'),
              level: snapshot.ready ? 'ok' : 'bad',
            }),
            jsx.jsx(StatusRow, { label: '音效目录', value: manifest?.config?.soundsDir || '（默认目录）' }),
            jsx.jsx(StatusRow, {
              label: '音效就绪',
              value: `${soundCount} / ${expectedCount} 段`,
              level: soundCount > 0 ? 'ok' : 'bad',
            }),
            jsx.jsx(StatusRow, {
              label: '浏览器音频',
              value: diagnostics.audioContextState === 'running' ? '已解锁'
                : diagnostics.audioContextState === 'suspended' ? '等待首次交互'
                  : diagnostics.audioContextState,
              level: diagnostics.audioContextState === 'running' ? 'ok' : 'info',
            }),
            jsx.jsx(StatusRow, {
              label: '回合播报',
              value: autoReport ? `${ttsVoice} · ${reportState}` : '已关闭',
              level: diagnostics.report.state === 'failed' ? 'bad' : autoReport ? 'ok' : 'info',
            }),
            ...Object.entries(diagnostics.subscriptions).map(([name, value]) => jsx.jsx(StatusRow, {
              key: name,
              label: name,
              value: String(value),
              level: String(value).includes('失败') || String(value).includes('没有') ? 'bad' : 'ok',
            })),
          ] }),

          jsx.jsx('div', { className: 'dsh-fairy-voice-group', children: [
            jsx.jsx('label', { className: 'dsh-fairy-voice-switch', children: [
              jsx.jsx('input', {
                type: 'checkbox', checked: enabled, 'data-fairy-voice-master': 'true',
                /* 同上：不读 event.target.checked。从受控值推下一个状态，
                 * 这样即使 React 已经把 DOM 重置回旧值也不受影响。 */
                onChange: () => {
                  const next = !enabled;
                  patchConfig({ enabled: next, muted: false });
                  void engine.fire(next ? 'voice-on' : 'voice-off', {});
                  if (next) {
                    void player.unlock().then(() => player.warm(
                      ['welcome-1.wav', 'task-start-1.wav', 'success-1.wav', 'error.wav'].map((file) => engine.urlFor(file)),
                    ));
                  }
                },
              }),
              jsx.jsx('span', { children: '启用事件音效' }),
            ] }),
            jsx.jsx('label', { className: 'dsh-fairy-voice-switch', children: [
              jsx.jsx('input', {
                type: 'checkbox', checked: config?.muted === true,
                onChange: (event) => patchConfig({ muted: event.target.checked }),
              }),
              jsx.jsx('span', { children: '静音（保留各项开关状态）' }),
            ] }),
            jsx.jsx('div', { className: 'dsh-fairy-voice-field', children: [
              jsx.jsx('span', { children: `音量 ${Math.round(volume * 100)}%` }),
              jsx.jsx('input', {
                type: 'range', min: '0', max: '1', step: '0.05', value: volume,
                onChange: (event) => patchConfig({ volume: Number(event.target.value) }),
              }),
            ] }),
            numberField('久坐提醒间隔（分钟）', Number(config?.activityMinutes ?? 60),
              (value) => patchConfig({ activityMinutes: value }), { min: 1, max: 1440 }),
            numberField('上下文告警阈值（%）', Math.round(Number(config?.contextWarningRatio ?? 0.8) * 100),
              (value) => patchConfig({ contextWarningRatio: value / 100 }), { min: 10, max: 99 }),
            numberField('余额告警阈值', Number(config?.quotaWarningAmount ?? 10),
              (value) => patchConfig({ quotaWarningAmount: value }), { min: 0, step: 1 }),
          ] }),

          jsx.jsx('div', { className: 'dsh-fairy-voice-group', children: [
            jsx.jsx('div', { className: 'dsh-fairy-voice-group-title', children: '启动语音' }),
            jsx.jsx('label', { className: 'dsh-fairy-voice-switch', children: [
              jsx.jsx('input', {
                type: 'checkbox', checked: startupEnabled, 'data-fairy-voice-startup': 'true',
                onChange: () => patchConfig({ startupVoice: { enabled: !startupEnabled } }),
              }),
              jsx.jsx('span', { children: '主页面出现时播放 Fairy 语音' }),
            ] }),
            jsx.jsx('div', { className: 'dsh-fairy-voice-field', children: [
              jsx.jsx('span', { children: '开场语句' }),
              jsx.jsx('select', {
                value: startupPreset,
                'data-fairy-voice-startup-preset': 'true',
                onChange: (event) => patchConfig({ startupVoice: { preset: event.target.value } }),
                children: [
                  jsx.jsx('option', { value: 'full', children: '完整自我介绍' }),
                  jsx.jsx('option', { value: 'short', children: '简短问候' }),
                  jsx.jsx('option', { value: 'custom', children: '自定义' }),
                ],
              }),
            ] }),
            startupPreset === 'custom' ? jsx.jsx('label', {
              className: 'dsh-fairy-voice-field dsh-fairy-voice-textarea-field',
              children: [
                jsx.jsx('span', { children: '自定义开场白' }),
                jsx.jsx('textarea', {
                  value: startupCustomText,
                  maxLength: 1000,
                  rows: 4,
                  placeholder: '留空时使用完整自我介绍',
                  'data-fairy-voice-startup-text': 'true',
                  onChange: (event) => patchConfig({ startupVoice: { customText: event.target.value } }),
                }),
              ],
            }) : null,
            jsx.jsx('label', { className: 'dsh-fairy-voice-switch', children: [
              jsx.jsx('input', {
                type: 'checkbox', checked: startupGreetingEnabled,
                onChange: () => patchConfig({ startupVoice: { greetingEnabled: !startupGreetingEnabled } }),
              }),
              jsx.jsx('span', { children: '介绍结束后播放时段问候' }),
            ] }),
            numberField('问候前停顿（毫秒）', startupGreetingPauseMs,
              (value) => patchConfig({ startupVoice: { greetingPauseMs: value } }), { min: 0, max: 5000, step: 100 }),
            jsx.jsxs('div', { className: 'dsh-fairy-voice-actions', children: [
              jsx.jsx('button', {
                type: 'button',
                'data-fairy-voice-startup-preview': 'true',
                onClick: () => {
                  void reporter.previewStartup(
                    startupText(config?.startupVoice),
                    startupGreetingEnabled,
                    startupGreetingPauseMs,
                  );
                },
                children: '试听启动语音',
              }),
              jsx.jsx('span', {
                className: 'dsh-fairy-voice-report-state',
                children: `${startupPreset === 'full' ? '完整版' : startupPreset === 'short' ? '简短版' : '自定义'} · ${startupEnabled ? '已启用' : '已关闭'}`,
              }),
            ] }),
          ] }),

          jsx.jsx('div', { className: 'dsh-fairy-voice-group', children: [
            jsx.jsx('div', { className: 'dsh-fairy-voice-group-title', children: '回合结束语音汇报' }),
            jsx.jsx('label', { className: 'dsh-fairy-voice-switch', children: [
              jsx.jsx('input', {
                type: 'checkbox', checked: autoReport, 'data-fairy-voice-auto-report': 'true',
                onChange: () => patchConfig({ autoReport: !autoReport }),
              }),
              jsx.jsx('span', { children: '使用 Fairy 音色播报最终结果' }),
            ] }),
            jsx.jsx('div', { className: 'dsh-fairy-voice-field', children: [
              jsx.jsx('span', { children: '音色' }),
              jsx.jsx('select', {
                value: ttsVoices.includes(ttsVoice) ? ttsVoice : ttsVoices[0],
                'data-fairy-voice-tts-voice': 'true',
                onChange: (event) => patchConfig({ tts: { voice: event.target.value } }),
                children: ttsVoices.map((voice) => jsx.jsx('option', { value: voice, children: voice }, voice)),
              }),
            ] }),
            jsx.jsx('div', { className: 'dsh-fairy-voice-field', children: [
              jsx.jsx('span', { children: `语速 ${ttsSpeed.toFixed(2)}×` }),
              jsx.jsx('input', {
                type: 'range', min: '0.5', max: '2', step: '0.05', value: ttsSpeed,
                'data-fairy-voice-tts-speed': 'true',
                onChange: (event) => patchConfig({ tts: { speed: Number(event.target.value) } }),
              }),
            ] }),
            jsx.jsxs('div', { className: 'dsh-fairy-voice-actions', children: [
              jsx.jsx('button', {
                type: 'button',
                'data-fairy-voice-tts-preview': 'true',
                onClick: () => { void reporter.preview(); },
                children: '试听 Fairy',
              }),
              jsx.jsx('span', { className: 'dsh-fairy-voice-report-state', children: reportState }),
            ] }),
          ] }),

          ...groups.map(([group, triggers]) => jsx.jsxs('div', {
            className: 'dsh-fairy-voice-group',
            key: group,
            children: [
              jsx.jsx('div', { className: 'dsh-fairy-voice-group-title', children: group }),
              ...triggers.map((trigger) => jsx.jsx(TriggerRow, {
                key: trigger.id, trigger, config,
                onToggle: (id, value) => patchConfig({ triggers: { [id]: value } }),
              })),
            ],
          })),

          jsx.jsx('div', { className: 'dsh-fairy-voice-group', children: [
            jsx.jsxs('div', { className: 'dsh-fairy-voice-actions', children: [
              jsx.jsx('button', {
                type: 'button',
                onClick: () => { void player.unlock(); void loadManifest(); },
                children: '解锁音频并重新扫描',
              }),
              jsx.jsx('button', {
                type: 'button',
                onClick: () => setShowDiag((value) => !value),
                children: showDiag ? '收起诊断' : '诊断信息',
              }),
              jsx.jsx('button', {
                type: 'button',
                onClick: () => {
                  const payload = {
                    version: 1,
                    ready: snapshot.ready,
                    error: snapshot.error,
                    config: snapshot.config,
                    available: soundCount,
                    audio: diagnostics.audioContextState,
                    subscriptions: diagnostics.subscriptions,
                    events: diagnostics.events,
                    notes: diagnostics.notes.slice(-10),
                  };
                  void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
                },
                children: '复制诊断信息',
              }),
            ] }),
            showDiag ? jsx.jsxs('div', { className: 'dsh-fairy-voice-diag', children: [
              jsx.jsx('div', { className: 'dsh-fairy-voice-diag-title', children: '最近触发' }),
              diagnostics.events.length === 0
                ? jsx.jsx('div', { className: 'dsh-fairy-voice-diag-row', children: '（还没有触发过）' })
                : diagnostics.events.map((row, index) => jsx.jsx('div', {
                  className: 'dsh-fairy-voice-diag-row',
                  key: `${row.at}-${index}`,
                  children: `${new Date(row.at).toLocaleTimeString()}  ${row.id}${row.file ? `  ${row.file}` : ''}${row.skipped ? `  [${row.skipped}]` : ''}`,
                })),
              diagnostics.notes.length === 0 ? null : jsx.jsxs(React.Fragment, { children: [
                jsx.jsx('div', { className: 'dsh-fairy-voice-diag-title', children: '提示' }),
                diagnostics.notes.slice(-6).map((row, index) => jsx.jsx('div', {
                  className: 'dsh-fairy-voice-diag-row',
                  key: `${row.at}-${index}`,
                  children: `${new Date(row.at).toLocaleTimeString()}  ${row.message}`,
                })),
              ] }),
            ] }) : null,
          ] }),
        ],
      });
    }

    // ============================================================ 样式

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-fairy-voice');
      style.textContent = `
.dsh-fairy-voice-controls{display:inline-flex;align-items:center;gap:6px;height:28px}
.dsh-fairy-voice-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dsh-fairy-voice-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-voice-toggle:disabled{opacity:.45;cursor:default}
.dsh-fairy-voice-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-text-3,#9aa0a6);transition:background .15s ease,box-shadow .15s ease}
.dsh-fairy-voice-toggle[data-on="true"]{border-color:var(--dsw-alias-business-primary,#4a7dff)}
.dsh-fairy-voice-toggle[data-on="true"] .dsh-fairy-voice-dot{background:var(--dsw-alias-business-primary,#4a7dff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-business-primary,#4a7dff) 22%,transparent)}
.dsh-fairy-voice-volume{width:64px;height:4px;-webkit-appearance:none;appearance:none;border-radius:999px;background:linear-gradient(to right,var(--dsw-alias-business-primary,#4a7dff) var(--dsh-fairy-voice-volume,80%),var(--dsw-alias-border-l2) var(--dsh-fairy-voice-volume,80%));cursor:pointer}
.dsh-fairy-voice-volume::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:999px;background:#fff;border:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.dsh-fairy-voice-volume:disabled{opacity:.45}
.dsh-fairy-voice-panel{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.7}
.dsh-fairy-voice-title{font-size:15px;font-weight:600}
.dsh-fairy-voice-hint{margin:0;color:var(--dsw-alias-text-3,#8a9099);font-size:12px}
.dsh-fairy-voice-group{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dsh-fairy-voice-group-title{font-weight:600;font-size:12px;color:var(--dsw-alias-text-3,#8a9099)}
.dsh-fairy-voice-row{display:flex;justify-content:space-between;gap:12px}
.dsh-fairy-voice-row-label{color:var(--dsw-alias-text-3,#8a9099);white-space:nowrap}
.dsh-fairy-voice-row-value{text-align:right;word-break:break-all}
.dsh-fairy-voice-row-value[data-level="ok"]{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsh-fairy-voice-row-value[data-level="bad"]{color:var(--dsw-alias-state-error-primary,#d64545)}
.dsh-fairy-voice-switch,.dsh-fairy-voice-trigger-label{display:flex;align-items:center;gap:8px;cursor:pointer}
.dsh-fairy-voice-field{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-fairy-voice-field input[type="number"],.dsh-fairy-voice-field select{width:96px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit}
.dsh-fairy-voice-field input[type="range"]{flex:1;max-width:200px}
.dsh-fairy-voice-field select{width:144px}
.dsh-fairy-voice-textarea-field{align-items:stretch;flex-direction:column;gap:6px}
.dsh-fairy-voice-textarea-field textarea{box-sizing:border-box;width:100%;min-height:78px;resize:vertical;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;line-height:1.55}
.dsh-fairy-voice-trigger{display:flex;flex-direction:column;gap:4px}
.dsh-fairy-voice-trigger-header{display:flex;align-items:center;gap:8px;min-height:28px}
.dsh-fairy-voice-trigger-expand,.dsh-fairy-voice-trigger-expand-spacer{box-sizing:border-box;width:20px;height:22px;flex:0 0 20px}
.dsh-fairy-voice-trigger-expand{padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-text-3,#8a9099);cursor:pointer;font-size:14px;line-height:1}
.dsh-fairy-voice-trigger-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:inherit}
.dsh-fairy-voice-trigger-play{width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:10px;line-height:1}
.dsh-fairy-voice-trigger-play:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-voice-trigger-play:disabled{opacity:.4;cursor:not-allowed}
.dsh-fairy-voice-trigger-label{flex:1;min-width:0}
.dsh-fairy-voice-trigger-files{color:var(--dsw-alias-text-3,#8a9099);font-size:12px}
.dsh-fairy-voice-trigger-files[data-empty="true"]{color:var(--dsw-alias-state-error-primary,#d64545)}
.dsh-fairy-voice-tag{font-style:normal;font-size:11px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-text-3,#8a9099)}
.dsh-fairy-voice-trigger-details{display:flex;flex-direction:column;gap:2px;margin:0 0 4px 50px;padding:5px 8px 7px;border-left:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 34%,transparent);border-radius:0 8px 8px 0}
.dsh-fairy-voice-selection-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:1px 4px 5px;color:var(--dsw-alias-text-3,#8a9099);font-size:11px}
.dsh-fairy-voice-selection-actions{display:flex;gap:4px}
.dsh-fairy-voice-selection-actions button{padding:1px 6px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font-size:11px}
.dsh-fairy-voice-selection-actions button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-text-1,inherit)}
.dsh-fairy-voice-trigger-file{display:flex;align-items:center;gap:8px;min-height:27px;padding:1px 4px;border-radius:6px}
.dsh-fairy-voice-trigger-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-voice-trigger-file-label{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}
.dsh-fairy-voice-trigger-file-index{flex:0 0 auto;color:var(--dsw-alias-text-3,#8a9099);font-size:11px}
.dsh-fairy-voice-trigger-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-text-2,#aeb4bd)}
.dsh-fairy-voice-trigger-file-play{flex:0 0 auto;padding:2px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:11px}
.dsh-fairy-voice-trigger-file-play:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-voice-selection-empty{padding:4px;color:var(--dsw-alias-state-error-primary,#d64545);font-size:11px}
.dsh-fairy-voice-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-fairy-voice-actions button{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px}
.dsh-fairy-voice-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-voice-report-state{align-self:center;color:var(--dsw-alias-text-3,#8a9099);font-size:12px}
.dsh-fairy-voice-diag{display:flex;flex-direction:column;gap:2px;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-text-3,#8a9099);max-height:220px;overflow:auto}
.dsh-fairy-voice-diag-title{margin-top:6px;font-weight:600;font-family:inherit}
.dsh-fairy-voice-diag-row{word-break:break-all}
`;
      document.head.appendChild(style);
    }

    // ============================================================ 注册

    function injectSlot(ctx, definition, component) {
      return ctx.slots.inject(definition.name, () => ctx.slots.register(definition, component));
    }

    function apply(ctx) {
      diagnostics.mounted = true;
      try { globalThis.__FAIRY_VOICE_DIAG__ = diagnostics; } catch { /* 无所谓 */ }
      ensureStyles();
      void loadManifest();

      const disposeSlots = [
        injectSlot(ctx, { name: 'conversation.input.left', id: 'fairy-voice-controller', order: 60 }, ComposerControl),
        injectSlot(
          ctx,
          { name: 'settings.section', id: 'dsh-fairy-voice-settings', order: 44, label: () => 'Fairy 语音' },
          FairyVoiceSettings,
        ),
      ].filter((dispose) => typeof dispose === 'function');

      detectors = createDetectors(ctx);
      try {
        detectors.start();
      } catch (error) {
        note(`检测器启动失败：${error?.message || error}`);
      }

      // 浏览器自动播放策略：任意一次用户手势都可以解锁 AudioContext。
      const unlockFromGesture = () => { void player.unlock(); };
      window.addEventListener('pointerdown', unlockFromGesture, { passive: true });
      window.addEventListener('keydown', unlockFromGesture, { passive: true });

      ctx.effect(() => () => {
        disposeSlots.forEach((dispose) => { try { dispose(); } catch { /* 忽略 */ } });
        window.removeEventListener('pointerdown', unlockFromGesture);
        window.removeEventListener('keydown', unlockFromGesture);
        try { detectors?.stop(); } catch { /* 忽略 */ }
        detectors = null;
        document.getElementById(STYLE_ID)?.remove();
        player.dispose();
        listeners.clear();
      }, 'dsh-fairy-voice lifecycle');
    }

    return { apply, inject: ['slots'] };
  },
});
