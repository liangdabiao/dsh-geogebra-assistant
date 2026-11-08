// 命令规范化 + 技能 + 面板 API 单测。零 dsh 依赖零网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { normalizeCommand, normalizeCommands, hasLatex, hasChineseAlias, ALIAS_ENTRIES } = await import('../lib/normalize.js')
const { createSkillProvider } = await import('../lib/skills.js')
const { requestRejection } = await import('../lib/api.js')
const { publishDraw, subscribe, eventsSince, currentSeq, subscriberCount, resetBus } = await import('../lib/bus.js')

test('中文别名 → 英文命令（多字优先）', () => {
  assert.equal(normalizeCommand('圆(A,3)'), 'Circle(A,3)')
  assert.equal(normalizeCommand('球面(A,3)'), 'Sphere(A,3)', '多字别名优先于单字')
  assert.equal(normalizeCommand('球(A,3)'), 'Sphere(A,3)')
  assert.equal(normalizeCommand('线段(A,B)'), 'Segment(A,B)')
  assert.equal(normalizeCommand('中点(A,B)'), 'Midpoint(A,B)')
  assert.equal(normalizeCommand('角平分线(A,B,C)'), 'AngleBisector(A,B,C)')
})

test('全角标点 → 半角', () => {
  assert.equal(normalizeCommand('A=（1，2）'), 'A=(1,2)')
  assert.equal(normalizeCommand('f（x）＝x²＋1'.replace('²', '^2')), 'f(x)=x^2+1')
})

test('LaTeX 清理：frac / sqrt / pi / 上下标', () => {
  assert.equal(normalizeCommand('f(x)=\\frac{x^2}{2}'), 'f(x)=((x^2)/(2))')
  assert.equal(normalizeCommand('g(x)=\\sqrt{2}'), 'g(x)=sqrt(2)')
  assert.equal(normalizeCommand('h=\\pi'), 'h=pi')
  assert.equal(normalizeCommand('A=\\left(1,2\\right)'), 'A=(1,2)')
  assert.equal(normalizeCommand('x^{2}'), 'x^(2)')
})

test('多行命令按行分割并规范化', () => {
  const out = normalizeCommands('A=(0,0)\n线段(A,B)\n圆(A,3)；中点(A,B)')
  assert.deepEqual(out, ['A=(0,0)', 'Segment(A,B)', 'Circle(A,3)', 'Midpoint(A,B)'])
})

test('hasLatex / hasChineseAlias 检测', () => {
  assert.equal(hasLatex('\\frac{1}{2}'), true)
  assert.equal(hasLatex('Circle(A,3)'), false)
  assert.equal(hasChineseAlias('圆(A,3)'), true)
  assert.equal(hasChineseAlias('Circle(A,3)'), false)
})

test('别名表完整（≥30 条，含多字与单字）', () => {
  assert.ok(ALIAS_ENTRIES.length >= 30, `别名 ${ALIAS_ENTRIES.length} 条过少`)
  const zh = ALIAS_ENTRIES.map(([z]) => z)
  assert.ok(zh.includes('角平分线'), '缺多字别名')
  assert.ok(zh.includes('圆'), '缺单字别名')
})

test('技能注册：geogebra-commands 可读取、铁律齐备', async () => {
  const provider = createSkillProvider([join(ROOT, 'skills')])
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'geogebra-commands')
  const skill = await provider.get(candidates[0])
  assert.match(skill.content, /只用英文命令名/, '应含铁律 1')
  assert.match(skill.content, /不输出 LaTeX/, '应含铁律 2')
  assert.match(skill.content, /半角标点/, '应含铁律 3')
  assert.match(skill.content, /Circle/, '应有命令速查')
  assert.match(skill.content, /geogebra_normalize/, '应引工具')
  assert.ok(existsSync(join(ROOT, 'skills', 'geogebra-commands', 'SKILL.md')))
})

test('面板 API 鉴权 fail closed', () => {
  const noService = { get: () => undefined }
  assert.equal(requestRejection(noService, { headers: {} }), false) // 宿主 token 鉴权是边界，服务缺席放行
})

