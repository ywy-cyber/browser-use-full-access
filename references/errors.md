# 错误码与排障（browser-use）

CLI 失败时退出码为 `1`，错误写到 stderr，形如：

```
ERROR: bridge-closed: no browser extension is connected to the bridge
```

| 错误码 | 含义 | 处置 |
|--------|------|------|
| `bridge-closed` | 扩展没连上桥，或连接中途断开 | ① 确认 Chrome 在运行；② `chrome://extensions` 里 BellBridge 已启用且无红色错误；③ 点它的「Service Worker」看控制台；④ 桥是否在跑（`browserctl.py start`） |
| `timeout` | 浏览器动作超时 | `snapshot` 看页面是否卡住；直接重试；持续超时查扩展是否被暂停 |
| `no-active-tab` | 标签不存在，或没有可用的受控标签 | 用 `tab-list` 重新取 id；显式传 `--tab` |
| `content-unavailable` | 页面还没加载完成 / content script 未注入 | `wait --tab <id>` 后再试；或 `navigate` 后等一下 |
| `action-failed` | 动作执行失败（元素已消失、被遮挡等） | 重新 `snapshot` 取最新索引再操作 |
| `bad-args` | 参数不合法 | 对照 `tools` 输出检查参数名与类型 |
| `unauthorized`（HTTP 401） | 缺少/错误 token | 确认 `data/bridge-token` 存在；不要手改 |
| `connected: false`（status） | 桥在跑，但扩展没连 | 同上第一条 |

## 常见现象与顺序

1. **status 显示桥 not running** → 直接执行任意命令会自动拉起；若拉不起，看 `data/bridge.log` 末尾，常见是端口被占（换 `BROWSER_BRIDGE_PORT`）。
2. **status 显示 connected: false** → 多半是 Chrome 没开 / 扩展没加载 / 扩展未启用。
3. **报 `Content script not ready`** → 当前标签是 `chrome://` 等受保护页面，换普通网页。
4. **扩展反复重连（约每 120 秒）** → 桥的心跳缺陷（见 README「已知限制」），不影响 CLI 调用。

## 日志与产物

- 桥日志：`data/bridge.log`
- 令牌：`data/bridge-token`（首次启动自动生成；不要提交、不要外传）
- 这些都在 `.gitignore` 中，不入库。
