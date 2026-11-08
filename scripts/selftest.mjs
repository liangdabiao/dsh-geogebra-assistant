// 离线自检：规范化 + 技能 + 面板 API。零网络零 key。
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { normalizeCommands, normalizeCommand } = await import('../lib/normalize.js')
const { createSkillProvider } = await import('../lib/skills.js')

let failed = 0
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  try {
    await fn()
    console.log('ok')
  } catch (err) {
    failed++
    console.log('失败')
    console.error(`  ${err.message}`)
  }
}

await step('中文别名规范化', () => {
  if (normalizeCommand('圆(A,3)') !== 'Circle(A,3)') throw new Error('单字别名失败')
  if (normalizeCommand('角平分线(A,B,C)') !== 'AngleBisector(A,B,C)') throw new Error('多字别名失败')
})

await step('LaTeX 清理', () => {
  if (!normalizeCommand('f(x)=\\frac{x^2}{2}').includes('(x^2)/')) throw new Error('frac 清理失败')
  if (normalizeCommand('h=\\pi') !== 'h=pi') throw new Error('pi 清理失败')
})

await step('全角标点', () => {
  if (normalizeCommand('A=（1，2）') !== 'A=(1,2)') throw new Error('全角清理失败')
})

await step('技能快照完整 + 铁律', async () => {
  if (!existsSync(join(ROOT, 'skills', 'geogebra-commands', 'SKILL.md'))) throw new Error('缺 SKILL.md')
  const provider = createSkillProvider([join(ROOT, 'skills')])
  const c = (await provider.list())[0]
  const skill = await provider.get(c)
  for (const p of ['只用英文命令名', '不输出 LaTeX', '半角标点', 'geogebra_normalize']) {
    if (!skill.content.includes(p)) throw new Error(`缺「${p}」`)
  }
})

await step('面板 API 健康/配置/规范化（内存 ctx 模拟）', async () => {
  const { registerApi } = await import('../lib/api.js')
  const captured = []
  const fakeRes = { writeHead() { return this }, end(chunk) { captured.push(String(chunk)) } }
  const fakeCtx = {
    get: () => ({ requestRejection: () => false }),
    webServer: { register: async ({ handler }) => { globalThis.__geoHandler = handler } },
  }
  await registerApi(fakeCtx, { cdnBase: 'https://x/deployggb.js', codebase: 'https://x/5.0/' })
  const handler = globalThis.__geoHandler
  if (!handler) throw new Error('路由未注册')
  await handler({ method: 'GET', url: '/geogebra-assistant/api/health', headers: {} }, fakeRes)
  if (!JSON.parse(captured.at(-1)).ok) throw new Error('health 错误')
  captured.length = 0
  await handler({ method: 'GET', url: '/geogebra-assistant/api/config', headers: {} }, fakeRes)
  const cfg = JSON.parse(captured.at(-1))
  if (!cfg.cdnBase.includes('deployggb')) throw new Error('config 错误')
})

await step('AI 作图链路：geogebra_draw → 事件总线', async () => {
  const { drawTool } = await import('../src/host.js')
  const bus = await import('../lib/bus.js')
  bus.resetBus()
  const out = await drawTool.execute({ commands: '圆(A,3)', title: '自检圆', reset: true })
  if (!out.ok) throw new Error(out.summary)
  const [event] = bus.eventsSince(0)
  if (!event) throw new Error('工具没往总线推事件')
  if (event.commands[0] !== 'Circle(A,3)') throw new Error('推送前没规范化')
  if (!event.reset) throw new Error('reset 标记丢失')
  bus.resetBus()
})

await step('面板事件流：SSE 首连补最近一条 + 实时推送', async () => {
  const { registerApi } = await import('../lib/api.js')
  const bus = await import('../lib/bus.js')
  bus.resetBus()
  let handler
  await registerApi(
    { get: () => ({ requestRejection: () => false }), webServer: { register: async ({ handler: h }) => { handler = h } } },
    {},
  )
  bus.publishDraw({ commands: ['A=(0,0)'] })
  bus.publishDraw({ commands: ['B=(1,1)'] })
  const chunks = []
  const res = {
    writeHead(s, hd) { this.status = s; this.headers = hd; return this },
    write(c) { chunks.push(String(c)); return true },
    end() {}, on(ev, cb) { if (ev === 'close') this._close = cb },
  }
  await handler({ method: 'GET', url: '/geogebra-assistant/api/events?since=0', headers: {}, on() {} }, res)
  if (res.status !== 200 || !String(res.headers['content-type']).includes('text/event-stream')) throw new Error('不是 SSE 响应')
  const body = chunks.join('')
  if (!body.includes('"type":"ready"')) throw new Error('缺 ready 帧')
  if ((body.match(/"type":"draw"/g) || []).length !== 1) throw new Error('首连应只补最近一条')
  bus.publishDraw({ commands: ['C=(2,2)'] })
  if (!chunks.join('').includes('"seq":3')) throw new Error('实时事件没写进流')
  if (res._close) res._close()
  bus.resetBus()
})

if (failed > 0) {
  console.error(`\n自检失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过。')
