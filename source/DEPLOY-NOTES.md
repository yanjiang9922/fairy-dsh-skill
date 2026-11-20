# Fairy-DSH — deployment notes

Source: https://github.com/Chengzhibense/Fairy-DSH (branch `main`, downloaded 2026-11-05).
Licence: Apache-2.0 (`LICENSE` / `NOTICE` kept in this directory).
Target host: DSH 0.2.1-rc.2 (desktop 2.0.19-next, `resources/runtime/x64/primary-runtime/runtime.json`).
Upstream targets DSH 0.1.1-rc.2 — see "Local changes" for what that cost.

## What is installed

Five client plugins, staged here and linked into the desktop DSH profile
(`~/.dsh/profiles/desktop`):

| package | host half | browser half | role |
| --- | --- | --- | --- |
| `dsh-fairy-visual` | settings store + `/fairy-visual/settings` | HDD stage, mascot, composer dock, settings page | the Fairy look |
| `dsh-balance-meter` | `/balance-meter` route | sidebar balance card | DeepSeek balance |
| `dsh-browser-dock` | `/browser-dock` routes | browser dock panel | Playwright frame host |
| `dsh-fairy-voice` | `/fairy-voice` routes, TTS bridge | voice control in the composer | TTS playback |
| `dsh-fairy-startup` | none | fresh-document session policy | start on a blank session |

Registration is the profile patch layer, not a bundle: the packages carry
`dsh.client` but no `dsh.bundle.patch`, which matches the upstream
`profiles/web/cordis.patch.yml` template.

* `~/.dsh/profiles/desktop/package.json` — six `link:../../fairy-dsh/...` deps.
* `~/.dsh/profiles/desktop/cordis.patch.yml` — one `insert:` list with the five
  entry ids (`balance-meter`, `browser-dock`, `fairy-startup`, `fairy-voice`,
  `fairy-visual`). Keep this file BOM-free; a UTF-8 BOM from PowerShell's
  `Set-Content -Encoding UTF8` stops the profile watcher from applying it.
* `pnpm-workspace.yaml` + `package.json` here — so the plugins' own
  dependencies (`mdast-util-*`, `micromark-extension-gfm`, `dsh-fairy-contracts`)
  resolve from their real paths. pnpm does **not** install dependencies of
  `link:` targets, so without this workspace the host halves cannot import.

Backups of the three profile files are next to them as `*.bak-fairy-<stamp>`.

## Settings transport (the 0.2.1 port)

DSH 0.1.1 gave a plugin a settings namespace through
`settingsNamespace()` + `SettingsService.register()`, and the browser half read
it with `ctx.settingsScope.bind({ namespace })`. Both are gone:

* `settingsNamespace` was deleted in 0.1.2-alpha.1 — and a missing *named
  export* is an ESM SyntaxError at module evaluation, which took the whole
  `dsh-fairy-visual` entry down.
* `SettingsService.register` was deleted in 0.1.7; namespaces now derive from a
  plugin's `Config` schema, and there is no client-side `settingsScope` in
  0.2.1 at all (verified by scanning `app.asar`: the only remaining reference is
  the market using it as an injection *key*).

So `dsh-fairy-visual` now owns its persistence instead of borrowing the host's:

* **Host** (`lib/index.js`): a `GET`/`POST /fairy-visual/settings` route
  registered through `ctx.inject(['webServer'])`, backed by
  `~/.dsh/fairy-visual/settings.json` (dir 0700, file 0600, atomic
  tmp+rename). Every field is validated/clamped server-side; unknown fields and
  unknown namespaces are rejected (`400`). The legacy `settings.register` path
  is still used when a host has it.
* **Browser** (`lib/client.js`): one adapter inserted in the module factory
  provides the exact contract the visual code consumes —
  `getSnapshot() → { value }`, `subscribe(fn)`, `set(field, value)` — talking to
  the route and keeping a `localStorage` mirror so values restore instantly and
  still work when the route is unavailable (plain browser, 403, offline).
  `ctx.settingsScope` is used when a host still provides it.

The Fairy settings page stays where upstream put it: **Settings → HDD 视觉与
Fairy 身份** (`settings.section` slot), plus the HDD toggle in the session
header. Values survive app restarts because they are on disk, not in the page.

