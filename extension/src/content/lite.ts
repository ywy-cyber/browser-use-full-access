/**
 * browser-lite content script: executes page actions for the minimal bridge and
 * renders the top-of-page toast before each action. Unlike the full extension
 * it has no selection watcher and no panel chatter.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '../protocol.ts'
import { runAction, ActionError } from './actions.ts'
import { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'

const ids = new ElementIds()
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const LISTENER_KEY = '__browserLiteListener__'
const TOAST_KEY = '__browserLiteToast__'

interface ToolResult {
  ok: boolean
  result?: { text: string; pageContent?: string; navigationPending?: boolean }
  error?: { code: string; message: string }
}

interface LiteGlobal {
  __browserLiteListener__?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: ToolResult | { ok: true }) => void) => true | undefined
  __browserLiteToast__?: { show: (text: string) => void; dispose: () => void }
}

function createToast(): { show: (text: string) => void; dispose: () => void } {
  let host: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function ensureHost(): HTMLDivElement {
    if (host !== null && host.isConnected) return host
    host = document.createElement('div')
    host.id = 'browser-lite-toast'
    Object.assign(host.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      maxWidth: '70vw',
      padding: '8px 14px',
      borderRadius: '8px',
      background: 'rgba(20, 20, 20, 0.88)',
      color: '#fff',
      font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 160ms ease',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    document.documentElement.appendChild(host)
    return host
  }

  return {
    show(text: string): void {
      const element = ensureHost()
      element.textContent = `浏览器操作：${text}`
      element.style.opacity = '1'
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        element.style.opacity = '0'
        timer = setTimeout(() => {
          element.remove()
          host = null
        }, 200)
      }, 1600)
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer)
      host?.remove()
      host = null
    },
  }
}

function onMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: ToolResult | { ok: true }) => void,
): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  const global = globalThis as typeof globalThis & LiteGlobal

  if (msg.type === 'LITE_TOAST') {
    const text = typeof (message as { text?: unknown }).text === 'string'
      ? (message as { text: string }).text
      : ''
    if (text !== '') global[TOAST_KEY]?.show(text)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) budget = { ...budget, ...incoming }
    sendResponse({ ok: true })
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true
}

const liteGlobal = globalThis as typeof globalThis & LiteGlobal
liteGlobal.__browserLiteToast__?.dispose()
if (liteGlobal.__browserLiteListener__ !== undefined) {
  try { chrome.runtime.onMessage.removeListener(liteGlobal.__browserLiteListener__) } catch { /* stale context */ }
}
liteGlobal.__browserLiteListener__ = onMessage
liteGlobal.__browserLiteToast__ = createToast()
chrome.runtime.onMessage.addListener(onMessage)
