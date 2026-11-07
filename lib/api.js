// 面板数据面：/geogebra-assistant 前缀路由（配置 + 命令规范化接口）。
import { normalizeCommands } from './normalize.js'

const BASE = '/geogebra-assistant'

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
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
            codebase: config?.codebase || 'https://www.geogebra.org/apps/latest/5.0/web3d/',
          })
        }
        if (path === '/api/normalize' && req.method === 'POST') {
          const body = await readJson(req)
          return json(res, 200, { commands: normalizeCommands(String(body.commands || '')) })
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, typeof err?.status === 'number' ? err.status : 500, { error: err?.message || '内部错误' })
      }
    },
  })
}
