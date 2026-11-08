// 面板 DOM 冒烟（可选依赖）：把真实 dist/client.js 挂进 jsdom，喂一条 AI 作图事件，
// 验证「事件 → 自动 evalCommand → 面板文案更新」链路。
//
// 依赖 jsdom + react + react-dom（devDependencies）。未安装时本文件自动跳过，
// 主测试集（test/lib.test.mjs）不受影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(join(ROOT, 'package.json'))

let deps = null
try {
  deps = {
    JSDOM: require_('jsdom').JSDOM,
    React: require_('react'),
    createRoot: require_('react-dom/client').createRoot,
    act: require_('react').act,
  }
} catch {
  deps = null
}

test('面板 AI 作图链路（jsdom）', { skip: deps ? false : '未安装 jsdom/react/react-dom，跳过（npm i -D jsdom react react-dom 后可跑）' }, async () => {
  const { JSDOM, React, createRoot, act } = deps
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://127.0.0.1:61448/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  globalThis.HTMLElement = window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  // GeoGebra 桩：记录调用，注入时立刻回调 appletOnLoad
  const applets = []
  window.GGBApplet = function GGBApplet(params) {
    const applet = this
    applet.calls = []
    applet.resets = 0
    applet.evalCommand = (cmd) => { applet.calls.push(cmd); return true }
    applet.newConstruction = () => { applet.resets++; applet.calls.length = 0 }
    applet.setHTML5Codebase = (url) => { applet.codebase = url }
    applet.inject = () => { window.ggbApplet = applet; params.appletOnLoad() }
    applets.push(applet)
  }

  globalThis.fetch = window.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({ cdnBase: 'https://www.geogebra.org/apps/deployggb.js', codebase: '' }) }
    }
    if (target.includes('/api/normalize')) {
      const body = JSON.parse(init?.body || '{}')
      return { ok: true, status: 200, json: async () => ({ commands: String(body.commands || '').split('\n').filter(Boolean) }) }
    }
    return { ok: true, status: 200, json: async () => ({ seq: 0, events: [] }) }
  }

  const streams = []
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; FakeEventSource.last = this; streams.push(url) }
    close() { this.closed = true }
  }
  globalThis.EventSource = window.EventSource = FakeEventSource

  let factory = null
  window.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f } }
  new Function(readFileSync(join(ROOT, 'dist', 'client.js'), 'utf8'))()
  const mod = factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`bundle 请求了白名单外的模块：${spec}`)
  })

  let Panel = null
  mod.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (desc, comp) => { if (desc.name === 'main') Panel = comp },
    },
  })
  assert.equal(typeof Panel, 'function', '面板组件应注册到 main slot')

  const tick = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }

  const root = createRoot(document.getElementById('app'))
  await act(async () => { root.render(React.createElement(Panel)) })
  await tick()

  assert.equal(applets.length, 1, '画板应被注入')
  assert.equal(applets[0].codebase, undefined, 'codebase 留空时不应硬塞')
  assert.ok(streams[0]?.includes('/api/events?since=0'), '应连上事件流')
  await act(async () => { FakeEventSource.last.onopen?.() })
  assert.match(document.body.textContent, /AI 通道已连接/)

  const commands = ['A=(0,0)', 'B=(4,0)', 'C=(0,3)', 'Segment(A,B)', 'Segment(B,C)', 'Segment(C,A)']
  await act(async () => {
    FakeEventSource.last.onmessage({ data: JSON.stringify({ seq: 1, type: 'draw', commands, reset: true, title: '直角三角形' }) })
  })
  const applet = window.ggbApplet
  assert.equal(applet.resets, 1, 'reset=true 应先清空')
  assert.deepEqual(applet.calls, commands, '应逐条执行')
  assert.equal(document.querySelector('textarea')?.value, commands.join('\n'), '命令应回填输入框')
  assert.match(document.body.textContent, /AI 作图/)
  assert.match(document.body.textContent, /6 条命令全部执行成功/)

  // 同 seq 去重
  await act(async () => {
    FakeEventSource.last.onmessage({ data: JSON.stringify({ seq: 1, type: 'draw', commands, reset: true }) })
  })
  assert.equal(applet.resets, 1, '同 seq 不应重复执行')

  // 增量事件
  await act(async () => {
    FakeEventSource.last.onmessage({ data: JSON.stringify({ seq: 2, type: 'draw', commands: ['D=(5,5)'], reset: false }) })
  })
  assert.equal(applet.resets, 1, 'reset=false 不应清空')
  assert.ok(applet.calls.includes('D=(5,5)'), '增量命令应执行')

  // ---- 失败自动回滚：有失败 → 还原快照；可手动保留成功部分；可关掉开关 ----
  applet.xmlRestores = []
  applet.getXML = () => '<construction id="snap"/>'
  applet.setXML = (xml) => { applet.xmlRestores.push(xml) }
  applet.evalCommand = (cmd) => { applet.calls.push(cmd); return cmd !== 'BAD(A)' }

  await act(async () => {
    FakeEventSource.last.onmessage({
      data: JSON.stringify({ seq: 3, type: 'draw', commands: ['A=(0,0)', 'BAD(A)', 'B=(1,1)'], reset: false }),
    })
  })
  assert.equal(applet.xmlRestores.length, 1, '有失败时应回滚一次')
  assert.equal(applet.xmlRestores[0], '<construction id="snap"/>', '回滚应使用执行前的快照')
  assert.match(document.body.textContent, /已回滚/)

  const keepBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('保留成功的'))
  assert.ok(keepBtn, '应提供「保留成功的 N 条」按钮')
  assert.match(keepBtn.textContent, /保留成功的 2 条/)

  const callsBeforeRetry = applet.calls.length
  await act(async () => {
    keepBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })
  assert.deepEqual(applet.calls.slice(callsBeforeRetry), ['A=(0,0)', 'B=(1,1)'], '只重放成功的命令')
  assert.match(document.body.textContent, /2 条命令全部执行成功/)

  const rollbackBox = document.querySelector('input[type="checkbox"]')
  assert.ok(rollbackBox, '应有「失败自动回滚」开关')
  await act(async () => { rollbackBox.click() })
  await act(async () => {
    FakeEventSource.last.onmessage({ data: JSON.stringify({ seq: 4, type: 'draw', commands: ['BAD(X)'], reset: false }) })
  })
  assert.equal(applet.xmlRestores.length, 1, '关掉开关后不应再回滚')

  // ---- 导出：.ggb / PNG / SVG / TikZ（引擎原生）+ TikZ 快照兜底 ----
  const downloads = []
  const originalCreate = globalThis.URL.createObjectURL
  const originalRevoke = globalThis.URL.revokeObjectURL
  globalThis.URL.createObjectURL = (blob) => { downloads.push(blob); return `blob:mock/${downloads.length}` }
  globalThis.URL.revokeObjectURL = () => {}

  Object.assign(applet, {
    getBase64: () => 'R0dC', // base64("GGB")
    getPNGBase64: () => 'aGVsbG8=', // base64("hello")
    exportSVG: (cb) => cb('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    exportPGF: (cb) => cb('\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}'),
    getAllObjectNames: () => ['A', 'B'],
    getObjectType: (n) => (n === 'A' ? 'point' : 'segment'),
    getXcoord: () => 0,
    getYcoord: () => 0,
    getColor: () => '#FF0000',
    getXML: () =>
      '<construction><element type="point" label="A"/><element type="segment" label="s"/>' +
      '<expression label="A" exp="(0,0)" type="point"/><command name="Segment"><input a0="A" a1="B"/><output a0="s"/></command></construction>',
  })

  const clickByLabel = async (label) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
    assert.ok(btn, `找不到按钮：${label}`)
    await act(async () => {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
  }

  await clickByLabel('存 .ggb')
  assert.equal(await downloads.at(-1).text(), 'GGB', '.ggb 内容应还原 base64')
  assert.match(document.body.textContent, /已保存 \.ggb/)

  await clickByLabel('PNG')
  assert.equal(await downloads.at(-1).text(), 'hello', 'PNG 内容应还原 base64')

  await clickByLabel('SVG')
  assert.match(await downloads.at(-1).text(), /<svg/, 'SVG 内容')

  await clickByLabel('TikZ')
  const engineTex = await downloads.at(-1).text()
  assert.match(engineTex, /\\documentclass/, 'TikZ 应是完整文档')
  assert.match(engineTex, /\\begin\{tikzpicture\}/)
  assert.match(document.body.textContent, /引擎原生/)
  const downloadsBeforeFallback = downloads.length

  // 引擎不给 PGF 时必须自动走快照兜底
  delete applet.exportPGF
  await clickByLabel('TikZ')
  assert.ok(downloads.length > downloadsBeforeFallback, '兜底也应产生一次下载')
  const snapshotTex = await downloads.at(-1).text()
  assert.match(snapshotTex, /快照 TikZ 导出/, '应标注走了兜底')
  assert.match(snapshotTex, /\\draw\[color=ggbc0\]/, '快照里应画出点 A')
  assert.match(document.body.textContent, /快照兜底/)

  globalThis.URL.createObjectURL = originalCreate
  globalThis.URL.revokeObjectURL = originalRevoke

  await act(async () => { root.unmount() })
})
