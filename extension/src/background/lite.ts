/**
 * browser-lite background: a minimal bridge client for the standalone browser
 * bridge. No side panel, no chat, no approval dialog — it connects to the local
 * bridge automatically, executes the 16 browser tools, and shows a small toast
 * at the top of the page before each action.
 *
 * Reuses the existing tool dispatch (./tools.ts) and content script
 * (../content/lite.ts) so element snapshots and actions behave exactly like the
 * full extension.
 *
 * @module
 */

import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  parseBridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ServerFrame,
  type ToolError,
} from '../protocol.ts'
import {
  dispatchTabManagement,
  dispatchToolCall,
  isTabManagement,
  type ContentBudget,
  type ToolCall,
} from './tools.ts'

/** Fixed local bridge endpoint; the standalone bridge owns this port. */
const BRIDGE_URL = 'ws://127.0.0.1:43189/ext/bridge'

const PING_INTERVAL_MS = 30_000
const HELLO_ACK_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const TOAST_TYPE = 'LITE_TOAST'

type SocketState = 'connecting' | 'connected' | 'reconnecting'

interface PendingCall {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
}

let socket: WebSocket | null = null
let attempt = 0
let running = false
let generation = 0
let caps: BridgeCaps | null = null
let ackTimer: ReturnType<typeof setTimeout> | undefined
let pingTimer: ReturnType<typeof setInterval> | undefined
const pending = new Map<string, PendingCall>()

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function describe(call: ToolCall): string {
  const args = call.args
  switch (call.name) {
    case 'browser_snapshot': return '读取页面'
    case 'browser_get_text': return '读取文本'
    case 'browser_click': return `点击 [${args.index ?? '?'}]`
    case 'browser_type': return `输入到 [${args.index ?? '?'}]`
    case 'browser_press': return `按键 ${String(args.key ?? '')}`
    case 'browser_scroll': return `滚动 ${String(args.direction ?? '')}`
    case 'browser_navigate': return `打开 ${String(args.url ?? '').slice(0, 60)}`
    case 'browser_back': return '返回上一页'
    case 'browser_forward': return '前进下一页'
    case 'browser_reload': return '刷新页面'
    case 'browser_wait': return '等待页面'
    case 'browser_eval': return '执行脚本'
    case 'browser_tab_open': return '打开新标签'
    case 'browser_tab_activate': return '切换标签'
    case 'browser_tab_close': return '关闭标签'
    default: return call.name
  }
}

