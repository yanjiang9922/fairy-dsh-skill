---
name: fairy-dsh
description: Fairy-DSH 桌面 AI 助手人格与视觉套件的完整功能规格。当用户需要在 DSH（DeepSeek Desktop）上实现、修复、调整或重新部署 Fairy 语音人格（开场白、时段问候、回合汇报、44 段事件音效、GPT-SoVITS 本地声线）、HDD 主题界面（深色/浅色色板、侧边栏聚合物材质、输入框 Dock 胶囊控制区、Fairy 主视觉 mascot）或启动动画与启动语音流程时使用。也用于回答这些功能「是什么、怎么配置、参数取值、如何恢复」的问题。
---

# Fairy-DSH Skill

本 skill 是 Fairy-DSH 插件套件的**完整功能规格归档**，覆盖部署在 DSH Desktop 2.0.19-next（Windows x64）上的 7 个插件模块的全部行为、参数、文案与实现决策。

## 适用场景

- 复现 / 重新部署 Fairy-DSH（含从零恢复语音与视觉资产）
- 调整 Fairy 语音人格（开场白、问候、语速、停顿、汇报口径）
- 修复或扩展 HDD 主题界面、输入框 Dock、启动动画
- 排查「没声音」「开场白不播」「Dock 错位」等问题
- 回答任何关于 Fairy-DSH 功能与参数的问题

## 模块总览

| 模块 | 版本 | 职责 |
| --- | --- | --- |
| dsh-fairy-visual | 0.1.0 | HDD 视觉、Fairy 主视觉、输入框 Dock、启动动画、设置页 |
| dsh-fairy-voice | 1.1.0 | 回合语音汇报、44 段事件音效、逐段选择、GPT-SoVITS 代理 |
| dsh-fairy-idle | 0.1.0 | 长时间空闲后的 Fairy 待机语音 |
| dsh-fairy-startup | 1.0.0 | 新文档进入空白会话的启动策略 |
| dsh-balance-meter | 0.2.0 | 侧边栏 DeepSeek 余额和用量 |
| dsh-browser-dock | 0.1.0 | Playwright MCP 浏览器画面 Dock |
| dsh-fairy-contracts | 0.1.0 | 公共设置契约和客户端诊断 |

## 参考文档索引

按需读取以下 reference 文件，不要一次全部加载：

| 主题 | 文件 |
| --- | --- |
| Fairy 语音人格（开场白、问候、汇报、语气规则、声线） | references/01-voice-personality.md |
| 事件音效完整目录（24 事件 / 44 音效、优先级、冷却） | references/02-event-sounds.md |
| 界面与 HDD 主题（色板、mascot、侧边栏、输入框 Dock 几何） | references/03-ui-hdd-theme.md |
| 启动动画与启动语音流程 | references/04-startup-animation.md |
| 待机语音与启动策略模块 | references/05-idle-and-startup-policy.md |
| 余额卡片与浏览器 Dock | references/06-balance-browser-dock.md |
| GPT-SoVITS 本地 TTS 桥与声线档案 | references/07-tts-gpt-sovits.md |
| 部署架构、注册、持久化、恢复与排错 | references/08-deployment.md |
| 资产清单、来源与版权声明（assets/ 已含全部音频、画面与模型） | references/09-assets-and-licensing.md |

## 核心工作流

### 调整语音人格参数

1. 修改运行配置 `~/.dsh/fairy-voice/config.json`（或通过「设置 → Fairy 语音」）。
2. 关键字段：`startupVoice`（enabled / preset / customText / greetingEnabled / greetingPauseMs 0–5000）、`tts`（endpoint / voice / speed）、`autoReport`、`triggers`、`soundSelections`。
3. 修改 host 代码、profile 或包依赖后必须**完全重启 DSH**；仅浏览器端 `lib/client.js` 变化可「应用 → 重新加载界面」。
4. 验证：启动播报开场白 + 时段问候；一轮对话结束听到汇报；设置页试听正常。

### 恢复整套部署

按 `references/08-deployment.md` 的恢复步骤：源码 → desktop profile → 运行数据 → GPT-SoVITS 模型 → 启动 `start-api.bat` → 重启 DSH → 七项启动检查。

## 硬性约束

- TTS 只连本机 `http://127.0.0.1:9880`，对话内容不出本机。
- 人格口径：用户是「主人」，不用「绳匠」，不重复「向绳匠法厄同汇报」式抬头；语气冷静克制。
- 启动语音与事件音效总开关相互独立；`voice-on` / `voice-off` 两音效在静音下仍播放。
- 版权声明见 `references/09-assets-and-licensing.md`：本仓库含 Fairy 声线拟合权重、B 站来源音频与启动动画，均属版权衍生品，仅限个人学习研究；权利方要求时需立即下架或转私有。恢复部署时资产直接取自 `assets/`。