## Local changes versus upstream

Each edit is marked in-file and has a backup.

1. `fairy-visual/dsh-fairy-visual/package.json` — `@deepseek-ai/dsh-settings`
   and `@deepseek-ai/schemastery` moved from `dependencies` to optional
   `peerDependencies`. DSH supplies `@deepseek-ai/*` to profile plugins through
   its own resolver (same pattern as `dsh-pet`, `dsh-notion-oauth-ui`); pinning
   0.1.1-rc.2 would have installed a second, older settings package.
2. `fairy-visual/dsh-fairy-visual/lib/index.js` — the settings/route port above.
   Original kept as `lib/index.js.orig-fairy-0.1.1`.
3. `fairy-visual/dsh-fairy-visual/lib/client.js` — the browser adapter above
   (plus `index.iife.js`, kept byte-identical). Upstream bundle is otherwise
   untouched.
4. `fairy-startup/dsh-fairy-startup/lib/client.js` — `sessions.clear()` no longer
   exists on the 0.2.1 client and threw during `apply`; now feature-detected
   (same for `workspaces.startSession()`).

Removed from the staged copies: `test/`, `tsdown.config.ts`, package lockfiles.

## Verification

Both halves are covered by harnesses that run the deployed files, not copies
(scripts live in `%TEMP%\fairy-harness`; `schemastery`, `cosmokit` and `yaml`
were extracted from `app.asar` so the real module loads):

* `test-host.mjs` — 19 checks: route shape, defaults, single-field and patch
  writes, clamping (`mascotScale: 5 → 1`), rejection (`powerMode: 'turbo'`,
  unknown field, unknown namespace → 400, bad method → 405), on-disk document,
  no leftover temp files, 0.2.1 path detected. **All pass.**
* `test-client.mjs` — 20 checks: bundle wiring, `{ value }` snapshot shape,
  defaults before load, host value wins after load, optimistic write, subscriber
  notification and unsubscribe, POST body shape, localStorage mirror, and the
  offline/403 fallbacks. **All pass.**
* `check-config.mjs` — parses `cordis.patch.yml` the way DSH does (with the
  `!!js` tag): 5 inserts, no duplicate ids, no BOM. **Passes.**

Then a real host run: an isolated `DSH_HOME` (`%TEMP%\fairy-dshhome`, profile
`web`, only these five plugins) served by the packaged CLI —

```
"DSH NEXT.exe" app.asar/lib/desktop-cli.js web --no-open --port 55999
```

with `ELECTRON_RUN_AS_NODE=1`. That instance logged every plugin's `apply`
success, `settings.transport → plugin-route` and `settings.route.registered`,
and `test-e2e.mjs` drove it over real HTTP: settings `GET` returns defaults,
`POST` persists and reads back, unknown namespace → `400`, the index boot graph
names all five bundles, and the composed `/plugins/??…` bundle that the server
delivers contains the patched adapter. The instance was stopped afterwards.

**Live confirmation (2026-11-05 20:52, profile `desktop`):** all five plugins
logged `apply … success`, `settings.transport → plugin-route`,
`settings.route.registered` and a client-side `settings.read`, with no
`did not activate` / `runtime.failed` after the boot. `dsh-balance-meter`
reported a live balance fetch, and toggling HDD in the UI wrote
`"enabled": true` through the route into `~/.dsh/fairy-visual/settings.json`.

### 0.2.1 overlay fix: `visibility` leak in the mascot

With HDD enabled and `mascotVisible: false`, an ~853 px pulse SVG still painted
over the conversation. A temporary in-bundle DOM probe (run only on the live
host, then removed) showed:

```
dsh-fairy-float  284x284  visibility:hidden    ← ancestor correctly hidden
  └─ svg         853x853  visibility:visible   ← child re-enabled itself
```

`visibility` is overridable, and `mascot-style.js` hard-codes
`visibility: visible` on `.dsh-fairy-pulse-layer` (and the lash pulse wave), so
those layers escaped the hidden ancestor. The bundle now injects one override:

```css
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-pulse-layer,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-lash-pulse-wave { visibility: inherit !important }
```

Verified on screen after a UI reload: emblem gone, HDD theme, Fairy brand,
balance card and header controls intact.

## Activating after a change

Two different reload paths, both learned the hard way:

