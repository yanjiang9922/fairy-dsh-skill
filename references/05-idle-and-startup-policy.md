# 待机语音与启动策略

## 1. Fairy 待机语音（dsh-fairy-idle 0.1.0）

浏览器端负责计时与播放，宿主只提供 WAV 池（`/fairy-idle/pool.json`）。

### 语音池

目录 `~/.dsh/fairy-voice/idle/`，11 段：`group-345.wav`、`line-02.wav` … `line-11.wav`。

### 触发条件（全部满足才播）

1. 设置启用（`localStorage['dsh.fairyIdle.enabled'] !== '0'`，默认启用）。
2. 页面可见（`document.visibilityState === 'visible'`）。
3. 用户无操作达到 N 分钟（`dsh.fairyIdle.minutes`，默认 10，范围 1–120，非法值回落默认）。
4. 当前没有正在播放的待机音频。

### 行为

- 从池中随机选一段，避免与上一段重复（`lastPick` 记忆）。
- 用户回归（`pointerdown` / `keydown` / `wheel` / `touchstart` / `input` / `focus`）立即停止播放并重置安静计时。
- 播放结束或出错后重新排程；页面重新可见时重新排程；`pagehide` 清理。
- 音量固定 1，使用 HTMLAudioElement（非 Web Audio 引擎）。

## 2. 启动策略（dsh-fairy-startup 1.0.0）

目标：新文档进入**空白会话**，而不是恢复上次会话。

### 流程

1. 设置一次性标记 `data-dsh-fairy-startup-reset` 防止重复执行。
2. 清除恢复的会话选择：`sessions.clear()`（**feature-detect**：DSH ≥0.1.7 已删除此 API，不存在时记录 `session.clear-unsupported` 并跳过，不让入口整体崩溃）。
3. 订阅 workspace list：等 `baselinesReady` 后调用 `workspaces.startSession()` 进入官方空白会话投影；`recentWorkspaceId === undefined`（rc.2+ 合法空选择状态）时不动原生新会话视图。
4. 完成后退订。

### 诊断

- 使用共享 `createFairyDiagnostics`（日志前缀 `DSH_FAIRY_LOG`，schema 1 JSON：module/operation/event/context/duration_ms/error）。
- 敏感字段脱敏：key 匹配 `/authorization|credential|password|secret|token|api[_-]?key|cookie/i` → `[redacted]`；字符串截断 320 字符；对象 2 层 / 24 键截断；错误去重 60s。
- 错误只在发生与恢复之间各记一次（按 signature 60 秒窗口去重）。

## 3. 与其它模块的协作边界

- fairy-startup 只决定「打开哪个会话」，不碰语音；启动语音由 fairy-visual 在 boot 后触发（references/04）。
- fairy-idle 只在会话界面长时间静默时说话；与回合汇报（fairy-voice）共用 Fairy 声线但相互独立触发。
- 两模块都在 DSH profile 的 `clientModules` 里注册（references/08）。
