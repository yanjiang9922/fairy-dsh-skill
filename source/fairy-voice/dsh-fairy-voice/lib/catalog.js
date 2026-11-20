/**
 * dsh-fairy-voice — 触发器目录（唯一真源）。
 *
 * 宿主侧读取本文件生成 `/fairy-voice/manifest`，客户端据此渲染设置面板并按 id 发事件。
 * 客户端不再维护第二份清单：改这里，两端同时生效。
 *
 * 素材来源：https://github.com/ymd-physics/pi-fairy 的 modules/voice/sounds/
 * 事件语义（优先级抢占、终局互斥、同类不连播）照搬该模块 README，见 docs/事件映射.md。
 */

/**
 * 播放优先级。数值大的可以打断数值小的；同级或更高才能抢占。
 * 依据 pi-fairy：high > medium > low。
 */
export const PRIORITY = Object.freeze({ low: 10, medium: 50, high: 100 });

/**
 * 单个触发器的定义。
 *
 * id          事件名（客户端内部事件总线的 topic，也是配置里的开关键）
 * label       设置面板显示名
 * group       设置面板分组
 * priority    播放优先级（PRIORITY 的键）
 * files       候选音频文件；多于一个时按 policy.random 选一个
 * random      'no-repeat-category' = 同类别不连续重复（pi-fairy 语义）
 * cooldownMs  同一事件的最小触发间隔，防止抖动连播
 * bypassMute  true = 静音状态下仍然播放（pi-fairy 里只有 on/off 两个确认音如此）
 * defaultOn   默认是否启用
 * note        设置面板上的辅助说明
 */
