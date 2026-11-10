/**
 * 铃铛浏览器桥 —— background service worker
 *
 * 职责：作为 Chrome 扩展侧的 WebSocket 客户端，连接本机独立桥
 * （默认 ws://127.0.0.1:43189/ext/bridge），接收 tool.call 帧并执行
 * 对应浏览器动作，再回 tool.result 帧。
 *
 * 本文件全部自写：不引用任何第三方包或既有扩展代码，零构建步骤，
 * Chrome 直接加载即可运行。
 *
 * 帧协议（与独立桥约定，见 scripts/bridge_server.py）：
 *   客户端 → 桥：hello / tool.result / pong / ping
 *   桥 → 客户端：hello.ok / tool.call / tool.cancel / ping / error
 */

const BRIDGE_URL = 'ws://127.0.0.1:43189/ext/bridge'
const PING_INTERVAL_MS = 30_000
const HELLO_ACK_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

let socket = null
let phase = 'idle' // idle | handshake | ready
let running = false
let generation = 0
let attempt = 0
let caps = null
let ackTimer = null
let pingTimer = null
let handshakeResolve = null
const pending = new Map() // callId -> { controller, timer }

/** tabId -> Map<frameId, { url }>，由各 frame 的内容脚本上报。 */
const framesByTab = new Map()

// ---------------------------------------------------------------------------
// 帧收发
// ---------------------------------------------------------------------------

function parseFrame(text) {
    try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' && typeof value.t === 'string' ? value : null
    } catch {
        return null
    }
}

function send(frame) {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
}

function toolError(code, message) {
    return { code, message }
}

// ---------------------------------------------------------------------------
// 连接与握手
// ---------------------------------------------------------------------------

function stop() {
    running = false
    generation += 1
    if (ackTimer !== null) { clearTimeout(ackTimer); ackTimer = null }
    if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null }
    if (socket !== null) { try { socket.close() } catch { /* ignore */ } }
    socket = null
    phase = 'idle'
    if (handshakeResolve !== null) { const r = handshakeResolve; handshakeResolve = null; r(false) }
    for (const entry of pending.values()) entry.controller.abort()
    pending.clear()
}

function start() {
    stop()
    running = true
    void loop(generation)
}

async function loop(loopGeneration) {
    while (running && loopGeneration === generation) {
        const ws = new WebSocket(BRIDGE_URL)
        socket = ws
        phase = 'handshake'

        const opened = await new Promise((resolve) => {
            ws.addEventListener('open', () => resolve(true), { once: true })
            ws.addEventListener('error', () => resolve(false), { once: true })
            ws.addEventListener('close', () => resolve(false), { once: true })
        })
        if (!running || loopGeneration !== generation) { try { ws.close() } catch { /* ignore */ } return }
        if (!opened) { await backoff(); continue }

        ws.addEventListener('message', (event) => onMessage(ws, event))
        ws.addEventListener('close', () => { if (ws === socket) { socket = null; phase = 'idle' } })

        const accepted = await handshake(ws)
        if (!accepted || !running || loopGeneration !== generation) {
            try { ws.close() } catch { /* ignore */ }
            await backoff()
            continue
        }

        attempt = 0
        pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }))
        }, PING_INTERVAL_MS)

        await new Promise((resolve) => {
            ws.addEventListener('close', () => resolve(), { once: true })
            ws.addEventListener('error', () => resolve(), { once: true })
        })
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null }
        if (!running || loopGeneration !== generation) return
        await backoff()
    }
}

function handshake(ws) {
    return new Promise((resolve) => {
        handshakeResolve = resolve
        ackTimer = setTimeout(() => {
            if (handshakeResolve !== null) { handshakeResolve = null; resolve(false) }
        }, HELLO_ACK_TIMEOUT_MS)
        ws.send(JSON.stringify({
            t: 'hello',
            token: '',
            caps: {
                textOnly: true,
                snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
                maxInteractiveItems: DEFAULT_MAX_INTERACTIVE_ITEMS,
            },
        }))
    })
}

