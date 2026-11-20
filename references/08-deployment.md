# 部署架构、注册、持久化、恢复与排错

## 1. 部署形态

- 宿主：DSH Desktop 2.0.19-next（DSH 0.2.1-rc.2 内核），Windows x64。上游插件目标为 0.1.1-rc.2，本部署做了 0.2.1 移植。
- 工作区：`C:\Users\<用户>\.dsh\fairy-dsh\`（pnpm monorepo，7 个包）。
- Profile：`~/.dsh/profiles/desktop`，通过 **cordis.patch.yml 的 insert 列表**注册 6 个客户端插件 + Playwright MCP；包依赖用 `link:../../fairy-dsh/...` 本地链接。
- 关键依赖版本：Node 24.x、pnpm 11.8.0、`@deepseek-ai/cordis` ^4.1.0、`@deepseek-ai/dsh-*` 0.1.1-rc.2（由 DSH 自身 resolver 提供，本地以可选 peerDependencies 声明，避免装出第二份旧 settings 包）、`@playwright/mcp@0.0.79`。

### 安全与来源警示（部署前必读）

- 本 skill 描述的注册模板是 **desktop profile**（cordis.patch.yml + desktop-next.*.patch.json），**不含** `danger-full-access`，**不会**把审批策略改为 `never`。
- 上游仓库 `Chengzhibense/Fairy-DSH` 的 `profiles/web/cordis.patch.yml` 是**测试用 web profile 模板**，带有放宽安全的补丁（danger-full-access、审批 never）。**不要**把上游模板直接套用到日常 desktop profile；若要参考上游，只取插件注册思路，安全相关补丁一律保留默认。
- desktop profile 的附加 patch 文件：
  - `desktop-next.cordis.patch.json`：agents-anywhere 桥接的本机绝对路径配置（dshHome、connectorSourceDir、uvPath），换机器需同步修改。
  - `desktop-next.runtime.patch.json`：`desktop-next-webserver` 监听 `127.0.0.1`（port 0 = 随机）；`connection.trustedHosts` 含局域网测试主机 IP（`10.159.68.16`），按需增删。

### 硬件与语音环境要求（GPT-SoVITS）

- NVIDIA GPU：**RTX 50 系（Blackwell）必须 CUDA 12.8+，torch 需 cu128 及以上版本**；旧整合包内置的 torch（cu121 等）在 50 系上无法运行。RTX 30/40 系用 torch cu121 即可；纯 CPU 可跑但合成很慢。
- 第三方「一键整合包」来源不明，不建议安装；建议从 GPT-SoVITS 官方仓库源码安装，torch + 模型约 6–8 GB 磁盘。
- **依赖组合以本仓库 `assets/gpt-sovits-runtime/requirements.txt` 为准**（librosa 0.10.2 / ffmpeg-python / av 系，**不含 torchcodec**）。原机实测：GPT-SoVITS v5 代码 + 该依赖清单可正常推理。
- **torchcodec 坑（Windows 常见）**：若安装流程引入了 torchcodec，其未签名的 `libtorchcodec_core9.dll` 会被 Windows 智能应用控制（Smart App Control）拦截，报 `WinError 4551`。解决：`pip uninstall torchcodec -y`（音频加载自动回退 librosa/ffmpeg），或按上述 requirements 重装依赖。**不要**为此关闭 Smart App Control（关闭不可逆，需重装系统才能再启用）。
- 本 skill 的 `assets/gpt-sovits/voices/Fairy` 是**推理产物**（gpt.ckpt / sovits.pth + 参考声线），只需放进已装好的 GPT-SoVITS 环境即可推理，不需要重新训练。
- 建议部署顺序：先装 GPT-SoVITS 并验证 `127.0.0.1:9880` 能出声（不动 DSH），再接插件。

## 2. 注册清单（cordis.patch.yml）

```yaml
# 基础层（bundle layer 之后应用）
- { id: computer-use-cua-driver-native, disabled: false }
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config: { preference: dark, fontSize: 17 }

