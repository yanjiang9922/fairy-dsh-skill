# 界面与 HDD 主题规格

实现集中在 `dsh-fairy-visual` 的 `src/client/index.js`、`style.js`、`mascot-runtime.js`、`mascot-eye-svg.js`、`visual-transitions.js`、`composer-dock.js`、`composer-marker-projection.js`、`composer-material-layer.js`、`composer-attachments.js`、`composer-resize-controller.js`。视觉设置存于 `~/.dsh/fairy-visual/settings.json`。

## 1. 视觉设置（settings.json）

```json
{
  "visual": {
    "version": 2, "enabled": true,
    "theme": "dark",               // dark | light
    "mascotVisible": true,
    "mascotScale": 1,              // clamp 到合法范围（例：5 → 1）
    "mascotAnimationSpeed": 1,     // 0.7x / 1x / 1.5x 三档
    "powerMode": "normal",         // 非法值（如 "turbo"）→ 400 拒绝
    "composerDockHeight": 132
  },
  "identity": {
    "mode": "ling", "customName": "", "secondAssistant": "", "household": []
  }
}
```

设置页位置：**设置 → HDD 视觉与 Fairy 身份** + **设置 → Fairy 语音**；会话头部有 HDD 开关（.dsh-fairy-toggle-group）。

## 2. HDD 主题色板（精确值）

深色（默认，`data-dsh-fairy-theme="dark"`）：

- 背景 `#07101c`；层 1 `#0a1828`；层 2 `#0e243d`；层 3 `#143553`；module-platform `#0b1e34`；overlay `#102944`
- 文字 primary `#e8f2fa` / secondary `#a8bac9` / tertiary `#7f93a5`
- 图标 `#d7e7f3`；边框 l1 `rgba(126,220,255,.3)` / l2 `rgba(126,220,255,.2)`
- 品牌色 `#62d4ff`；主按钮 fill `#1688ce` / hover `#2aa9e8`
- 语义色：sidebar fill 透明；nav-item hover `#0e243d` / active `#143553` / accent `#267fc4`；input-major `#0a1c30`；menu/selector/tip `#0e243d`；bubble `#103052`；button-elevated/floating `#103052`，hover `#17456f`；markdown code-block `#0a1c30`，inline-code `#103052`；scrollbar `#143553` / hover `#267fc4`

浅色（`data-dsh-fairy-theme="light"`）：

- 背景 `#f7fafc`；层 1 `#fff`；层 2 `#edf4f8`；层 3 `#dfebf3`；文字 `#172531` / `#526675` / `#748694`；品牌 `#1688ce`；bubble `#e7f2f9`；对应深色各项均有一组浅色值（同结构）

背景构成（两主题共用结构）：

- 网格：`linear-gradient(rgba(100,210,255,.042) 1.5px, transparent 1.5px)` 双向，48px 间距，opacity .7
- 三块光晕（深色）：glow-a 青 `rgba(96,212,255,.27)`（右上）、glow-b 紫 `rgba(157,132,255,.23)`（右下）、glow-c 紫红 `rgba(174,112,255,.24)`（左上），均 radial-gradient 大椭圆
- 输入框内衬底（input substrate）复用同一背景（background-attachment: fixed），grid 用 `rgba(100,210,255,.0294)`

全局字体覆盖：`html[data-dsh-fairy-visual] body :where(*) { font-weight: 800 }`，`pre/code/kbd/samp` 除外（400）；hero 标题与品牌字 750。品牌字体族：`"Avenir Next","Arial Narrow","DIN Condensed","Microsoft YaHei"`。

## 3. Fairy 主视觉（mascot）

- 根节点 `[data-dsh-fairy-mascot-root]`，SVG 眼型结构（mascot-eye-svg.js）：outer gradient 外圈、sclera halo 巩膜光晕、highlight halo 高光、scanline 扫描线、displacement filter 位移滤镜、thinking / comforting 两种 clip-path 状态。
- 状态过渡（mascot-runtime.js `renderMotionFrame()`）：眼睛各层缩放 + thinking/comforting clip 过渡；动画生命周期按 rAF 驱动。
- 故障效果 `FAULT_TIMING`：`threads` 与 `blocks` 两种 glitch 模式（三层 slice 平移 + clip-path 横切），各有脉冲、间隔、淡入淡出参数。
- 舒适/低电量：powerMode 非 normal 时隐藏（mascot-style.js 的低电量隐藏逻辑）。
- 可见性修复：`.dsh-fairy-pulse-layer` 等层硬编码 `visibility: visible` 会逃逸隐藏祖先，需注入

```css
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-pulse-layer,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-lash-pulse-wave { visibility: inherit !important }
```

- stage：`left: 280px`，宽 `calc(100vw - 280px)`，top 56px，高 48vh，`scale(.94) → 1` 淡入（opacity 460ms cubic-bezier(.16,1,.3,1)）。
- 品牌标（fairy-mark）：38×38 圆形眼睛图标（radial-gradient 同心圆 + 四向 brow 三角），hover scale 1.11；标题 17px/750，副标 9px。侧边栏开关按钮复用同款眼睛（22px 圆）。

## 4. 侧边栏（聚合物材质）

