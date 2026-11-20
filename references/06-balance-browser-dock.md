# 余额卡片与浏览器 Dock

## 1. DeepSeek 余额卡片（dsh-balance-meter 0.2.0）

- 位置：侧边栏底部（`[data-slot="sidebar.footer.action"] [aria-label^="DeepSeek 余额"]`），由 fairy-visual 统一套用 HDD 卡材质。
- 数据流：宿主路由 `/balance-meter` 读取**本机 DSH 凭据**请求余额与用量；凭据本身不落盘、不进任何归档。
- 卡片布局（HDD 定制）：62px 高、两行四列 grid（第 1 行 4 项等距分布，第 2 行跨前两列），圆角 8px，grain + sheen + 渐变边框材质（同「新会话」按钮材质族）。
- 刷新：客户端调用 `window.dshDesktop.refreshBalance()` 触发重取。
- 与 quota-warning 音效联动：余额低于 `quotaWarningAmount` 阈值时 fairy-voice 触发额度告警音（见 references/02）。

## 2. 浏览器 Dock（dsh-browser-dock 0.1.0）

在 UI 右上角 Dock 中显示 Playwright MCP 驱动的浏览器画面。

### 架构

```
DSH (mcp-playwright client)
  └─ stdio ── proxy.cjs ── node @playwright/mcp/cli.js --browser msedge --headless --user-data-dir <pw-profile>
        └─ 帧与状态写入 ~/.dsh/browser-dock/state.json + frame-N.jpg
             └─ browser-dock 客户端轮询渲染到右上角 Dock
```

- 仅当浏览器会话通过 MCP 被驱动时出现；`browser_close` 后回到 `status: closed`。
- 本机无 Chrome，固定 `--browser msedge` + headless + 独立 `pw-profile` 用户目录（与日常浏览器隔离）。

### proxy.cjs 的 2 处平台补丁（均在文件内标注）

1. Windows 无法执行 `.bin/playwright-mcp` shim → 改为 `process.execPath`（node）执行 `@playwright/mcp/cli.js`。
2. `externalTakeover()` 原为 macOS `/usr/bin/open` → 改为解析本地 Chrome/Edge（或 xdg-open）并记日志，不抛异常。

### 依赖与注册

- `@playwright/mcp@0.0.79` 装在 **`~/.dsh/profiles/web`**（proxy.cjs 无条件从该路径解析 `profiles/web/node_modules/.bin/playwright-mcp`）。
- profile 注册（cordis.patch.yml）：

```yaml
- insert:
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: playwright
        transport: stdio
        command: <DSH runtime node.exe>
        args: [<proxy.cjs 绝对路径>, --browser, msedge, --headless, --user-data-dir, <pw-profile>]
```

### 验证与排错

- 验证：MCP `initialize` 返回 `serverInfo: { name: Playwright, version: 1.63.0-alpha }`；`browser_navigate` 后 `state.json` 变 `active: true, status: ready` 且出现 frame-N.jpg，Dock 渲染出帧。
- 空白 Dock：检查 Edge 安装、`mcp-playwright` 行注册、`~/.dsh/browser-dock/state.json`。
- 用户数据目录（pw-profile）与登录态不入归档、不入 skill（见 references/09）。