# Fairy 插件套件（全部 inject: [clientModules]）
- insert:
    - { id: balance-meter,   name: dsh-balance-meter,   inject: [clientModules] }
    - { id: browser-dock,    name: dsh-browser-dock,    inject: [clientModules] }
    - { id: fairy-startup,   name: dsh-fairy-startup,   inject: [clientModules] }
    - { id: fairy-idle,      name: dsh-fairy-idle,      inject: [clientModules] }
    - { id: fairy-voice,     name: dsh-fairy-voice,     inject: [clientModules] }
    - { id: fairy-visual,    name: dsh-fairy-visual,    inject: [clientModules] }

# Playwright MCP（browser-dock 的代理）
- insert:
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: playwright
        transport: stdio
        command: '<DSH runtime>\node.exe'
        args: ['<fairy-dsh>\browser-dock\dsh-browser-dock\proxy.cjs', --browser, msedge, --headless, --user-data-dir, '<~/.dsh>\browser-dock\pw-profile']

# 默认模型与 preset
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: off }
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config: { default: standard, selectedDefault: cordis }
```

注意事项：

- cordis.patch.yml 必须**无 UTF-8 BOM**（PowerShell `Set-Content -Encoding UTF8` 会加 BOM，导致 profile watcher 不生效）。
- 包带 `dsh.client` manifest 但不带 `dsh.bundle.patch`（注册走 patch 层，与上游 profiles/web 模板一致）。
- pnpm **不安装 link: 目标的依赖**，因此 profile 需要 `pnpm-workspace.yaml` 让插件自己的依赖（mdast-util-*、micromark-extension-gfm、dsh-fairy-contracts）从真实路径解析。

## 3. 设置持久化（0.2.1 移植要点）

DSH 0.1.2 删除了 `settingsNamespace`，0.1.7 删除了 `SettingsService.register`，0.2.1 无客户端 `settingsScope`。因此 dsh-fairy-visual **自建持久化**：

- **宿主**：`GET/POST /fairy-visual/settings` 路由（`ctx.inject(['webServer'])`），落盘 `~/.dsh/fairy-visual/settings.json`（目录 0700、文件 0600、临时文件+rename 原子写）；字段校验 + clamp；未知字段/命名空间 → 400；坏方法 → 405；旧版宿主仍走 settings.register。
- **浏览器**：模块工厂注入适配器，提供 `getSnapshot() → { value }`、`subscribe(fn)`、`set(field, value)`；`localStorage` 镜像让值即时恢复，路由不可用（纯浏览器/403/离线）时仍可用；有 `ctx.settingsScope` 的宿主优先用原生。
- 单事件浅合并（fairy-voice 配置）：按事件合并白名单，只替换本次提供的。

## 4. 恢复步骤（从归档/备份恢复）

0. **必须使用本仓库 `source/` 里的插件源码**（已完成 DSH 0.2.1 移植）。**不要**直接使用上游仓库 `Chengzhibense/Fairy-DSH` 的代码：上游目标为 0.1.1-rc.2，在 DSH Harness（0.2.1）上会出现 `dsh-fairy-visual: pending (waiting for service: settingsScope)`（0.2.1 已无 settingsScope 服务）与 `dsh-fairy-startup: failed`（调用了 0.2.1 已删除的 `sessions.clear()`）。

1. **源码**：`source/` → `C:\Users\<用户>\.dsh\fairy-dsh`，执行 `pnpm install`。
2. **desktop profile**：备份现有 profile，复制 `02_DEPLOYMENT/profiles/desktop` 的 7 个文件 → `~/.dsh/profiles/desktop`，`pnpm install`；检查 cordis.patch.yml 无 BOM；本机绝对路径不同则同步修改。
3. **运行数据**：`fairy-voice` → `~/.dsh/fairy-voice`；`fairy-visual` → `~/.dsh/fairy-visual`（只想恢复硬性功能可先忽略 `sources`；要保留训练过程/候选版本/来源记录则完整复制）。
4. **语音模型**：`04_VOICE_PROFILE/GPT-SoVITS/voices/Fairy` → `D:\GPT-SoVITS\voices\Fairy`；用原 GPT-SoVITS 安装恢复 Python 环境。
5. **启动语音服务**：`D:\GPT-SoVITS\start-api.bat`，服务监听 `http://127.0.0.1:9880`；路径不同则设 `DSH_TTS_VOICES` / `DSH_TTS_START_SCRIPT`。
6. **重启 DSH**（host 代码、profile、依赖变化必须完全重启；仅浏览器端 `lib/client.js` 变化可「应用 → 重新加载界面」）。