async function showToast(tabId: number, text: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: TOAST_TYPE, text }, { frameId: 0 })
  } catch {
    // chrome:// pages and pages without the content script: the action will
    // surface its own error; a missing toast is not a failure.
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function budget(): ContentBudget {
  return {
    maxItems: caps?.maxInteractiveItems ?? 60,
    maxChars: caps?.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
  }
}

async function resolveTab(call: ToolCall): Promise<Pick<chrome.tabs.Tab, 'id' | 'url'> | undefined> {
  const raw = call.args.tabId
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    try {
      const tab = await chrome.tabs.get(raw)
      return tab.id === undefined ? undefined : { id: tab.id, url: tab.url }
    } catch {
      return undefined
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return active?.id === undefined ? undefined : { id: active.id, url: active.url }
}

function sendFrame(frame: ClientFrame): boolean {
  const ws = socket
  if (ws === null || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(frame))
  return true
}

function settle(callId: string, answer: { ok: boolean; result?: unknown; error?: ToolError }): void {
  const entry = pending.get(callId)
  if (entry === undefined) return
  pending.delete(callId)
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  if (answer.ok) {
    sendFrame({ t: 'tool.result', id: callId, ok: true, result: answer.result })
  } else {
    sendFrame({ t: 'tool.result', id: callId, ok: false, error: answer.error ?? { code: 'internal', message: 'browser action failed' } })
  }
}

async function runCall(call: ToolCall): Promise<void> {
  if (isTabManagement(call.name)) {
    settle(call.id, await dispatchTabManagement(call))
    return
  }
  const tab = await resolveTab(call)
  if (tab?.id === undefined) {
    settle(call.id, { ok: false, error: { code: 'no-active-tab', message: '标签不存在，或没有可用的活动标签。' } })
    return
  }
  await showToast(tab.id, describe(call))
  const entry = pending.get(call.id)
  const signal = entry?.controller.signal
  const answer = await dispatchToolCall(
    call,
    'auto',
    budget(),
    async () => 'approved',
    signal,
    tab,
    () => true,
  )
  settle(call.id, answer)
}

function handleToolCall(call: ToolCall): void {
  const controller = new AbortController()
  const timer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => controller.abort(), Math.max(0, call.expiresAt - Date.now()))
  pending.get(call.id)?.controller.abort()
  pending.set(call.id, { controller, timer })
  void runCall(call).catch((error: unknown) => {
    settle(call.id, {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  })
}

function cancelCall(callId: string): void {
  const entry = pending.get(callId)
  if (entry === undefined) return
  entry.controller.abort()
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  pending.delete(callId)
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function onServerFrame(frame: ServerFrame): void {
  if (frame.t === 'tool.call') {
    handleToolCall(frame as unknown as ToolCall)
    return
  }
  if (frame.t === 'tool.cancel') {
    cancelCall(frame.id)
    return
  }
  if (frame.t === 'ping') {
    sendFrame({ t: 'pong' })
  }
}

function start(): void {
  stop()
  running = true
  attempt = 0
  generation += 1
  void loop(generation)
}

function stop(): void {
  running = false
  if (ackTimer !== undefined) { clearTimeout(ackTimer); ackTimer = undefined }
  if (pingTimer !== undefined) { clearInterval(pingTimer); pingTimer = undefined }
  socket?.close()
  socket = null
}

async function loop(loopGeneration: number): Promise<void> {
  while (running && loopGeneration === generation) {
    const ws = new WebSocket(BRIDGE_URL)
    socket = ws
    ws.addEventListener('close', () => {
      if (ws !== socket) return
      socket = null
    })

    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('open', () => resolve(true), { once: true })
      ws.addEventListener('close', () => resolve(false), { once: true })
      ws.addEventListener('error', () => resolve(false), { once: true })
    })
    if (!running || loopGeneration !== generation) { ws.close(); return }
    if (!opened) {
      await backoff()
      continue
    }

    ws.send(JSON.stringify({
      t: 'hello',
      token: '',
      caps: {
        textOnly: true,
        snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
        maxInteractiveItems: 60,
      },
    } satisfies ClientFrame))

    const accepted = await new Promise<boolean>((resolve) => {
      const onMessage = (event: MessageEvent): void => {
        const frame = parseBridgeFrame(String(event.data))
        if (frame === undefined) return
        if (frame.t === 'hello.ok') {
          caps = frame.caps
          resolve(true)
          return
        }
        if (frame.t === 'error') resolve(false)
      }
      ws.addEventListener('message', onMessage)
      ws.addEventListener('close', () => resolve(false), { once: true })
      ackTimer = setTimeout(() => resolve(false), HELLO_ACK_TIMEOUT_MS)
    })
    if (ackTimer !== undefined) { clearTimeout(ackTimer); ackTimer = undefined }
    if (!accepted || !running || loopGeneration !== generation) {
      ws.close()
      await backoff()
      continue
    }

    attempt = 0
    ws.addEventListener('message', (event) => {
      const frame = parseBridgeFrame(String(event.data))
      if (frame !== undefined) onServerFrame(frame)
    })
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' } satisfies ClientFrame))
    }, PING_INTERVAL_MS)

    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve(), { once: true })
      ws.addEventListener('error', () => resolve(), { once: true })
    })
    if (pingTimer !== undefined) { clearInterval(pingTimer); pingTimer = undefined }
    if (!running || loopGeneration !== generation) return
    await backoff()
  }
}

async function backoff(): Promise<void> {
  attempt += 1
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  const delay = cap / 2 + Math.random() * (cap / 2)
  await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
}

start()
