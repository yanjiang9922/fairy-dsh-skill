# Fairy-DSH Skill

Fairy-DSH 桌面 AI 助手的**完整功能规格 + 全部运行资产**。将《绝区零》Fairy 的语音人格、HDD 主题界面与启动动画接入 DSH（DeepSeek Desktop），覆盖 7 个插件模块的精确参数、文案、时序与部署方法。

## 内容

| 目录 | 说明 |
| --- | --- |
| `SKILL.md` | Skill 入口：适用场景、模块总览、核心工作流 |
| `source/` | 7 个插件模块的源码（**已移植 DSH 0.2.1**，部署必须用它，勿用上游 0.1.1 代码） |
| `references/` | 10 篇规格文档：语音人格、事件音效目录、HDD 界面、启动动画、待机语音、余额/浏览器 Dock、GPT-SoVITS 桥、部署架构、资产与版权、**Fairy 人格提示词模板** |
| `assets/` | 全部运行资产（约 592 MB）：44 段事件音效、11 段待机语音、B 站声线训练资料、boot.mp4 启动动画、Fairy 声线模型（gpt.ckpt / sovits.pth + 7 组参考声线） |

## 快速使用

**推荐（一步拿全 592MB 资产）**：

```powershell
git lfs install
git clone https://github.com/yanjiang9922/fairy-dsh-skill.git
```

**注意：不要用「Download ZIP」下载整个仓库**——GitHub 的 zip 源码包不含 Git LFS 实体，`gpt.ckpt`、`sovits.pth`、`BV17bno6GEeG.wav` 会变成几百字节的指针壳文件。

如果已经用 zip 下载了仓库：从 [v1.0.0 Release](https://github.com/yanjiang9922/fairy-dsh-skill/releases/tag/v1.0.0) 下载 `fairy-dsh-lfs-assets.zip`（约 309 MB），解压后把其中 3 个文件覆盖到 `assets/` 对应路径即可。

2. 阅读 `SKILL.md` 了解模块结构；按 `references/08-deployment.md` 部署到 DSH Desktop 2.0.19-next。
3. 声线模型放回 `D:\GPT-SoVITS\voices\Fairy`，启动 `start-api.bat`（监听 127.0.0.1:9880）后重启 DSH。

### 测试者网络排错（Windows 常见）

若下载/克隆时遇到 schannel 报错或 github.com 连不上，问题通常在本机网络，与仓库无关：

- **github.com 解析到 127.0.0.1 或可疑 IP**：本机 hosts 文件被加速器（如 Steam++ / Watt Toolkit）写入映射。打开加速器启用 GitHub 加速，或注释掉 hosts 中对应行后执行 `ipconfig /flushdns`。
- **curl / git 报 schannel 错误**（`SEC_E_NO_CREDENTIALS`、`CRYPT_E_NO_REVOCATION_CHECK` 等）：
  - curl 临时规避：`curl --ssl-no-revoke ...`
  - git 规避：`git config --global http.schannelCheckRevoke false`
  - 或改用 Python 请求（`urllib`/`requests` 走 OpenSSL，不依赖 schannel）下载 Release 资产。

## 核心功能

- **Fairy 语音人格**：开场白（分段语速 1/0.96）、四档时段问候、回合结束语音汇报（220 字压缩 + 5 种前缀）、冷静克制语气、统一 intro 声线。
- **事件音效**：24 个触发事件 / 44 段 WAV，优先级抢占、终局互斥、同类不连播、逐段白名单选择。
- **HDD 界面**：深/浅主题精确色板、Fairy 主视觉（眼睛 SVG + glitch 故障效果）、聚合物侧边栏、输入框 Dock 三列胶囊控制区。
- **启动动画**：boot.mp4（约 14s）→ 500ms → 开场白 → 1500ms → 时段问候。
- **本地 TTS**：GPT-SoVITS 仅监听 127.0.0.1，对话内容不出本机。

## 许可与版权

- 文档与配置规格：Apache-2.0（见 LICENSE / NOTICE）。上游源码：github.com/Chengzhibense/Fairy-DSH（Apache-2.0）；音效语义参照 pi-fairy。
- **版权声明**：《绝区零》Fairy 的角色形象、台词与声音权利归 miHoYo / HoYoverse；`assets/` 中的拟合权重、B 站来源音频与启动动画为版权衍生品，仅供个人学习与研究。权利方提出要求时将立即删除对应资产或转私有。
- 本仓库不含任何登录凭据、API Key、Cookie 或用户数据。