function onMessage(ws, event) {
    if (ws !== socket) return
    const frame = parseFrame(typeof event.data === 'string' ? event.data : '')
    if (frame === null) return

    if (phase === 'handshake') {
        if (frame.t === 'hello.ok') {
            if (frame.caps !== undefined && frame.caps !== null) caps = frame.caps
            phase = 'ready'
            if (ackTimer !== null) { clearTimeout(ackTimer); ackTimer = null }
            const resolve = handshakeResolve
            handshakeResolve = null
            if (resolve !== null) resolve(true)
        } else if (frame.t === 'error') {
            const resolve = handshakeResolve
            handshakeResolve = null
            if (resolve !== null) resolve(false)
        }
        return
    }

    switch (frame.t) {
        case 'tool.call':
            handleToolCall(frame)
            return
        case 'tool.cancel':
            cancelCall(frame.id)
            return
        case 'ping':
            send({ t: 'pong' })
            return
        default:
            return
    }
}

async function backoff() {
    attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise((resolve) => { setTimeout(resolve, delay) })
}

// ---------------------------------------------------------------------------
// 工具调用生命周期
// ---------------------------------------------------------------------------

function handleToolCall(call) {
    if (typeof call.id !== 'string') return
    const controller = new AbortController()
    const timer = typeof call.expiresAt === 'number'
        ? setTimeout(() => controller.abort(), Math.max(0, call.expiresAt - Date.now()))
        : null
    pending.get(call.id)?.controller.abort()
    pending.set(call.id, { controller, timer })
    void settle(call.id, executeTool(call.name, call.args ?? {}, controller.signal))
}

function cancelCall(callId) {
    if (typeof callId !== 'string') return
    const entry = pending.get(callId)
    if (entry === undefined) return
    entry.controller.abort()
    if (entry.timer !== null) clearTimeout(entry.timer)
    pending.delete(callId)
}

async function settle(callId, promise) {
    const entry = pending.get(callId)
    try {
        const result = await promise
        if (entry === undefined || entry.controller.signal.aborted) return
        send({ t: 'tool.result', id: callId, ok: true, result })
    } catch (error) {
        if (entry !== undefined && entry.controller.signal.aborted) return
        const shaped = error !== null && typeof error === 'object' && typeof error.code === 'string'
            ? { code: error.code, message: String(error.message ?? '') }
            : { code: 'internal', message: error instanceof Error ? error.message : String(error) }
        send({ t: 'tool.result', id: callId, ok: false, error: shaped })
    } finally {
        pending.delete(callId)
        if (entry !== undefined && entry.timer !== null) clearTimeout(entry.timer)
    }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function executeTool(name, args, signal) {
    switch (name) {
        case 'browser_tab_list': {
            const tabs = await chrome.tabs.query({})
            const list = tabs
                .filter((tab) => tab.id !== undefined)
                .map((tab) => ({
                    tabId: tab.id,
                    windowId: tab.windowId,
                    title: tab.title ?? '',
                    url: tab.url ?? '',
                    active: tab.active === true,
                }))
            return { text: JSON.stringify(list, null, 2) }
        }
        case 'browser_tab_open': {
            if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
                throw toolError('bad-args', 'url must be a full http(s) URL')
            }
            const created = await chrome.tabs.create({ url: args.url, active: args.active === true })
            return { text: JSON.stringify({ tabId: created.id, title: created.title ?? '', url: created.url ?? args.url }, null, 2) }
        }
        case 'browser_tab_activate': {
            const tab = await requireTab(args.tabId)
            await chrome.tabs.update(tab.id, { active: true })
            try { await chrome.windows.update(tab.windowId, { focused: true }) } catch { /* 窗口已关闭 */ }
            return { text: `Activated tab ${tab.id}` }
        }
        case 'browser_tab_close': {
            const tab = await requireTab(args.tabId)
            await chrome.tabs.remove(tab.id)
            framesByTab.delete(tab.id)
            return { text: `Closed tab ${tab.id}` }
        }
        case 'browser_navigate': {
            if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
                throw toolError('bad-args', 'url must be a full http(s) URL')
            }
            const tab = await resolveTab(args)
            await chrome.tabs.update(tab.id, { url: args.url })
            return { text: `Navigated to ${args.url}` }
        }
        case 'browser_back':
        case 'browser_forward': {
            const tab = await resolveTab(args)
            const method = name === 'browser_back' ? 'goBack' : 'goForward'
            if (typeof chrome.tabs[method] !== 'function') {
                throw toolError('action-failed', 'This Chrome does not support goBack/goForward')
            }
            try { await chrome.tabs[method](tab.id) } catch { /* 没有可前进/后退的历史 */ }
            return { text: name === 'browser_back' ? 'Went back' : 'Went forward' }
        }
        case 'browser_reload': {
            const tab = await resolveTab(args)
            await chrome.tabs.reload(tab.id)
            return { text: 'Reloaded page' }
        }
        case 'browser_eval':
            return await evalInTab(args)
        default:
            return await pageAction(args, name, args, signal)
    }
}

