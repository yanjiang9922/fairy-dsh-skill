# 资产清单、来源与版权声明

本仓库**包含全部运行资产**（语音、音效、启动动画、声线模型）。使用与再分发前请阅读本文件的版权声明。

## 1. 上游与许可

- 源码上游：`github.com/Chengzhibense/Fairy-DSH`（branch main，2026-11-05 下载），Apache-2.0（LICENSE / NOTICE 随本仓库分发）。
- 事件音效素材：pi-fairy（`github.com/ymd-physics/pi-fairy`）`modules/voice/sounds/`；事件语义照搬其 README。
- NOTICE 声明：Fairy、DSH、DeepSeek、《绝区零》(Zenless Zone Zero) 等名称与标志**不受 Apache-2.0 授权**；游戏文本、官方资产、私有世界数据、用户数据与个人语料按上游约定不随源码仓库分发。

## 2. 本仓库的资产内容（assets/）

| 目录 | 内容 | 大小（约） |
| --- | --- | --- |
| `assets/fairy-voice/sounds/` | 44 段事件音效 WAV | 9.3 MB |
| `assets/fairy-voice/idle/` | 11 段 Fairy 待机语音 WAV | 2.8 MB |
| `assets/fairy-voice/sources/bilibili/` | 声线训练资料：B 站提取音频、ASR 16k、候选与 final-v2…v7 拟合版本、SOURCES.md | 338 MB |
| `assets/fairy-voice/config.json` | 语音运行配置 | <1 KB |
| `assets/fairy-visual/` | boot.mp4 启动动画、boot-fairy-original.wav、settings.json | 8.3 MB |
| `assets/gpt-sovits/voices/Fairy/` | gpt.ckpt / sovits.pth 拟合权重 + 7 组参考声线（wav/txt） | 233 MB |
| `assets/gpt-sovits-runtime/` | start-api.bat、config.py、requirements.txt | <10 KB |

超 100MB 的单文件（`gpt.ckpt`、`BV17bno6GEeG.wav`）通过 **Git LFS** 存储；克隆本仓库需安装 git-lfs（`git lfs install && git clone …`）。**GitHub 的 zip 源码包不含 LFS 实体**：用 zip 下载的仓库中这 3 个文件是指针壳，需从 [v1.0.0 Release](https://github.com/yanjiang9922/fairy-dsh-skill/releases/tag/v1.0.0) 下载 `fairy-dsh-lfs-assets.zip`（约 309 MB）覆盖到 `assets/` 对应路径。

## 3. 版权声明（重要）

- 《绝区零》（Zenless Zone Zero）Fairy 的角色形象、台词与声音权利归 **miHoYo / HoYoverse** 所有。
- `assets/fairy-voice/sources/bilibili/` 中的音频提取自 B 站公开视频，仅用于核对语气、语速、停顿并生成本地试听素材；原视频权利归原作者与权利方。
- `assets/gpt-sovits/voices/Fairy/` 的拟合权重由上述参考音频训练得到，属于角色声音的**衍生品**。
- `assets/fairy-visual/boot.mp4` 与启动音频含受版权保护的视觉/听觉素材。
- 以上资产仅供**个人学习与技术研究**。公开再分发存在版权风险：权利方提出要求时，本仓库应**立即删除对应资产或转为私有**（维护者已确认此处理预案）。
- 本仓库不含：登录凭据、API Key、Cookie、浏览器用户数据、`.credentials.yaml`、任何私有密钥。

## 4. 隐私检查清单（发布前已执行）

- [x] 无 `.credentials.yaml`、API Key、Cookie、私钥。
- [x] 无真实用户名路径（文档统一使用 `<用户>` 占位）。
- [x] 无 pw-profile / localStorage 镜像数据。
- [x] 归档扫描（凭据/私钥/敏感文件名）通过。

## 5. 若要自行重建资产（替代方案）

- 事件音效：从 pi-fairy 上游获取 `modules/voice/sounds/`。
- 待机语音：自行录制替代台词（参考文本见 references/01）。
- 声线模型：按 references/07 §3 的 6 组参考文本在 GPT-SoVITS 用自备干净音频重训。
- 启动动画：按 references/04 的时序规格自制 HDD 风格视频，替换 boot.mp4。
