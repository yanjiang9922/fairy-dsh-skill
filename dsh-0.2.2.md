# dsh-0.2.2 分支说明（未实测，需测试者验证反馈）

本分支针对 **DSH 0.2.2-rc.5** 的 composer 兼容问题做了**最小版本闸门**。基线 main 仍面向 0.2.1-rc.2。

## 改动内容

只改了一个文件（两个字节一致的产物）：

`source/fairy-visual/dsh-fairy-visual/lib/client.js` 与 `lib/index.iife.js`

新增 `isDsh022()` 检测（以 0.2.2 特有的 `[data-lexical-editor="true"]` 为标记，并发布到 `globalThis.__DSH_FAIRY_IS_022__`），命中后**三层全部停用**：

1. `restyleComposer()` 直接返回 —— 不再对 composer 卡片写 `display:block / height:132px / padding:0`，不再把输入区 `position:absolute; inset:2px`，不再把模型控件根节点压成 0×0，不再重排发送/添加/权限按钮。
2. `placeVoiceBar()` 直接返回 —— 不再按旧几何绘制右侧语音条。
3. **v2 新增**：`mountComposerDock` 的 `bind()` 与 `markControls()` 直接返回 —— 整个 composer dock 层（标记投影、材质层、眼睛大小/动画速度胶囊、拖拽手柄、workspace 投影、inset 同步、内容锚点、to-bottom 定位）在 0.2.2 上全部不挂载，所有挂在 `[data-dsh-fairy-composer-dock]` 作用域下的破坏性 CSS 因此全部失活。
4. **v3 新增**：dock 的布局 `schedule()` 也直接返回 —— resize 触发的 `sync` 路径不再写 seat 的 `left/width/height` 内联几何，0.2.2 上 seat/卡片保持完全原生。

## 0.2.2 上的预期效果

- 原生 composer 完整保留：两行网格（附件行 + 输入行）、Lexical 编辑器可正常粘贴和聚焦、模型选择器可见（约 150×28）、发送按钮原生。
- 仍生效：HDD 深色主题与背景光晕、Fairy 主视觉（mascot）、44 段事件音效、启动动画、待机语音、余额卡片、`window.fairyPrepare` 启动语音预热桥。
- 已知残留（本分支不处理）：Fairy 眼睛大小/动画速度两个胶囊可能定位在画布右侧外（不影响输入，后续版本再适配）。

## 测试者验证步骤

1. `git fetch && git checkout dsh-0.2.2`，把 `source/` 重新复制到 `~\.dsh\fairy-dsh`（**不要跑 pnpm bundle**）。
2. 完全重启 DSH。
3. 逐项验收：
   - 输入框：连续粘贴图片后点击输入框能聚焦、能继续打字
   - 模型选择器：右下角可见（非 0×28），点击可展开菜单
   - 附件：添加附件后出现在输入框上方独立行，不覆盖编辑器
   - HDD 主题与 Fairy 主视觉正常
   - 事件音效、启动动画正常
4. 把结果（正常项 + 异常项 + 截图）反馈回仓库维护者；若仍有问题，附上新的 outerHTML 证据。

## 回退

`git checkout main` 并重新复制 `source/` 即可回到 0.2.1 基线。
