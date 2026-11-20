window.__ModuleLoader__.load({
  id: 'dsh-fairy-idle',
  factory: () => {
    /* Idle companion: after the user has been quiet for a while, Fairy says
     * one of her idle lines. The browser half owns timing and playback; the
     * host only serves the WAV pool. */

    const SETTINGS_MINUTES = 'dsh.fairyIdle.minutes';
    const SETTINGS_ENABLED = 'dsh.fairyIdle.enabled';
    const POOL_URL = '/fairy-idle/pool.json';
    const DEFAULT_MINUTES = 10;
    const MIN_MINUTES = 1;
    const MAX_MINUTES = 120;

    function readNumber(key, fallback) {
      const raw = Number(localStorage.getItem(key));
      if (!Number.isFinite(raw) || raw < MIN_MINUTES || raw > MAX_MINUTES) return fallback;
      return raw;
    }

    function enabled() {
      return localStorage.getItem(SETTINGS_ENABLED) !== '0';
    }

    function apply(ctx) {
      (() => {
        let idleTimer = null;
        let audio = null;
        let pool = null;
        let poolPromise = null;
        let disposed = false;
        let lastPick = '';

        const cleanupAudio = () => {
          if (!audio) return;
          try {
            audio.pause();
            audio.src = '';
          } catch { /* ignore */ }
          audio = null;
        };

        const loadPool = () => {
          if (pool) return Promise.resolve(pool);
          if (poolPromise) return poolPromise;
          poolPromise = fetch(POOL_URL, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error('pool-' + response.status))))
            .then((value) => {
              pool = Array.isArray(value && value.lines) ? value.lines : [];
              return pool;
            })
            .catch(() => {
              poolPromise = null;
              return [];
            });
          return poolPromise;
        };

        const schedule = () => {
          if (disposed) return;
          if (idleTimer) clearTimeout(idleTimer);
          const minutes = readNumber(SETTINGS_MINUTES, DEFAULT_MINUTES);
          idleTimer = setTimeout(fire, minutes * 60 * 1000);
        };

        const fire = async () => {
          if (disposed) return;
          if (!enabled() || document.visibilityState !== 'visible' || audio) {
            schedule();
            return;
          }
          const lines = await loadPool();
          if (!lines.length) {
            schedule();
            return;
          }
          const candidates = lines.length > 1 ? lines.filter((line) => line.id !== lastPick) : lines;
          const pick = candidates[Math.floor(Math.random() * candidates.length)] || lines[0];
          lastPick = pick.id;
          try {
            audio = new Audio(pick.url);
            audio.volume = 1;
            audio.addEventListener('ended', () => { cleanupAudio(); schedule(); }, { once: true });
            audio.addEventListener('error', () => { cleanupAudio(); schedule(); }, { once: true });
            await audio.play();
          } catch {
            cleanupAudio();
            schedule();
          }
        };

        const wake = () => {
          if (audio) {
            // The user came back: stop talking and restart the quiet clock.
            cleanupAudio();
          }
          schedule();
        };

        const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input', 'focus'];
        for (const event of events) window.addEventListener(event, wake, { passive: true, capture: true });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); });
        window.addEventListener('pagehide', cleanupAudio);

        schedule();

        ctx.effect(() => () => {
          disposed = true;
          if (idleTimer) clearTimeout(idleTimer);
          cleanupAudio();
          for (const event of events) window.removeEventListener(event, wake, { capture: true });
        }, 'dsh-fairy-idle timer');
      })();
    }

    return { apply, inject: [], name: 'dsh-fairy-idle' };
  },
});
