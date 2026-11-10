/**
 * 铃铛浏览器桥 —— 内容脚本
 *
 * 在页面隔离世界中执行真实 DOM 动作，并把页面读成结构化文本。
 * 全部自写：不使用任何第三方库；不向页面全局注入可被页面读取的变量。
 */

(() => {
    'use strict'

    const MARK = '__bellbridge_content__'
    if (globalThis[MARK] === true) return
    globalThis[MARK] = true

    const DEFAULT_BUDGET = { maxItems: 60, maxChars: 32_000 }
    const TOAST_MS = 1600
    const SETTLE_QUIET_MS = 500
    const SETTLE_TIMEOUT_MS = 5_000
    const TEXT_NODE_LIMIT = 20_000

    const INTERACTIVE_SELECTOR = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="combobox"]',
        '[role="switch"]',
        '[contenteditable]:not([contenteditable="false"])',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])',
    ].join(',')

    let elements = new Map()
    let paths = new Map()
    const lastSnapshots = new Map()
    let budget = { ...DEFAULT_BUDGET }

    // -----------------------------------------------------------------------
    // 错误
    // -----------------------------------------------------------------------

    class ActionError extends Error {
        constructor(code, message) {
            super(message)
            this.code = code
        }
    }

    function fail(code, message) {
        return new ActionError(code, message)
    }

    // -----------------------------------------------------------------------
    // 基础工具
    // -----------------------------------------------------------------------

    function clamp(value, min, max) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return min
        return Math.min(max, Math.max(min, Math.round(value)))
    }

    function squash(text) {
        return String(text ?? '').replace(/\s+/g, ' ').trim()
    }

    function escapeAttr(value) {
        return JSON.stringify(String(value))
    }

    function sleep(ms) {
        return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    // -----------------------------------------------------------------------
    // 快照
    // -----------------------------------------------------------------------

    function fullText(root) {
        const raw = typeof root.innerText === 'string' && root.innerText !== ''
            ? root.innerText
            : (root.textContent ?? '')
        return raw
            .split('\n')
            .map((line) => line.trim())
            .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
            .join('\n')
            .trim()
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) return false
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        return true
    }

    function cssPath(el) {
        if (el.id !== '') return `#${CSS.escape(el.id)}`
        const parts = []
        let node = el
        let depth = 0
        while (node !== null && node.nodeType === 1 && node !== document.body && node !== document.documentElement && depth < 6) {
            let part = node.tagName.toLowerCase()
            if (node.classList.length > 0) {
                part += [...node.classList].slice(0, 3).map((name) => `.${CSS.escape(name)}`).join('')
            }
            const parent = node.parentElement
            if (parent !== null) {
                const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName)
                if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
            }
            parts.unshift(part)
            node = node.parentElement
            depth += 1
        }
        return parts.length > 0 ? parts.join(' > ') : 'html'
    }

    function describeElement(el, index) {
        const tag = el.tagName.toLowerCase()
        const parts = []
        if (tag === 'a' && el.href) parts.push(`href=${escapeAttr(el.href)}`)
        if (el.type !== undefined && el.type !== '') parts.push(`type=${el.type}`)
        if (el.name) parts.push(`name=${el.name}`)
        if (el.id) parts.push(`id=${el.id}`)
        if (el.placeholder) parts.push(`placeholder=${escapeAttr(el.placeholder)}`)
        const label = el.getAttribute('aria-label') ?? el.getAttribute('title')
        if (label) parts.push(`label=${escapeAttr(label)}`)
        if (el.disabled === true) parts.push('disabled')
        if (el.checked === true) parts.push('checked')
        if (tag === 'input' && el.type === 'password') {
            parts.push('value="[redacted]"')
        } else if (typeof el.value === 'string' && el.value !== '' && tag !== 'button') {
            parts.push(`value=${escapeAttr(el.value.slice(0, 80))}`)
        }
        const text = squash(el.innerText ?? el.textContent ?? '').slice(0, 100)
        if (text !== '') parts.push(escapeAttr(text))
        return `#${index} <${tag}${parts.length > 0 ? ' ' + parts.join(' ') : ''}>`
    }

    function collectElements(root, maxItems) {
        elements = new Map()
        paths = new Map()
        const lines = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null)
        let visited = 0
        let node = walker.currentNode
        while (node !== null && visited < TEXT_NODE_LIMIT) {
            visited += 1
            if (node !== root && node.matches !== undefined && node.matches(INTERACTIVE_SELECTOR) && isVisible(node)) {
                const index = elements.size + 1
                elements.set(index, node)
                paths.set(index, cssPath(node))
                lines.push(describeElement(node, index))
                if (lines.length >= maxItems) break
            }
            node = walker.nextNode()
        }
        return lines
    }

    function listIframes() {
        return [...document.querySelectorAll('iframe, frame')].map((frame) => {
            try {
                return frame.src || frame.getAttribute('src') || ''
            } catch {
                return ''
            }
        })
    }

    function formLines() {
        const lines = []
        for (const form of document.querySelectorAll('form')) {
            const fields = []
            for (const index of elements.keys()) {
                const el = elements.get(index)
                if (el !== undefined && el.form === form) fields.push(`#${index}`)
            }
            if (fields.length === 0) continue
            const name = form.getAttribute('name') ?? form.getAttribute('id') ?? '(unnamed)'
            const action = form.getAttribute('action') ?? ''
            const method = (form.getAttribute('method') ?? 'GET').toUpperCase()
            lines.push(`form[name=${name}] ${method} ${action} fields=${fields.join(' ')}`)
        }
        return lines
    }

    function buildSnapshot(args) {
        let root = document.body
        if (typeof args.region === 'string' && args.region !== '') {
            root = args.region === 'main'
                ? (document.querySelector('main') ?? document.body)
                : document.querySelector(args.region)
            if (root === null) throw fail('bad-args', `Region not found: ${args.region}`)
        }

        const maxItems = clamp(budget.maxItems, 10, 500)
        const maxChars = clamp(budget.maxChars, 500, 200_000)
        const items = collectElements(root, maxItems)
        const pageText = fullText(root)
        const textBudget = Math.max(500, Math.floor(maxChars * 0.6))
        const itemBudget = Math.max(500, maxChars - Math.min(pageText.length, textBudget))

        const segments = []
        segments.push(`Title: ${document.title}`)
        segments.push(`URL: ${location.href}`)
        segments.push('')
        segments.push('[Page content — untrusted text]')
        segments.push(pageText.slice(0, textBudget))
        segments.push('')
        segments.push('Interactive elements:')
        segments.push(...(items.length > 0 ? items.slice(0, Math.ceil(maxItems)) : ['(none)']))

        const forms = formLines()
        if (forms.length > 0) {
            segments.push('')
            segments.push('Forms:')
            segments.push(...forms)
        }

        const iframes = listIframes()
        if (iframes.length > 0) {
            segments.push('')
            segments.push('Frames:')
            iframes.forEach((src, index) => {
                segments.push(`frame ${index + 1}: ${src !== '' ? src : '(about:blank)'}`)
            })
        }

        let text = segments.join('\n')
        if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars]`

        const key = `${location.href}::${typeof args.region === 'string' ? args.region : 'main'}`
        if (args.delta === true) {
            const previous = lastSnapshots.get(key)
            if (previous === text) return { text: '(no changes since previous snapshot)' }
            lastSnapshots.set(key, text)
            if (previous === undefined) return { text }
            let common = 0
            const limit = Math.min(previous.length, text.length)
            while (common < limit && previous[common] === text[common]) common += 1
            const head = text.slice(Math.max(0, common - 200), common)
            return { text: `[delta since previous snapshot]\n…${head}${text.slice(common)}` }
        }
        lastSnapshots.set(key, text)
        return { text }
    }

    // -----------------------------------------------------------------------
    // 动作
    // -----------------------------------------------------------------------

    function elementAt(index) {
        const el = elements.get(index)
        if (el === undefined || !el.isConnected) {
            throw fail('bad-args', `Index ${index} is missing or stale; run browser_snapshot again`)
        }
        return el
    }

    function click(args) {
        const index = Number(args.index)
        const el = elementAt(index)
        el.scrollIntoView({ block: 'center', inline: 'center' })
        if (typeof el.click === 'function') {
            el.click()
        } else {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        }
        const label = squash(el.innerText ?? el.textContent ?? '').slice(0, 60)
        return { text: `Clicked #${index}${label !== '' ? ` "${label}"` : ''}` }
    }

    function typeText(args) {
        const index = Number(args.index)
        const text = String(args.text ?? '')
        const el = elementAt(index)
        el.focus()

        if (el.isContentEditable === true) {
            if (args.replace === true) el.textContent = ''
            const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
            if (!ok) el.textContent = `${el.textContent ?? ''}${text}`
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }))
            return { text: `Typed into #${index} (contenteditable, ${text.length} chars)` }
        }

        const prototype = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null)
        const next = args.replace === true ? text : `${el.value ?? ''}${text}`
        const setter = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter !== undefined) setter.call(el, next)
        else el.value = next
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { text: `Typed into #${index} (${text.length} chars)` }
    }

    function pressKey(args) {
        const key = String(args.key ?? '')
        if (key === '') throw fail('bad-args', 'key must not be empty')
        const index = typeof args.index === 'number' ? args.index : null
        const target = index !== null ? elementAt(index) : (document.activeElement ?? document.body)
        if (typeof target.focus === 'function') target.focus()
        const init = { key, code: key, bubbles: true, cancelable: true, view: window }
        target.dispatchEvent(new KeyboardEvent('keydown', init))
        target.dispatchEvent(new KeyboardEvent('keypress', init))
        target.dispatchEvent(new KeyboardEvent('keyup', init))
        if (key === 'Enter') {
            const form = target.form
            if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit() } catch { /* 表单校验失败时忽略 */ }
            }
        }
        return { text: `Pressed ${key}` }
    }

    function scroll(args) {
        const direction = String(args.direction ?? 'down')
        const amount = typeof args.amount === 'number' && Number.isFinite(args.amount) ? args.amount : 500
        if (direction === 'top') {
            window.scrollTo({ top: 0, behavior: 'instant' })
        } else if (direction === 'bottom') {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
        } else if (direction === 'up') {
            window.scrollBy({ top: -Math.abs(amount), behavior: 'instant' })
        } else {
            window.scrollBy({ top: Math.abs(amount), behavior: 'instant' })
        }
        return { text: `Scrolled ${direction}${direction === 'up' || direction === 'down' ? ` ${Math.abs(amount)}px` : ''}` }
    }

    function getText(args) {
        const selector = typeof args.selector === 'string' ? args.selector : ''
        const root = selector === '' ? document.body : document.querySelector(selector)
        if (root === null) throw fail('bad-args', `Selector not found: ${selector}`)
        const maxChars = clamp(budget.maxChars, 500, 200_000)
        return { text: fullText(root).slice(0, maxChars) }
    }

    function waitUntil(predicate, timeoutMs) {
        return new Promise((resolve) => {
            const started = Date.now()
            const timer = setInterval(() => {
                if (predicate() || Date.now() - started >= timeoutMs) {
                    clearInterval(timer)
                    resolve()
                }
            }, 100)
        })
    }

    function waitDomQuiet(quietMs, timeoutMs) {
        return new Promise((resolve) => {
            let lastChange = Date.now()
            const observer = new MutationObserver(() => { lastChange = Date.now() })
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            })
            const started = Date.now()
            const timer = setInterval(() => {
                const now = Date.now()
                if (now - lastChange >= quietMs || now - started >= timeoutMs) {
                    clearInterval(timer)
                    observer.disconnect()
                    resolve()
                }
            }, 100)
        })
    }

    async function waitForSettle(args) {
        await waitUntil(() => document.readyState === 'complete', SETTLE_TIMEOUT_MS)
        await waitDomQuiet(SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS)
        const extra = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
        if (extra > 0) await sleep(extra)
        return { text: `Page settled${extra > 0 ? ` (+${extra}ms)` : ''}` }
    }

    function framesInfo() {
        return { iframes: listIframes() }
    }

    function pathOf(index) {
        const path = paths.get(index)
        if (path === undefined) throw fail('bad-args', `Index ${index} is missing; run browser_snapshot first`)
        return { path }
    }

    async function runAction(action, args) {
        switch (action) {
            case 'browser_snapshot':
                return buildSnapshot(args)
            case 'browser_get_text':
                return getText(args)
            case 'browser_click':
                return click(args)
            case 'browser_type':
                return typeText(args)
            case 'browser_press':
                return pressKey(args)
            case 'browser_scroll':
                return scroll(args)
            case 'browser_wait':
                return await waitForSettle(args)
            case '__frames':
                return framesInfo()
            case '__path':
                return pathOf(Number(args.index))
            default:
                throw fail('bad-args', `Unknown action: ${action}`)
        }
    }

    // -----------------------------------------------------------------------
    // 顶部提示条
    // -----------------------------------------------------------------------

    let toastHost = null
    let toastTimer = null

    function showToast(text) {
        if (toastHost === null || !toastHost.isConnected) {
            toastHost = document.createElement('div')
            toastHost.id = 'bellbridge-toast'
            toastHost.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;'
            const shadow = toastHost.attachShadow({ mode: 'open' })
            const box = document.createElement('div')
            box.style.cssText = [
                'max-width:70vw',
                'padding:8px 14px',
                'border-radius:10px',
                'background:rgba(24,18,26,0.9)',
                'color:#ffe6f2',
                'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
                'box-shadow:0 6px 20px rgba(0,0,0,0.28)',
                'border:1px solid rgba(255,190,220,0.35)',
                'white-space:nowrap',
                'overflow:hidden',
                'text-overflow:ellipsis',
                'opacity:0',
                'transition:opacity 140ms ease',
            ].join(';')
            shadow.appendChild(box)
            document.documentElement.appendChild(toastHost)
        }
        const box = toastHost.shadowRoot?.firstElementChild
        if (box === null || box === undefined) return
        box.textContent = `BellBridge: ${text}`
        box.style.opacity = '1'
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
            box.style.opacity = '0'
            toastTimer = setTimeout(() => {
                toastHost?.remove()
                toastHost = null
            }, 200)
        }, TOAST_MS)
    }

    // -----------------------------------------------------------------------
    // 消息入口
    // -----------------------------------------------------------------------

    function describeAction(message) {
        const args = message.args ?? {}
        switch (message.action) {
            case 'browser_snapshot': return 'Reading page'
            case 'browser_get_text': return 'Reading text'
            case 'browser_click': return `Clicking #${args.index}`
            case 'browser_type': return `Typing into #${args.index}`
            case 'browser_press': return `Pressing ${args.key}`
            case 'browser_scroll': return `Scrolling ${args.direction}`
            case 'browser_wait': return 'Waiting for page'
            default: return String(message.action ?? '')
        }
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message === null || typeof message !== 'object') return undefined
        if (message.type === 'BELL_TOAST') {
            showToast(String(message.text ?? ''))
            sendResponse({ ok: true })
            return undefined
        }
        if (message.type !== 'BELL_ACTION') return undefined

        if (message.budget !== undefined && message.budget !== null) {
            budget = { ...DEFAULT_BUDGET, ...message.budget }
        }
        const action = String(message.action ?? '')
        if (action !== '__frames' && action !== '__path') {
            showToast(describeAction(message))
        }
        void runAction(action, message.args ?? {}).then(
            (result) => { sendResponse({ ok: true, result }) },
            (error) => {
                const code = error instanceof ActionError ? error.code : 'action-failed'
                const text = error instanceof Error ? error.message : String(error)
                sendResponse({ ok: false, error: { code, message: text } })
            },
        )
        return true
    })

    try { chrome.runtime.sendMessage({ type: 'BELL_FRAME_READY' }) } catch { /* 扩展上下文已失效 */ }
})()