// ---------------------------------------------------------------------------
// browser_eval：走 chrome.debugger + CDP Runtime.evaluate
//
// 内容脚本里的 new Function 与 scripting.executeScript 的字符串函数都会被
// 页面 CSP 的 unsafe-eval 拦住，CDP evaluate 不受此限制，是唯一可靠的路径。
// ---------------------------------------------------------------------------

function describeJsValue(value) {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    try {
        return JSON.stringify(value, (_key, inner) => (typeof inner === 'function' ? '[function]' : inner), 2)
    } catch {
        return String(value)
    }
}

async function evalInTab(args) {
    if (typeof args.expression !== 'string' || args.expression.trim() === '') {
        throw toolError('bad-args', 'expression must not be empty')
    }
    if (typeof args.frame === 'number' && args.frame > 0) {
        throw toolError('content-unavailable', 'browser_eval supports the main frame only (omit frame)')
    }
    const tab = await resolveTab(args)

    let expression = args.expression
    if (typeof args.index === 'number') {
        let path = null
        try {
            const response = await sendToContent(
                tab.id,
                { type: 'BELL_ACTION', action: '__path', args: { index: args.index } },
                0,
            )
            if (response?.ok === true) path = response.result.path
        } catch {
            path = null
        }
        if (path === null) throw toolError('bad-args', `Index ${args.index} is missing; run browser_snapshot first`)
        expression = `(() => { const el = document.querySelector(${JSON.stringify(path)}); return (${expression}\n); })()`
    }

    const target = { tabId: tab.id }
    let attached = false
    try {
        await chrome.debugger.attach(target, '1.3')
        attached = true
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/already attached|another debugger/i.test(message)) {
            throw toolError('action-failed', `Cannot attach debugger: ${message}`)
        }
    }

    try {
        let evaluated
        try {
            evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
                userGesture: true,
            })
        } catch (error) {
            evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
                expression,
                returnByValue: false,
                awaitPromise: true,
                userGesture: true,
            })
            const described = evaluated?.result?.description ?? evaluated?.result?.type ?? 'undefined'
            if (evaluated?.exceptionDetails !== undefined) {
                const detail = evaluated.exceptionDetails
                throw toolError('action-failed', `Script error: ${detail.text ?? ''} ${detail.exception?.description ?? ''}`.trim())
            }
            return { text: String(described) }
        }
        if (evaluated?.exceptionDetails !== undefined) {
            const detail = evaluated.exceptionDetails
            throw toolError('action-failed', `Script error: ${detail.text ?? ''} ${detail.exception?.description ?? ''}`.trim())
        }
        return { text: describeJsValue(evaluated?.result?.value) }
    } finally {
        if (attached) { try { await chrome.debugger.detach(target) } catch { /* ignore */ } }
    }
}

async function requireTab(tabId) {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
        throw toolError('bad-args', 'tabId must be an integer')
    }
    try {
        return await chrome.tabs.get(tabId)
    } catch {
        throw toolError('no-active-tab', `Tab ${tabId} does not exist`)
    }
}

async function resolveTab(args) {
    if (typeof args.tabId === 'number' && Number.isInteger(args.tabId)) return requireTab(args.tabId)
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active?.id === undefined) throw toolError('no-active-tab', 'No active tab')
    return active
}

// ---------------------------------------------------------------------------
// 页面动作：转交内容脚本
// ---------------------------------------------------------------------------