- 静态哑光聚合物板：`--dsh-sidebar-board-color: #3b4148`，纹理 = 细颗粒 radial-gradient ×2 + 顶部高光椭圆 + 纵向 linear-gradient(180deg,#3d434b 0%,#3a4047 52%,#373d44 100%)；浅色为 `#d9dde1` 系。
- 右侧脊线（ridge，10px 宽）：5 段 linear-gradient（contact `#3b434b` → highlight `#5e6973` → face `#4d5660` → shade `#424b54` → edge `#353d45`）+ 三向投影。
- 历史面板：从板上挖出（cutout），`border-radius: 10px`，内阴影 `--dsh-history-cutout-contact/shadow/ambient`；选中会话 `--dsh-selected-fill: rgba(81,90,100,.58)`。
- 覆盖滚动条：隐藏原生 scrollbar，自绘 `.dsh-history-overlay-scrollbar`（10px 宽、thumb 5px 圆角、idle 时 opacity 0）。
- 品牌锚点（fairy-brand-anchor）与「新会话」按钮共用同一卡片材质（grain + sheen + 渐变边框）。

## 5. 输入框 Dock（composer dock）

### 原则

- 通过 DSH 官方 composer seat/card 语义锚点**投影** Fairy 控制区，不复制输入框（保留宿主聚焦/发送/附件/模型菜单/快捷键行为）。
- 输入框卡：`display: grid; grid-template-columns: minmax(176px,max-content) minmax(0,1fr) minmax(176px,max-content)`，`gap: 0 12px`，padding `10px 12px`，完整内描边与背景层；旧局部材质浮层隐藏，灰色框完整包围输入框。
- 左列 = 工作区/模式/权限；中列 = 输入编辑区；右列 = 语音、缩放、动画速度。

### 关键几何常量

- `--dsh-fairy-input-side: 176px`（≤900px 时 132px；≤620px 时 0）
- `--dsh-fairy-input-control-size: 28px`；`--dsh-fairy-input-control-inset: 8px`；`--dsh-fairy-input-control-gap: 4px`；`--dsh-fairy-reasoning-gap: 4px`
- Dock 高度 `composerDockHeight: 132`（设置可调）；顶部 12px 高的 resizer 手柄可拖动调整高度
- Dock 固定 `position: fixed; bottom: 0; z-index: 1`，顶部高光渐变条（highlight/face/shade 3 层 9px）

### 右列胶囊（统一几何：同宽、同高、同边框、同圆角、同材质、垂直排列）

1. **语音控件**（voice control，152px×28px，圆角 999px）：白色卡面（深色主题为 `#30353a` 卡材质 + 渐变边框），内含自动播报开关点（红点 `#e24b4b` 为开）、波形条（2px 宽 bars）、透明音量 range（22px 起）。右缘 `right: 12px; top: -1px`。
2. **缩放滑块**（mascot-scale，152px×24px）：进度轨道 `--dsh-fairy-scale-track: #7898aa`（深色 `#9eb5c4`），thumb 10px 白色圆点 + 2px 描边。位于语音条下方 `top: 31px`。
3. **动画速度滑块**（animation-speed，152px×28px）：三档 detent 0.7x / 1x / 1.5x（tick 位于 left 6px / 50% / calc(100% - 6px)），thumb 为 12px 渐变彩球（radial 多层：#8fcfff → #b997ed → #efa5cc），拖动时 snap 到三档、`transition: left 180ms`。

### 模型与模型强度

- 投影宿主原生 reasoning 控件（`.re-model-trigger`），不重做菜单：显示模型名 + effort + chevron，宽度 220px（≤900px 200px，≤760px 176px），右缘与 Send 保持 gap，名字左扩不挤 chevron；label 类 opacity .72。
- 模型菜单（`.re-model-menu`）深色 `#0e243d` 适配 HDD 主题。
- 发送控件：28px 圆形，定位于输入区右下（`right: 176px; bottom: 6px`）。
- 工作区/模式控件：左列（`left: 12px`，workspace 控件 top 10px、mode 控件 top 52px）；权限控件 `top: 83px`；Command 控件 `left: 179px; bottom: 3px`。

### 响应式断点

- ≤900px：左右列 132px、语音条 108px、reasoning 200px
- ≤760px：reasoning 176px
- ≤620px：单列布局，只留输入区 + Send；隐藏 accessory、tools（除 send）、workspace、command、access、voice 移到顶部右（116px）、scale/speed 隐藏（scale 在 620 下重新显示为 block 以保触摸尺寸）

## 6. Hero 标题与过渡

- Hero 主标题（"…"）：52px / 750 / 白色（浅色 `#172531`），带 4 层文字投影（SVG text fill 透明度 .20/.14/.085/.045，色阶 `#c9dce9 → #5d82a0`）；副标题 15px，两侧 240px 装饰线；≤520px 缩至 30px、装饰线 84px。
- 主题切换：View Transition（`::view-transition-group(dsh-fairy-theme)` 480ms，out 400ms / in 480ms）+ fade 过渡层；会话切换：`dsh-hdd-session-transition` 过渡层。
- `prefers-reduced-motion: reduce` 时全部过渡禁用。

## 7. 设置页结构

- **HDD 视觉与 Fairy 身份**：HDD 开关、主题（dark/light）、主视觉显示、缩放、动画速度、能耗模式（normal 等）、输入框 Dock 高度；身份 mode（ling）/ 自定义名 / 第二助手 / household 列表。
- **Fairy 语音**：见 references/01 与 02（启动语音、时段问候、汇报、逐事件音效选择、试听）。
- 设置读写走 `/fairy-visual/settings` 路由（见 references/08-deployment.md），localStorage 镜像，乐观更新。