### 启动后七项检查

1. 日志中 balance-meter、browser-dock、fairy-startup、fairy-idle、fairy-voice、fairy-visual 全部装载成功。
2. HDD 主题与 Fairy 主视觉出现。
3. 输入框右侧控件位置正确。
4. 「设置 → HDD 视觉与 Fairy 身份」可读写。
5. 「设置 → Fairy 语音」状态区显示 TTS 就绪。
6. 开场动画结束后播放开场白与当前时段问候。
7. 一轮对话结束后听到 Fairy 汇报。

## 5. 测试与验证命令

语音（fairy-voice 包目录）：

```powershell
npm test
```

覆盖：24 触发器 id 唯一/优先级合法；清单与 assets/sounds 44 段 WAV 双向一致；首次启动播种 44 素材（轮询最多 5s，规避慢磁盘竞态）；/status、/manifest、/config、事件音频服务、TTS 路由；白名单过滤/去重/空数组/单事件浅合并；静态服务防目录穿越与清单外文件；配置写回、非法值收敛、未知字段容错；启动语音独立合并；intro 后处理保留换气；24 类交互触发；回合汇报、统一 intro 声线、TTS 失败回落；历史加载不出声、冷却、优先级抢占、开关回归、数据目录迁移。

视觉（fairy-visual 包目录）：

```powershell
node --check .\lib\client.js
node --check .\lib\index.iife.js
node --check .\src\client\index.js
Get-FileHash -Algorithm SHA256 .\lib\client.js,.\lib\index.iife.js
```

两个构建文件 SHA-256 应一致（本次归档值 `DCE18F362A06FCC6507C4D3D596E77679040CEEEA80964D4E0FFCB79AABE4B7A`）。

部署（DEPLOY-NOTES 记录）：host 侧 19 项检查、client 侧 20 项检查、cordis.patch.yml 解析（5 inserts、无重复 id、无 BOM）、隔离 DSH_HOME 真机 E2E（settings GET/POST、未知命名空间 400、boot graph 5 bundles、组合 bundle 含补丁适配器）全部通过；实机桌面 profile 5 插件 `apply … success` 且有余额实取与设置写入验证。

## 6. 排错速查

| 症状 | 排查 |
| --- | --- |
| 设置页没有 Fairy 语音 | cordis.patch.yml + profile `pnpm install` |
| 回合结束没声音 | autoReport、muted、TTS 状态、GPT-SoVITS 服务 |
| 只有部分事件响 | 事件总开关 + 逐段 soundSelections |
| 开场白无声 | /fairy-voice/config 可访问、TTS 120s 内能启动 |
| 浏览器 Dock 空白 | Edge、mcp-playwright 注册、browser-dock/state.json |
| 修改不生效 | host 侧改动需完全重启 DSH（本构建 profile watcher 不触发，日志 `watching []`） |
| 启动报 `web boot: 2 entries did not activate`、`dsh-fairy-startup: failed`、`dsh-fairy-visual: pending (waiting for service: settingsScope)` | 使用了上游 0.1.1 源码的症状。先点「禁用第三方插件、备份 profile patch 并重启」恢复 DSH，然后改用本仓库 `source/` 的 0.2.1 移植版源码重新部署 |
| 主视觉隐藏后仍有脉冲层 | visibility 继承补丁（references/03 §3） |

## 7. 已知限制（DSH 0.2.1）

- 视觉层按 0.1.1 的 slot/ARIA/`.toBottomSlot` 契约编写，逐锚点 fail-closed（最坏是缺样式而非页面崩坏）；HDD 模式在新会话中建议做视觉巡检。
- TTS 依赖 GPT-SoVITS 服务与 `fairy_ref.wav` 参考；未安装时语音 UI 显示不可用（加载时记一次日志）。
- 上游 `.agent-presets/fairy/` 按设计不完整（引用未随包发布的 runtime/world-core 文件），直接复制会得到无法加载的 preset。
