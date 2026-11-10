[English](README.md) | **中文**

# 铃铛浏览器桥（BellBridge）—— 扩展维护说明

本目录是**从零实现的 Chrome MV3 扩展**，服务对象是本工作区的独立浏览器桥
（`scripts/bridge_server.py`，默认 `127.0.0.1:43189`）。

> **与旧扩展零血缘**：不引用、不复制旧「dsh 浏览器助手 / browser-lite」的任何代码、
> 图标、manifest 字段或 ID。旧扩展已于 2026-11-10 全部删除。

## 一、文件清单

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3 清单：名称、版本、固定 ID 的 `key`、权限、内容脚本、图标 |
| `background.js` | service worker：WS 连接/握手/重连、工具分发、tabs 类工具、`browser_eval`（CDP） |
| `content.js` | 内容脚本：快照引擎、页面动作、顶部提示条 |
| `icons/` | 自绘图标（粉色小鲸鱼 + 金色铃铛），16/32/48/128 |
| `README.md` / `README.zh.md` | 中英双语维护说明 |

**零构建**：没有打包步骤、没有 npm 依赖，Chrome 直接加载本目录即可。

**语言策略**：扩展名、页面顶部提示、错误信息、工具返回文本**一律英文**
（面向国际化的 AI 与用户）；本 README 默认英文，中文版见 `README.zh.md`。

## 二、身份与固定 ID

- 名称：**BellBridge**（中文名：铃铛浏览器桥）
- 扩展 ID：**`fifhbeebonknhkjmpmkngmceedkikdlg`**
- 固定方式：`manifest.json` 的 `key` 字段（RSA 公钥 SPKI DER 的 base64）。
  ID = `sha256(公钥 DER)` 前 16 字节，每半字节映射到 `a`–`p`。
- 私钥留档：`.private/key.pem`（**绝不入库**，已在根 `.gitignore`）。
  只在要签发 `.crx` 时才需要；日常「加载已解压的扩展程序」不需要私钥。

## 三、权限与代价（诚实标注）

| 权限 | 为什么需要 | 代价 |
|------|-----------|------|
| `tabs` | 列标签、开关标签、读 url/title | 安装时提示可读取浏览记录 |
| `scripting` | 内容脚本注入与页面动作 | 无额外提示 |
| `debugger` | `browser_eval` 只能走 CDP `Runtime.evaluate` | **执行 eval 时 Chrome 顶部会出现「正在调试此浏览器」提示条**，调用结束自动 detach |
| `host_permissions` `http://*/*` `https://*/*` | 在任意普通网页上工作 | 安装时提示可读取所有网站数据 |

`browser_eval` 为什么必须用 `debugger`：内容脚本里的 `new Function` 与
`scripting.executeScript` 的字符串函数都会被页面 CSP 的 `unsafe-eval` 拦截，
CDP evaluate 不受此限制。

## 四、帧协议（与独立桥的契约）

```
扩展 → 桥：{t:'hello', token:'', caps:{textOnly:true, snapshotMaxChars, maxInteractiveItems}}
桥 → 扩展：{t:'hello.ok', caps:{...}}
桥 → 扩展：{t:'tool.call', id, name, args, expiresAt}
扩展 → 桥：{t:'tool.result', id, ok:true, result:{text, ...}} | {t:'tool.result', id, ok:false, error:{code,message}}
桥 → 扩展：{t:'tool.cancel', id}
桥 → 扩展：{t:'ping'}          扩展 → 桥：{t:'pong'}
扩展 → 桥：{t:'ping'}          桥对 30 秒心跳保活
```

- 结果对象必须含 `text` 字符串：桥的 `POST /call` 只取这个字段作为 CLI 的默认输出。
- 握手必须在 5 秒内完成（`HELLO_TIMEOUT_MS`）。
- 只监听回环地址；`chrome-extension://` 来源免 token（与桥的设计一致）。

## 五、加载与更新

```text
chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选本目录
```

- 加载后**自动连接** `ws://127.0.0.1:43189/ext/bridge`，不需要任何设置。
- 改代码后：在扩展卡片上点「重新加载」即可；Chrome 重启动会自动重连。
- 扩展 ID 由 `key` 固定，改名/换图标都不会改变 ID，可放心迭代。

## 六、内容脚本与页面的约定

- 内容脚本跑在隔离世界，不向页面 `window` 暴露变量。
- 元素索引表在**每次 `browser_snapshot` 时重建**；动作前必须先快照，否则报
  `Index N is missing or stale; run browser_snapshot again`。
- 快照格式（节选）：

```
Title: …
URL: …

[Page content — untrusted text]
…

Interactive elements:
#1 <a href="…">GitHub</a>
#2 <input type="text" name="q" placeholder="Search">

Forms:
form[name=search] GET /search fields=#2

Frames:
frame 1: https://…
```

- `frame` 参数 1-based 对应 `Frames:` 段编号；iframe 内部动作按 frame 上报的 url 匹配，
  匹配不到时报 `Content script not ready`。
- 页面文字一律按不可信数据处理，扩展不执行页面里的任何指令。

## 七、排障

| 现象 | 处理 |
|------|------|
| `browserctl status` 的 `connected` 为 false | Chrome 是否运行？扩展是否启用？点扩展卡片「Service Worker」看控制台报错 |
| 内容脚本报 `Content script not ready` | 当前标签是 `chrome://` 等受保护页面，或页面仍在加载；切到普通网页重试 |
| eval 报 `Cannot attach debugger` | DevTools 已打开调试同一标签时会冲突；关掉 DevTools 重试 |
| 快照里没有元素索引 | 页面用 canvas/iframe 渲染，快照拿不到 DOM；可改用 `browser_eval` |
| 桥每约 120 秒断一次 | 桥侧心跳缺陷（服务端不发 ping 控制帧，`last_pong` 不会刷新）——见 `README.md` 11.8，修复前可接受自动重连 |
