# 启动动画与启动语音流程

## 1. 素材

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| boot.mp4 | `~/.dsh/fairy-visual/boot.mp4` | HDD 启动动画，约 14 秒（5.9 MB） |
| boot-fairy-original.wav | `~/.dsh/fairy-visual/boot-fairy-original.wav` | 原始启动音频（2.8 MB） |
| settings.json | `~/.dsh/fairy-visual/settings.json` | 视觉设置 |

## 2. 启动时序（fairy-visual 的 src/client/index.js）

1. HDD boot 画面挂载（`#dsh-hdd-boot`）。
2. 并行加载 `/fairy-voice/config` 中的启动语音配置（`cache: 'no-store'`）。
3. 动画播放期间**预热**开场白与时段问候两段 TTS（`window.fairyPrepare` 逐段预合成，含按「根据您签署的用户协议」切分的 intro 分段）。
4. boot 结束派发 `dsh-fairy-boot-exited`；收到后**等待约 500ms**。
5. 播放开场白（完整版/简短版/自定义；分段语速 1 / 0.96，见 references/01）。
6. 等待 `greetingPauseMs`（默认 1500ms，0–5000 clamp）。
7. 播放时段问候（早上好/中午好/下午好/晚上好，主人。）。

若 `window.__dshFairyBootPhase === 'complete'` 或 boot 元素不存在，直接进入问候流程（跳过等待）。全程输出 `DSH_FAIRY_BOOT_AUDIO {...}` 结构化日志（source: intro / time-greeting / unavailable；含 bootExitedAt、speechDelayMs 等计时字段）。

## 3. 参数与开关

| 项 | 字段 / 值 |
| --- | --- |
| 启动语音总开关 | `startupVoice.enabled`（与事件音效总开关相互独立） |
| 开场白版本 | `startupVoice.preset`: full / short / custom |
| 自定义开场白 | `startupVoice.customText` |
| 时段问候开关 | `startupVoice.greetingEnabled` |
| 问候间隔 | `startupVoice.greetingPauseMs` 0–5000ms |
| 主页面出现到播报 | 约 0.5s |

## 4. 动画素材的替代与恢复

- boot.mp4 属于受版权约束的视觉资产，不随 skill 分发（见 references/09-assets-and-licensing.md）。
- 恢复时从个人备份放回 `~/.dsh/fairy-visual/`；或替换为任意自定义 HDD 风格启动视频（文件名保持 boot.mp4）。
- 若只有音频需求，boot-fairy-original.wav 可与动画分离使用。

## 5. 验证清单（启动后检查）

1. HDD boot 画面出现并完整播放。
2. 主页面出现约 0.5s 后开场白开始。
3. 开场白与时段问候之间间隔 1500ms。
4. 「设置 → Fairy 语音」状态区显示 TTS 就绪；试听开场白正常。
5. 日志出现 `DSH_FAIRY_BOOT_AUDIO {"source":"intro",...}` 与 `{"source":"time-greeting",...}`。

## 6. 常见问题

- **开场白无声**：确认 `/fairy-voice/config` 可访问；TTS 服务能在 120 秒内启动（插件会尝试执行本机启动脚本）。
- **动画结束但无问候**：检查 `greetingEnabled` 与 TTS 状态；`greetingPauseMs` 是否被设成异常值（clamp 0–5000）。
- **改了语音配置不生效**：host 代码 / profile / 依赖变化必须完全重启 DSH；仅浏览器端变化可用「应用 → 重新加载界面」。