export const TRIGGERS = Object.freeze([
  {
    id: 'welcome',
    label: '进入会话',
    group: '生命周期',
    priority: 'medium',
    files: ['welcome-1.wav', 'welcome-2.wav', 'welcome-3.wav', 'welcome-4.wav', 'welcome-5.wav', 'welcome-6.wav', 'welcome-7.wav'],
    random: 'no-repeat-category',
    cooldownMs: 3000,
    defaultOn: true,
    note: '打开一个真实会话时播放（首页与空白会话不触发）',
  },
  {
    id: 'goodbye',
    label: '离开会话',
    group: '生命周期',
    priority: 'medium',
    files: ['goodbye-1.wav', 'goodbye-2.wav', 'goodbye-3.wav', 'goodbye-4.wav', 'goodbye-5.wav', 'goodbye-6.wav'],
    random: 'no-repeat-category',
    cooldownMs: 3000,
    defaultOn: true,
    note: '关闭 / 刷新页面时播放（受浏览器限制可能来不及播完）',
  },
  {
    id: 'task-start',
    label: '任务开始',
    group: '回合',
    priority: 'low',
    files: ['task-start-1.wav', 'task-start-2.wav', 'task-start-3.wav', 'task-start-4.wav'],
    random: 'no-repeat-category',
    cooldownMs: 1500,
    defaultOn: true,
    note: '提交提示词、助手开始工作时播放',
  },
  {
    id: 'success',
    label: '任务成功',
    group: '回合',
    priority: 'high',
    files: ['success-1.wav', 'success-2.wav', 'success-3.wav'],
    random: 'no-repeat-category',
    cooldownMs: 1500,
    defaultOn: true,
    note: '整个回合正常收尾时播放，与中断 / 错误互斥',
  },
  {
    id: 'aborted',
    label: '任务中断',
    group: '回合',
    priority: 'high',
    files: ['aborted.wav'],
    cooldownMs: 1500,
    defaultOn: true,
    note: '回合被手工停止时播放',
  },
  {
    id: 'error',
    label: '一般错误',
    group: '回合',
    priority: 'high',
    files: ['error.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'network-error',
    label: '网络错误',
    group: '回合',
    priority: 'high',
    files: ['network-error.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'retry',
    label: '自动重试',
    group: '回合',
    priority: 'low',
    files: ['retry.wav'],
    cooldownMs: 5000,
    defaultOn: true,
    note: '模型请求失败后自动重试时播放',
  },
  {
    id: 'new-session',
    label: '新建会话',
    group: '会话',
    priority: 'medium',
    files: ['new-session.wav'],
    cooldownMs: 1000,
    defaultOn: true,
  },
  {
    id: 'session-switch',
    label: '切换会话',
    group: '会话',
    priority: 'medium',
    files: ['session-switch.wav'],
    cooldownMs: 1000,
    defaultOn: true,
  },
  {
    id: 'model-switch',
    label: '切换模型',
    group: '会话',
    priority: 'low',
    files: ['model-switch.wav'],
    cooldownMs: 1500,
    defaultOn: true,
    note: '按回合用量上报的模型路由变化推断，可能有延迟',
  },
  {
    id: 'permission',
    label: '权限请求',
    group: '权限',
    priority: 'high',
    files: ['permission-1.wav', 'permission-2.wav', 'permission-3.wav'],
    random: 'no-repeat-category',
    cooldownMs: 2000,
    defaultOn: true,
    note: '出现阻塞式弹窗时播放（授权请求、提问、计划确认都算）；同一弹窗只响一次',
  },
  {
    id: 'permission-approved',
    label: '授权通过',
    group: '权限',
    priority: 'high',
    files: ['permission-approved.wav'],
    cooldownMs: 500,
    defaultOn: true,
    note: '电子提示音，会打断正在播的权限请求音',
  },
  {
    id: 'permission-denied',
    label: '授权拒绝',
    group: '权限',
    priority: 'high',
    files: ['permission-denied.wav'],
    cooldownMs: 500,
    defaultOn: true,
    note: '电子提示音，会打断正在播的权限请求音',
  },
  {
    id: 'context-warning',
    label: '上下文告警',
    group: '上下文',
    priority: 'medium',
    files: ['context-warning.wav'],
    cooldownMs: 60_000,
    defaultOn: true,
    note: '上下文占用越过 80% 时响一次；压缩后回落到阈值以下才重新武装',
  },
  {
    id: 'quota-warning',
    label: '额度告警',
    group: '上下文',
    priority: 'medium',
    files: ['quota-warning.wav'],
    cooldownMs: 300_000,
    defaultOn: true,
    note: '余额低于阈值时响一次，按周期去重',
  },
  {
    id: 'compact-auto',
    label: '自动压缩中',
    group: '压缩',
    priority: 'medium',
    files: ['compact-auto.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'compact-manual',
    label: '手动压缩中',
    group: '压缩',
    priority: 'medium',
    files: ['compact-manual.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'compact-success',
    label: '压缩成功',
    group: '压缩',
    priority: 'medium',
    files: ['compact-success.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'compaction-failed',
    label: '压缩失败',
    group: '压缩',
    priority: 'high',
    files: ['compaction-failed.wav'],
    cooldownMs: 2000,
    defaultOn: true,
  },
  {
    id: 'input',
    label: '输入提示音',
    group: '其他',
    priority: 'low',
    files: ['input.wav'],
    cooldownMs: 500,
    defaultOn: false,
    note: '上游素材表里的通用输入音，pi-fairy 正文未说明用途，默认关闭',
  },
  {
    id: 'activity',
    label: '久坐提醒',
    group: '其他',
    priority: 'low',
    files: ['activity-1.wav', 'activity-2.wav', 'activity-3.wav'],
    random: 'no-repeat-category',
    cooldownMs: 60_000,
    defaultOn: false,
    note: '每小时响一次，默认关闭；间隔见下方「久坐提醒间隔」',
  },
  {
    id: 'voice-on',
    label: '语音已开启',
    group: '开关',
    priority: 'high',
    files: ['voice-on.wav'],
    cooldownMs: 500,
    bypassMute: true,
    defaultOn: true,
    note: '静音状态下也会响 —— 用来确认开关生效',
  },
  {
    id: 'voice-off',
    label: '语音已静音',
    group: '开关',
    priority: 'high',
    files: ['voice-off.wav'],
    cooldownMs: 500,
    bypassMute: true,
    defaultOn: true,
    note: '静音状态下也会响 —— 用来确认开关生效',
  },
]);

/** id -> 触发器定义。 */
export const TRIGGER_BY_ID = Object.freeze(
  Object.fromEntries(TRIGGERS.map((trigger) => [trigger.id, trigger])),
);

/** 全部候选音频文件名（去重）。 */
export const ALL_SOUND_FILES = Object.freeze([
  ...new Set(TRIGGERS.flatMap((trigger) => trigger.files)),
]);

/** 设置面板里的分组顺序。 */
export const GROUPS = Object.freeze([
  '生命周期', '回合', '会话', '权限', '上下文', '压缩', '其他', '开关',
]);

/** 默认配置。宿主侧负责落盘，客户端只读不改结构。 */
export function defaultConfig() {
  return {
    version: 2,
    /** 总开关。关闭后除 bypassMute 事件外全部不发声。 */
    enabled: false,
    /** 静音（等价于 enabled=false，但保留面板状态）。 */
    muted: false,
    /** 0..1 */
    volume: 0.8,
    /** 逐触发器开关。 */
    triggers: Object.fromEntries(TRIGGERS.map((trigger) => [trigger.id, trigger.defaultOn])),
    /** 每个触发器参与随机播放的素材；旧配置缺失时默认全选。 */
    soundSelections: Object.fromEntries(
      TRIGGERS.map((trigger) => [trigger.id, [...trigger.files]]),
    ),
    /** 久坐提醒间隔（分钟）。 */
    activityMinutes: 60,
    /** 上下文告警阈值（0..1）。 */
    contextWarningRatio: 0.8,
    /** 余额告警阈值（与余额同币种）。 */
    quotaWarningAmount: 10,
    /** 音效目录；空 = 用默认目录。 */
    soundsDir: '',
    /** 音效包音量归一：>0 时对素材做峰值归一，1 = 不处理。 */
    packGain: 1,
    /** 每个回合结束后用 Fairy 音色播报一段简短结论。 */
    autoReport: true,
    /** 主页面出现时的启动语音。与事件音效总开关相互独立。 */
    startupVoice: {
      enabled: true,
      preset: 'full',
      customText: '',
      greetingEnabled: true,
      greetingPauseMs: 1500,
    },
    /** 本地 GPT-SoVITS 语音合成。 */
    tts: {
      endpoint: 'http://127.0.0.1:9880',
      voice: 'Fairy',
      speed: 1.06,
    },
  };
}