const PAGE_TOOLS = new Set([
    'browser_snapshot',
    'browser_get_text',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_wait',
    'browser_eval',
])

/**
 * 向内容脚本发消息；失败时动态注入一次再重试。
 * 解决「扩展刚加载/刚更新，已打开的标签页还没注入内容脚本」的问题。
 */
async function sendToContent(tabId, message, frameId) {
    try {
        return await chrome.tabs.sendMessage(tabId, message, { frameId })
    } catch (first) {
        try {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] })
            await new Promise((resolve) => { setTimeout(resolve, 120) })
            return await chrome.tabs.sendMessage(tabId, message, { frameId })
        } catch {
            throw first
        }
    }
}

async function pageAction(tabArgs, name, args, signal) {
    if (!PAGE_TOOLS.has(name)) throw toolError('bad-args', `Unknown tool: ${name}`)
    if (signal.aborted) throw toolError('timeout', 'Call timed out')

    const tab = await resolveTab(tabArgs)
    const frameIndex = typeof args.frame === 'number' && Number.isInteger(args.frame) ? args.frame : 0
    const frameId = await resolveFrameId(tab, frameIndex)
    if (frameId === null) {
        throw toolError('content-unavailable', `Iframe ${frameIndex} not found; run browser_snapshot first`)
    }

    const budget = {
        maxItems: typeof caps?.maxInteractiveItems === 'number' ? caps.maxInteractiveItems : DEFAULT_MAX_INTERACTIVE_ITEMS,
        maxChars: typeof caps?.snapshotMaxChars === 'number' ? caps.snapshotMaxChars : DEFAULT_SNAPSHOT_MAX_CHARS,
    }
    const message = { type: 'BELL_ACTION', action: name, args, budget }

    let response
    try {
        response = await sendToContent(tab.id, message, frameId)
    } catch {
        throw toolError(
            'content-unavailable',
            'Content script not ready (chrome:// pages or still loading). Switch to a normal web page and retry.',
        )
    }
    if (signal.aborted) throw toolError('timeout', 'Call timed out')
    if (response === undefined || response === null || response.ok !== true) {
        const error = response?.error ?? {}
        throw toolError(error.code ?? 'action-failed', error.message ?? 'Page action failed')
    }
    return response.result
}

async function resolveFrameId(tab, frameIndex) {
    if (frameIndex <= 0) return 0
    let iframes = []
    try {
        const response = await sendToContent(tab.id, { type: 'BELL_ACTION', action: '__frames' }, 0)
        if (response?.ok) iframes = response.result?.iframes ?? []
    } catch {
        return null
    }
    const src = iframes[frameIndex - 1]
    if (typeof src !== 'string' || src === '') return null

    const frames = framesByTab.get(tab.id)
    if (frames !== undefined) {
        for (const [frameId, info] of frames) {
            if (frameId === 0) continue
            if (info.url === src || (info.url !== '' && src.startsWith(info.url)) || info.url.startsWith(src)) {
                return frameId
            }
        }
    }
    // 回退：按内容脚本上报顺序取第 frameIndex 个非主 frame。
    if (frames !== undefined) {
        const nonTop = [...frames.keys()].filter((id) => id !== 0)
        if (nonTop.length >= frameIndex) return nonTop[frameIndex - 1]
    }
    return null
}

// ---------------------------------------------------------------------------
// 内容脚本上报（frame 索引）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'BELL_FRAME_READY') return undefined
    if (sender.tab?.id === undefined) return undefined
    let frames = framesByTab.get(sender.tab.id)
    if (frames === undefined) {
        frames = new Map()
        framesByTab.set(sender.tab.id, frames)
    }
    frames.set(sender.frameId ?? 0, { url: sender.url ?? '' })
    return undefined
})

chrome.runtime.onStartup?.addListener(() => { start() })
chrome.runtime.onInstalled?.addListener(() => { start() })

// MV3 的 service worker 会在空闲时被 Chrome 终止；断连后若没有事件唤醒，
// worker 就不再重连。用 30 秒一次的 alarm 定期把 worker 叫醒并补上连接。
chrome.alarms.create('bellbridge-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'bellbridge-keepalive') return
    if (socket === null || phase !== 'ready') start()
})

start()
