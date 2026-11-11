// 小红书 MCP（Streamable HTTP）客户端。工具名不写死，界面按 tools/list 动态渲染。
// 服务默认跑在电脑上（xiaohongshu-mcp），这里只负责 JSON-RPC 握手、会话、分页和调用。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tr } from './i18n.js'

export const DEFAULT_URL = 'http://127.0.0.1:18060/mcp'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'dsh-media-desk', version: '2.6.2' }
const TIMEOUT = 8000
const TOOLS_TTL = 60_000
const MAX_TOOL_PAGES = 10

// 本地 MCP（Node 版）是 DSH 引擎的子进程：DSH 一重启它就被带走。
// 所以这里做「发现不在就拉起来」，让工作台在 DSH 重启后自动可用。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const SERVICE_SCRIPT = process.env.XHS_MCP_SCRIPT || '/storage/emulated/0/dsh/xhs-work/xhs-mcp-node/server.mjs'
let lastBootAt = 0

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

function healthUrl(url) {
  return `${url.replace(/\/mcp\/?$/, '')}/health`
}

async function serviceAlive(url) {
  try {
    const res = await fetch(healthUrl(url), { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** 本地地址且服务没起来时拉一次，最多等 ~15 秒。 */
async function ensureLocalService(url) {
  if (!isLocalUrl(url)) return false
  if (await serviceAlive(url)) return true
  if (Date.now() - lastBootAt < 15000) return false
  lastBootAt = Date.now()
  if (!existsSync(SERVICE_SCRIPT)) return false
  try {
    // 注意：Android/Termux 上 process.execPath 是 linker64，不是 node；用 argv0（就是 node 路径）
    const nodeBin = /node$/.test(process.argv0 ?? '') ? process.argv0 : 'node'
    const child = spawn(nodeBin, [SERVICE_SCRIPT], {
      cwd: dirname(SERVICE_SCRIPT),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // 本机 Chromium 要走带 LD_PRELOAD 的启动脚本
        XHS_BROWSER_SCRIPT: process.env.XHS_BROWSER_SCRIPT || '/data/data/com.dsharnessmobile.shell/files/home/xhs-browser.sh',
      },
    })
    child.unref()
  } catch {
    return false
  }
  for (let i = 0; i < 30; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (await serviceAlive(url)) return true
  }
  return false
}

/** 带 HTTP 状态码的错误，路由层按 status 回给浏览器。 */
function fail(message, status) {
  return Object.assign(new Error(message), { status })
}

/** 错误消息里绝不能出现 token 明文。 */
function scrub(text, token) {
  return token ? String(text).split(token).join('***') : String(text)
}

/**
 * 解析 SSE 响应体：按空行切帧，取 data: 行拼成 JSON。
 * 注释行（:）和心跳（不是 JSON）忽略。
 * @param {string} text - 响应体。
 * @returns {object[]} 每帧解析出的 JSON-RPC 消息。
 */
function parseSse(text) {
  const messages = []
  let data = []
  const flush = () => {
    if (!data.length) return
    const raw = data.join('\n')
    data = []
    try {
      messages.push(JSON.parse(raw))
    } catch {
      // 心跳或空帧
    }
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  flush()
  return messages
}

/** 在若干帧里挑出 id 匹配的那条。 */
function pickMessage(messages, id) {
  if (id === undefined) return messages.length ? messages[messages.length - 1] : null
  const exact = messages.find(message => message && message.id === id)
  if (exact) return exact
  const loose = messages.find(message => message && String(message.id) === String(id))
  if (loose) return loose
  // 有些服务不原样回 id，只回一条结果
  return messages.find(message => message && (message.result !== undefined || message.error !== undefined)) ?? null
}

/**
 * 创建小红书 MCP 客户端。
 * @param {import('./settings.js').Settings} settings - 设置实例，xhs 段有 url 和 token。
 * @returns {{status: () => Promise<object>, save: (patch?: object) => Promise<object>, call: (payload: object) => Promise<object>}}
 */
export function createXhs(settings) {
  let sessionId = ''
  let initialized = false
  let handshake = null
  let server = null
  let tools = null
  let toolsAt = 0
  let nextId = 1

  /** 清掉会话和工具缓存。 */
  function reset() {
    sessionId = ''
    initialized = false
    handshake = null
    server = null
    tools = null
    toolsAt = 0
  }

  /** 每次都读设置，改了地址或 token 下一个请求就生效。 */
  async function loadConfig() {
    const saved = await settings.read()
    const xhs = saved?.xhs ?? {}
    const rawUrl = typeof xhs.url === 'string' ? xhs.url.trim().replace(/\/+$/, '') : ''
    const token = typeof xhs.token === 'string' ? xhs.token.trim() : ''
    return { url: rawUrl || DEFAULT_URL, token }
  }

  function headersFor(config, withSession) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (config.token) headers.authorization = `Bearer ${config.token}`
    if (withSession && sessionId) headers['mcp-session-id'] = sessionId
    return headers
  }

  function offline(config) {
    return fail(tr('连不上 MCP 服务（{url}）。先在电脑上启动 xiaohongshu-mcp，再把地址填成 http://<电脑局域IP>:18060/mcp', { url: config.url }), 502)
  }

  /**
   * 发一条 JSON-RPC 消息，返回响应和解析出的消息体。
   * @param {{url: string, token: string}} config - 当前配置。
   * @param {object} payload - JSON-RPC 消息。
   * @param {boolean} withSession - 是否带 mcp-session-id 头。
   * @returns {Promise<{res: Response, message: object|null}>}
   */
  async function send(config, payload, withSession) {
    let res
    try {
      res = await fetch(config.url, {
        method: 'POST',
        headers: headersFor(config, withSession),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT),
      })
    } catch {
      initialized = false
      throw offline(config)
    }
    let text = ''
    try {
      text = await res.text()
    } catch {
      initialized = false
      throw offline(config)
    }
    if (res.status === 401 || res.status === 403) {
      initialized = false
      sessionId = ''
      throw fail(tr('MCP 服务拒绝了访问（{status}），检查 token 是否填对', { status: res.status }), 401)
    }
    if (res.status === 404 && withSession) {
      // 会话过期：上层重新 initialize 后重试一次
      initialized = false
      sessionId = ''
      throw Object.assign(fail(tr('MCP 服务说会话已过期'), 404), { sessionExpired: true })
    }
    if (!res.ok) {
      const hint = res.status === 404 ? tr('，检查地址是否以 /mcp 结尾') : ''
      throw fail(tr('MCP 服务返回 HTTP {status}{hint}', { status: res.status, hint }), 502)
    }
    if (res.status === 202 || res.status === 204 || !text.trim()) return { res, message: null }
    let messages
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      messages = parseSse(text)
    } else {
      try {
        messages = [JSON.parse(text)]
      } catch {
        throw fail(tr('MCP 服务返回的内容不是 JSON'), 502)
      }
    }
    const message = pickMessage(messages, payload.id)
    if (payload.id !== undefined && !message) throw fail(tr('MCP 服务没有返回结果'), 502)
    return { res, message }
  }

  function rpcError(config, message) {
    const error = message?.error
    const detail = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : tr('未知错误')
    return fail(scrub(tr('MCP 服务返回错误：{message}', { message: detail }), config.token), 502)
  }

  /** 握手：initialize → 记 session id → notifications/initialized。 */
  async function initialize(config) {
    const { res, message } = await send(config, {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }, false)
    if (!message) throw fail(tr('MCP 服务没有返回握手结果'), 502)
    if (message.error) throw rpcError(config, message)
    const result = message.result ?? {}
    sessionId = res.headers.get('mcp-session-id') ?? ''
    // 无 id 的通知；服务器回 202 空体也算成功
    await send(config, { jsonrpc: '2.0', method: 'notifications/initialized' }, true)
    initialized = true
    server = {
      name: typeof result.serverInfo?.name === 'string' ? result.serverInfo.name : 'xiaohongshu-mcp',
      version: typeof result.serverInfo?.version === 'string' ? result.serverInfo.version : '',
      protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION,
    }
    return server
  }

  async function ensureSession(config) {
    if (initialized) return server
    if (!handshake) {
      handshake = initialize(config).finally(() => {
        handshake = null
      })
    }
    return handshake
  }

  /** 取工具列表，支持 cursor 分页；60 秒内复用缓存。 */
  async function listTools(config) {
    if (tools && Date.now() - toolsAt < TOOLS_TTL) return tools
    const collected = []
    let cursor = ''
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const message = await rpc(config, 'tools/list', cursor ? { cursor } : {})
      const result = message?.result ?? {}
      for (const tool of Array.isArray(result.tools) ? result.tools : []) {
        if (!tool || typeof tool.name !== 'string') continue
        collected.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema ?? null,
        })
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : ''
      if (!cursor) break
    }
    tools = collected
    toolsAt = Date.now()
    return tools
  }

  /** 发一条普通 RPC；会话过期（404）时重新握手并重试一次。 */
  async function rpc(config, method, params) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureSession(config)
        const { message } = await send(config, { jsonrpc: '2.0', id: nextId++, method, params }, true)
        if (message?.error) throw rpcError(config, message)
        return message
      } catch (err) {
        if (err?.sessionExpired && attempt === 0) {
          reset()
          continue
        }
        throw err
      }
    }
    throw fail(tr('MCP 服务没有返回结果'), 502)
  }

  /** 当前配置和连接状态。服务器不可达时返回 connected:false，让界面还能改配置。 */
  async function status() {
    let config = { url: DEFAULT_URL, token: '' }
    const out = { url: DEFAULT_URL, tokenSet: false, connected: false, server: null, tools: [], error: null }
    try {
      config = await loadConfig()
      out.url = config.url
      out.tokenSet = Boolean(config.token)
      await ensureLocalService(config.url)
      await ensureSession(config)
      out.server = server
      out.tools = await listTools(config)
      out.connected = true
    } catch (err) {
      out.error = scrub(err?.message || tr('连不上 MCP 服务（{url}）', { url: config.url }), config.token)
    }
    return out
  }

  /** 保存地址和 token；地址非法直接 400，save 完清缓存并重新探一次状态。 */
  async function save(patch = {}) {
    const next = {}
    if (typeof patch.url === 'string') {
      const url = patch.url.trim().replace(/\/+$/, '')
      if (!/^https?:\/\/\S+$/.test(url)) throw fail(tr('MCP 地址要以 http:// 或 https:// 开头'), 400)
      next.url = url
    }
    if (typeof patch.token === 'string' && patch.token.trim()) next.token = patch.token.trim()
    if (patch.clearToken === true) next.clearToken = true
    await settings.update({ xhs: next })
    reset()
    return status()
  }

  /**
   * 调一个 MCP 工具。工具名不校验，原样转发。
   * @param {{tool: string, arguments?: object}} payload - 工具名和参数。
   * @returns {Promise<{ok: true, tool: string, text: string, data: any|null, raw: object}>}
   */
  async function call(payload = {}) {
    const toolName = typeof payload.tool === 'string' ? payload.tool.trim() : ''
    if (!toolName) throw fail(tr('缺少工具名'), 400)
    const args = payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {}
    const config = await loadConfig()
    // 本地服务被 DSH 重启带走时，这里顺手拉起来（健康检查很轻）
    await ensureLocalService(config.url)
    const message = await rpc(config, 'tools/call', { name: toolName, arguments: args })
    const result = message?.result
    if (!result || typeof result !== 'object') throw fail(tr('MCP 服务没有返回结果'), 502)
    const pieces = (Array.isArray(result.content) ? result.content : []).filter(piece => piece && piece.type === 'text' && typeof piece.text === 'string')
    const text = pieces.map(piece => piece.text).join('\n')
    let data = null
    for (const piece of pieces) {
      try {
        const parsed = JSON.parse(piece.text)
        if (parsed !== null && typeof parsed === 'object') {
          data = parsed
          break
        }
      } catch {
        // 这片不是 JSON，继续找
      }
    }
    if (result.isError === true) throw fail(scrub(text || tr('工具调用失败'), config.token), 400)
    return { ok: true, tool: toolName, text, data, raw: result }
  }

  return { status, save, call }
}