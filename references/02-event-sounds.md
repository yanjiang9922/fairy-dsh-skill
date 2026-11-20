# 事件音效完整目录

素材来源：pi-fairy（github.com/ymd-physics/pi-fairy）`modules/voice/sounds/`，共 **44 段 WAV**，覆盖 **24 个触发事件**。32 kHz 单声道，浏览器 `decodeAudioData` 自动重采样。

## 1. 触发器 schema（目录唯一真源）

宿主读 `lib/catalog.js` 生成 `/fairy-voice/manifest`，客户端据此渲染设置面板并发事件。字段：

| 字段 | 含义 |
| --- | --- |
| id | 事件名（事件总线 topic，也是配置开关键） |
| label | 设置面板显示名 |
| group | 分组（生命周期 / 回合 / 会话 / 权限 / 上下文 / 压缩 / 其他 / 开关） |
| priority | `low`(10) / `medium`(50) / `high`(100)，数值大可打断数值小，同级或更高才能抢占 |
| files | 候选音频；多于一个时按 random 策略随机选一 |
| random | `'no-repeat-category'` = 同类随机不连播（最多重试 12 次） |
| cooldownMs | 同一事件最小触发间隔 |
| bypassMute | true = 静音下仍播放（仅 voice-on / voice-off） |
| defaultOn | 默认开关 |
| note | 面板辅助说明 |

**终局互斥**：network-error > error > aborted > success，同回合只响一个。

## 2. 完整 24 事件清单

### 生命周期（medium）

| id | label | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- |
| welcome | 进入会话 | welcome-1..7.wav（7 段） | 3000ms | 打开真实会话时播；首页与空白会话不触发 |
| goodbye | 离开会话 | goodbye-1..6.wav（6 段） | 3000ms | 关闭/刷新页面时播（浏览器可能来不及播完） |

### 回合

| id | label | 优先级 | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- | --- |
| task-start | 任务开始 | low | task-start-1..4.wav | 1500ms | 提交提示词、助手开始工作时播 |
| success | 任务成功 | high | success-1..3.wav | 1500ms | 回合正常收尾；与中断/错误互斥 |
| aborted | 任务中断 | high | aborted.wav | 1500ms | 手工停止时播 |
| error | 一般错误 | high | error.wav | 2000ms | |
| network-error | 网络错误 | high | network-error.wav | 2000ms | |
| retry | 自动重试 | low | retry.wav | 5000ms | 模型请求失败后自动重试 |

### 会话

| id | label | 优先级 | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- | --- |
| new-session | 新建会话 | medium | new-session.wav | 1000ms | |
| session-switch | 切换会话 | medium | session-switch.wav | 1000ms | |
| model-switch | 切换模型 | low | model-switch.wav | 1500ms | 按用量上报的路由变化推断，可能有延迟 |

### 权限

| id | label | 优先级 | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- | --- |
| permission | 权限请求 | high | permission-1..3.wav | 2000ms | 阻塞式弹窗（授权/提问/计划确认）时播；同一弹窗只响一次 |
| permission-approved | 授权通过 | high | permission-approved.wav | 500ms | 电子提示音，会打断正在播的权限请求音 |
| permission-denied | 授权拒绝 | high | permission-denied.wav | 500ms | 同上 |

### 上下文

| id | label | 优先级 | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- | --- |
| context-warning | 上下文告警 | medium | context-warning.wav | 60000ms | 占用越过 80%（`contextWarningRatio`）时响一次；压缩回落阈值以下才重新武装 |
| quota-warning | 额度告警 | medium | quota-warning.wav | 300000ms | 余额低于阈值（`quotaWarningAmount`，同币种）时响一次，按周期去重 |

### 压缩

| id | label | 优先级 | 候选 | 冷却 |
| --- | --- | --- | --- | --- |
| compact-auto | 自动压缩中 | medium | compact-auto.wav | 2000ms |
| compact-manual | 手动压缩中 | medium | compact-manual.wav | 2000ms |
| compact-success | 压缩成功 | medium | compact-success.wav | 2000ms |
| compaction-failed | 压缩失败 | high | compaction-failed.wav | 2000ms |

### 其他 / 开关

| id | label | 优先级 | 候选 | 冷却 | 备注 |
| --- | --- | --- | --- | --- | --- |
| input | 输入提示音 | low | input.wav | 500ms | 默认**关** |
| activity | 久坐提醒 | low | activity-1..3.wav | 60000ms | 默认**关**；间隔 `activityMinutes`（默认 60） |
| voice-on | 语音已开启 | high | voice-on.wav | 500ms | `bypassMute: true`，静音下也响，用于确认开关生效 |
| voice-off | 语音已静音 | high | voice-off.wav | 500ms | `bypassMute: true` |

## 3. 配置结构（`~/.dsh/fairy-voice/config.json`）

```json
{
  "version": 2,
  "enabled": true,          // 总开关；false 时除 bypassMute 外全静音
  "muted": false,           // 静音（等价 enabled=false，但保留面板状态）
  "volume": 0.8,            // 0..1
  "triggers": { "<id>": true },          // 逐事件开关
  "soundSelections": { "<id>": ["<file>"] }, // 每事件白名单
  "activityMinutes": 60,
  "contextWarningRatio": 0.8,   // 0..1
  "quotaWarningAmount": 10,
  "soundsDir": "",          // 空 = 默认目录
  "packGain": 1,            // >0 时峰值归一；1 = 不处理
  "autoReport": true,
  "startupVoice": { "enabled": true, "preset": "full", "customText": "", "greetingEnabled": true, "greetingPauseMs": 1500 },
  "tts": { "endpoint": "http://127.0.0.1:9880", "voice": "Fairy", "speed": 1.06 }
}
```

## 4. 白名单与选择行为

- `soundSelections` 缺失 → 该事件默认全选（旧配置迁移，避免升级后突然无声）。
- 空数组 → 该事件静音。
- 播放只从当前已选素材随机抽取；`no-repeat-category` 避免连播同一段。
- 设置页：事件行内**直接展开**候选（不弹二级窗），每段独立勾选、独立试听；支持全选、全不选、已选数量显示；修改一个事件不影响其他事件（**单事件浅合并**：只替换本次提供的白名单）。

## 5. 播放引擎行为

- Web Audio（AudioContext + GainNode），URL→AudioBuffer 按 URL 缓存。
- 优先级抢占：`active.priority > 新事件 priority` 时拒绝（busy）；否则淡出 20ms 停止并替换。
- 浏览器自动播放策略：页面尚无用户手势时 AudioContext 处于 suspended；事件到来时**排队**，下一次 `pointerdown` / `keydown` 补播（不丢事件）。
- 静音/总开关过滤：bypassMute 事件跳过 enabled/muted/triggers 检查。
- 冷却、清单可用性（manifest.available 不含文件 → missing）都会拦截。
- 诊断：`globalThis.__FAIRY_VOICE_DIAG__`（mounted / audioContextState / subscriptions / events≤14 条 / notes≤40 条 / report），并输出 `DSH_FAIRY_SFX {...}` 日志。
