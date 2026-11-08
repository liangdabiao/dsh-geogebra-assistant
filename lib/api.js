// 面板数据面：/geogebra-assistant 前缀路由。
//   GET  /api/health   健康检查
//   GET  /api/config   CDN / codebase 配置
//   POST /api/normalize 命令规范化
//   GET  /api/events   SSE 作图事件流（模型调 geogebra_draw 后，面板在这里收到命令）
//   GET  /api/pending  轮询兜底：返回 seq > since 的作图事件
import { normalizeCommands } from './normalize.js'
import { currentSeq, eventsSince, subscribe } from './bus.js'

const BASE = '/geogebra-assistant'
const KEEP_ALIVE_MS = 25_000

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false // dsh 0.2.x 宿主已 token 鉴权，服务缺席时放行（fail-closed 会把面板永久 403）
  return connection.requestRejection({ headers: req.headers })
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('只接受 POST'), { status: 405 }))
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return reject(Object.assign(new Error('要 application/json'), { status: 415 }))
    }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      return reject(Object.assign(new Error('拒绝跨站请求'), { status: 403 }))
    }
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return reject(Object.assign(new Error('Origin 与 Host 不同源'), { status: 403 }))
    }
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) { req.destroy(); return reject(Object.assign(new Error('请求体过大'), { status: 413 })) }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * 把一次作图事件转换成本次连接要补发的历史。
 * since=0（页面刚打开、内存里没有进度）只补最近一条，避免重放整段历史把画板搞乱；
 * since>0（断线重连）补上全部缺口。
 */
function replayFor(since) {
  if (since > 0) return eventsSince(since)
  const tail = eventsSince(Math.max(0, currentSeq() - 1))
  return tail.slice(-1)
}

function openEventStream(req, res, url) {
  const since = Number(url.searchParams.get('since') || 0) || 0
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  let closed = false
  const write = (chunk) => {
    if (closed) return false
    try { res.write(chunk); return true } catch { return false }
  }

  write(': connected\n\n')
  write(`data: ${JSON.stringify({ type: 'ready', seq: currentSeq() })}\n\n`)
  for (const event of replayFor(since)) write(`data: ${JSON.stringify(event)}\n\n`)

  const unsubscribe = subscribe((event) => write(`data: ${JSON.stringify(event)}\n\n`))
  const keepAlive = setInterval(() => write(': ka\n\n'), KEEP_ALIVE_MS)
  if (typeof keepAlive.unref === 'function') keepAlive.unref()

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(keepAlive)
    unsubscribe()
    try { res.end() } catch { /* 已断开 */ }
  }
  // 只认「响应被关闭 / 请求被中断」：GET 请求的 req 'end' 会立刻触发，不能用来判连接结束
  res.on?.('close', close)
  req.on?.('aborted', close)
  return close
}

export function registerApi(ctx, config) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })
        const url = new URL(req.url, 'http://x')
        const path = url.pathname.slice(BASE.length) || '/'

        if (path === '/api/health' && req.method === 'GET') {
          return json(res, 200, { ok: true })
        }
        if (path === '/api/config' && req.method === 'GET') {
          return json(res, 200, {
            cdnBase: config?.cdnBase || 'https://www.geogebra.org/apps/deployggb.js',
            codebase: config?.codebase || '',
          })
        }
        if (path === '/api/normalize' && req.method === 'POST') {
          const body = await readJson(req)
          return json(res, 200, { commands: normalizeCommands(String(body.commands || '')) })
        }
        if (path === '/api/events' && req.method === 'GET') {
          openEventStream(req, res, url) // 长连接：不要 end()
          return
        }
        if (path === '/api/pending' && req.method === 'GET') {
          const since = Number(url.searchParams.get('since') || 0) || 0
          return json(res, 200, { seq: currentSeq(), events: replayFor(since) })
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, typeof err?.status === 'number' ? err.status : 500, { error: err?.message || '内部错误' })
      }
    },
  })
}