test('作图事件总线：发布 / 订阅 / 增量 / 取消订阅', () => {
  resetBus()
  const seen = []
  const off = subscribe((e) => seen.push(e.seq))
  const a = publishDraw({ commands: ['A=(0,0)', 'B=(1,1)'], title: '测试图' })
  assert.equal(a.seq, 1)
  assert.deepEqual(a.commands, ['A=(0,0)', 'B=(1,1)'])
  assert.equal(a.type, 'draw')
  assert.equal(seen.length, 1, '订阅者应立即收到')
  const b = publishDraw({ commands: 'B=(2,2)' })
  assert.equal(b.seq, 2)
  assert.equal(currentSeq(), 2)
  assert.deepEqual(eventsSince(1).map((e) => e.seq), [2], '只补增量')
  off()
  publishDraw({ commands: ['C=(3,3)'] })
  assert.equal(seen.length, 2, '取消订阅后不应再收到')
  assert.equal(subscriberCount(), 0)
  resetBus()
})

test('作图事件总线：历史最多保留 20 条', () => {
  resetBus()
  for (let i = 0; i < 25; i++) publishDraw({ commands: [`A=(${i},0)`] })
  const all = eventsSince(0)
  assert.equal(all.length, 20, '应裁剪到 20 条')
  assert.equal(all.at(-1).seq, 25, '序号不因裁剪而回退')
  resetBus()
})

test('geogebra_draw 工具：规范化后推送，空输入不推送', async () => {
  resetBus()
  const { drawTool } = await import('../src/host.js')
  const out = await drawTool.execute({ commands: '圆(A,3)\nB=（1，2）', title: '圆', reset: true })
  assert.equal(out.ok, true)
  assert.match(out.summary, /已推送到画板面板/)
  const events = eventsSince(0)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].commands, ['Circle(A,3)', 'B=(1,2)'], '中文别名/全角标点应已规范化')
  assert.equal(events[0].reset, true)
  assert.equal(events[0].title, '圆')

  const empty = await drawTool.execute({ commands: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(eventsSince(0).length, 1, '空命令不应产生事件')
  resetBus()
})

test('面板 API：SSE 首连补最近一条 + 实时推流，pending 走增量', async () => {
  resetBus()
  const { registerApi } = await import('../lib/api.js')
  let handler
  const fakeCtx = {
    get: () => ({ requestRejection: () => false }),
    webServer: { register: async ({ handler: h2 }) => { handler = h2 } },
  }
  await registerApi(fakeCtx, { cdnBase: 'https://x/deployggb.js', codebase: '' })

  // 先画两笔（模拟面板没开时 AI 已经画过图）
  publishDraw({ commands: ['A=(0,0)'] })
  publishDraw({ commands: ['B=(1,1)'] })

  const chunks = []
  const fakeRes = {
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    write(chunk) { chunks.push(String(chunk)); return true },
    end() { this.ended = true },
    on(event, cb) { if (event === 'close') this._onClose = cb },
  }
  const fakeReq = { method: 'GET', url: '/geogebra-assistant/api/events?since=0', headers: {}, on() {} }
  await handler(fakeReq, fakeRes)

  assert.equal(fakeRes.status, 200)
  assert.match(fakeRes.headers['content-type'], /text\/event-stream/)
  const first = chunks.join('')
  assert.ok(first.includes('"type":"ready"'), '应下发 ready')
  assert.equal((first.match(/"type":"draw"/g) || []).length, 1, '首连只补最近一条，不重放历史')
  assert.ok(first.includes('"seq":2'), '补的应是最新那条')

  publishDraw({ commands: ['C=(2,2)'] })
  assert.ok(chunks.join('').includes('"seq":3'), '实时事件应立即写进流')
  if (fakeRes._onClose) fakeRes._onClose()
  assert.equal(subscriberCount(), 0, '连接关闭应退订')

  // pending 轮询：since=2 应只给 3
  const jsonChunks = []
  const jsonRes = { writeHead() { return this }, end(chunk) { jsonChunks.push(String(chunk)) } }
  await handler({ method: 'GET', url: '/geogebra-assistant/api/pending?since=2', headers: {} }, jsonRes)
  const payload = JSON.parse(jsonChunks.at(-1))
  assert.equal(payload.seq, 3)
  assert.deepEqual(payload.events.map((e) => e.seq), [3])
  resetBus()
})