* **Browser-half change** (`lib/client.js`): `应用 → 重新加载界面` is enough —
  the page load re-reads the bundle from disk and picks up the new revision.
  (A full restart also works, but is not required.)
* **Host-half change** (`lib/index.js`, `cordis.patch.yml`, package installs):
  restart DSH — the host re-imports and republishes the module graph. The
  profile file watcher does **not** fire on this build (`[host.kernel.hmr]
  watching []`), so editing `cordis.patch.yml` alone changes nothing.

On the next start the log shows, in order:

```
"module":"dsh-fairy-visual","operation":"settings.transport","context":{"transport":"plugin-route"}
"module":"dsh-fairy-visual","operation":"settings.route.registered"
"module":"dsh-fairy-visual","operation":"apply","event":"metric","context":{"surface":"host","outcome":"success"}
```

and the first page that binds the route logs `settings.read` once.

## Browser dock (Playwright MCP)

wired 2026-11-05 21:45. The dock renders the frame the proxy pushes into
`~/.dsh/browser-dock/state.json` + `frame-N.jpg`; it appears only while a
browser session is driven through MCP, and goes back to `status: closed` after
`browser_close`.

* `@playwright/mcp@0.0.79` is installed in **`~/.dsh/profiles/web`** — not the
  desktop profile. `proxy.cjs` resolves the MCP entry from that path
  unconditionally (`profiles/web/node_modules/.bin/playwright-mcp`).
* `proxy.cjs` is patched in two places (both marked in-file):
  1. it spawned the `.bin/playwright-mcp` **shim**, which Windows cannot exec;
     it now spawns `process.execPath` with `@playwright/mcp/cli.js`;
  2. `externalTakeover()` spawned `/usr/bin/open` (macOS only); it now resolves
     a local Chrome/Edge (or `xdg-open`) and logs instead of throwing.
* The profile entry:

```yaml
- insert:
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: playwright
        transport: stdio
        command: <DSH runtime node.exe>
        args: [<proxy.cjs>, --browser, msedge, --headless, --user-data-dir, <pw-profile>]
```

  There is no Chrome on this machine, so `--browser msedge`; the MCP server then
  uses the installed Edge instead of downloading Chromium.

Verified: an MCP `initialize` through the proxy returns
`serverInfo: { name: Playwright, version: 1.63.0-alpha }`; `browser_navigate` to
example.com flipped `state.json` to `active: true, status: ready` with a 74 KiB
`frame-1.jpg`, and the dock rendered that frame in the top-right of the UI.

## Known limitations on DSH 0.2.1

* **DOM contract drift.** The visual layer was written against 0.1.1 slots,
  ARIA labels and `.toBottomSlot`. It fails closed per anchor, so the worst
  expected outcome is missing styling rather than a broken page — but HDD mode
  needs a visual pass in a real session.
* **TTS.** `fairy-voice` expects a GPT-SoVITS-style server at
  `http://127.0.0.1:9880/tts` and a reference voice at
  `~/.dsh/fairy-voice/runtime/reference/fairy_ref.wav`. Neither exists here, so
  the voice UI reports unavailable (logged once at load). Upstream's
  `start_fairy_voice.sh` / LaunchAgent scripts are macOS-only.
* **Browser dock** needs the `mcp-playwright` row (upstream's `proxy.cjs` +
  `@playwright/mcp`) to have a browser to dock; that is not installed.
* **Agent preset not installed.** `.agent-presets/fairy/` in the repo is
  incomplete by design: `agent.cordis.yml` references
  `.agent-presets/fairy/runtime/{index.js,fairy_core.py,safety-gate.js}` and
  `world-core/zzz-world-core-v2.15-audit-rag`, none of which ship (the README
  says world data, TTS models and private corpora are injected separately).
  Copying it as-is would produce a preset that cannot load.

## Disable / remove

Comment out an entry in `~/.dsh/profiles/desktop/cordis.patch.yml`, or add
`disabled: true` to that entry, then let the profile reload (or restart). To
remove everything: drop the six `link:` lines from the profile `package.json`,
run `pnpm install` in the profile, and delete this directory. The plugin's own
state is `~/.dsh/fairy-visual/settings.json` (plus the browser mirror in
localStorage); delete both to reset.
