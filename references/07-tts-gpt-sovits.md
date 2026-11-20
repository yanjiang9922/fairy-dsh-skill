# GPT-SoVITS 本地 TTS 桥与声线档案

## 1. 架构

- Fairy 语音合成走**本机** GPT-SoVITS API：`http://127.0.0.1:9880`（只监听 127.0.0.1，对话内容与回复不出本机）。
- 客户端把 `{ text, voice, speed, style }` POST 到宿主代理 `/fairy-voice/tts-speak`，宿主转发给 GPT-SoVITS，返回 WAV blob 交 Web Audio 播放器。
- 服务未启动时，插件尝试执行本机启动脚本（`DSH_TTS_START_SCRIPT`）。
- 失败回落：合成/播放失败 → 播放 `success` / `aborted` / `error` 事件音效；无任何结果时保持静默但记录诊断。

## 2. 运行环境（恢复目标机）

| 项 | 值 |
| --- | --- |
| GPT-SoVITS 根目录 | `D:\GPT-SoVITS` |
| 启动脚本 | `D:\GPT-SoVITS\start-api.bat`（`api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`，venv python，日志 api.log） |
| API 端口 | 9880 |
| 环境变量 | `DSH_TTS_VOICES=D:/GPT-SoVITS/voices`、`DSH_TTS_START_SCRIPT=<...>\start-api.bat` |
| 模型目录 | `D:\GPT-SoVITS\voices\Fairy\` |
| 依赖清单 | `GPT-SoVITS-runtime/requirements.txt`（Python 环境本身不入归档，需原装 GPT-SoVITS 恢复） |

## 3. Fairy 声线档案（voices/Fairy）

| 文件 | 用途 |
| --- | --- |
| `gpt.ckpt`（148 MB）/ `sovits.pth`（81 MB） | Fairy 拟合权重（**不可公开再分发**，见 references/09） |
| `ref.wav` / `ref.txt` | 主参考声线；参考文本「了解我会如同主人使唤我一般使唤它，并且让它不敢有怨言。」 |
| `ref-intro.wav` / `.txt` | **当前统一使用的声线锚点**（开场白、时段问候、回合汇报、试听）；参考文本为完整开场白句 |
| `ref-neutral.wav` / `.txt` | 平静待机：「主人，我正在待机。感谢您赐予了我偷懒的机会。」 |
| `ref-warm.wav` / `.txt` | 温和：「如果您想小憩，请允许我挑选曲目。我会用轻音乐和白噪声，编织您的梦。」 |
| `ref-focused.wav` / `.txt` | 专注/任务：「小队成员想重新唤醒您的邦布。……正用复杂的验证码问题拖延时间。」 |
| `ref-alert.wav` / `.txt` | 提醒：「叮咚？门口有您的快递！……没有回应，连快递都无法唤醒您？」 |
| `ref-playful.wav` / `.txt` | 俏皮：「主人，我等待着您从洗手间王者归来。」 |

设计决策：此前按回合结果自动切换 warm/focused/playful/alert 声线会让同一 Fairy 在不同回合像不同角色，与「冷静、稳定」人格目标冲突；因此**全部播报固定使用 `ref-intro`**，其余 5 组参考保留用于后续重训/调音。

## 4. 语速与后处理

- 全局 TTS `speed: 1.06`；开场白内部分段 speed 1 / 0.96（按「根据您签署的用户协议」切分）。
- 后处理：**只压缩超长静音**（异常长空白），保留正常换气与短停顿；不整体压扁句子（会破坏重音与语义边界）。
- 空格是试听稿气口边界；开场白文本不得擅自补标点。

## 5. 参考音频与训练资料（来源）

目录 `~/.dsh/fairy-voice/sources/bilibili/`（仅本机备份，不可再分发）：

- 干净参考声线：《绝区零》Fairy 待机语音合集（BV1KQa3eSE4V）→ 生成 ref-neutral / warm / focused / alert / playful。
- 剧情与性格核对（只用于校对语速、停顿、情绪切换，不作声线锚点）：
  - BV17bno6GEeG（3.3 出场片段）：00:03.9–00:07.4 重逢确认、00:41.0–00:58.6 连续信息汇报、00:70.5–00:76.6 克制致歉、09:11.0–09:18.0 预警语气、12:09.3–12:14.3 快速说明
  - BV1bM4m127tc（「你看，主人你又急」）：00:41.0–00:46.1 平直尾音、01:15.9–01:30.1 递进停顿、03:21.3–03:29.5 降速收尾
  - BV131421k7xW（HDD 挂机彩蛋）：傲娇/腹黑/严肃转折
  - BV15c411r7Py（自述）：「三型总序式集成泛用人工智能」标准自我识别语气
- 候选版本：`final-v2` 至 `final-v7` 多次拟合；开场白、问候、停顿与语速对比文件。
- 取舍记录：剧情实机录音含音乐/环境声/其他角色，直接做声线锚点会降低合成稳定性 → 用干净待机语音做锚点，剧情片段只做节奏校对。

## 6. 快速验证

- 启动 `start-api.bat` 后 `curl http://127.0.0.1:9880` 应可达。
- DSH「设置 → Fairy 语音」状态区显示 TTS 就绪；试听开场白有声。
- 一轮对话结束后听到 Fairy 汇报（未启动服务时回落事件音）。
