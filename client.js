// ============================================================================
// GeoGebra 数学画板助手 · 浏览器半边。
//
// 面板 = GeoGebra 画板（CDN 加载 deployggb.js）+ AI 自动作图（SSE 接收 host 推送）
//       + 命令输入框（手动执行/清空/规范化预览）。
//
// AI 链路：主对话里模型调 geogebra_draw 工具 → host publish 到事件总线
//          → 这里 EventSource 收到 {type:'draw', commands} → 自动 evalCommand 出图。
// 面板本身不跑 LLM 循环，也不存对话历史——AI 的"脑子"在主对话。
// ============================================================================
const h = require('react').createElement
const { useState, useEffect, useRef } = require('react')
const { parseConstructionXml, exportTikZ } = require('./lib/tikz.js')
const { downloadBase64, downloadText, timestampName } = require('./lib/download.js')

const PANEL_ID = 'geogebra-assistant'
const BASE = 'geogebra-assistant'
const BOARD_TIMEOUT_MS = 20_000
const VIEW_ID = 1 // GeoGebra 视图 1 = 2D 绘图区

function PanelIcon(props) {
  return h('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', ...props },
    h('rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 5, fill: '#1a5276' }),
    h('circle', { cx: 9, cy: 10, r: 4, stroke: '#ffd24a', 'stroke-width': 1.5 }),
    h('path', { d: 'M5 17l4-3 3 2 5-4 3 2', stroke: '#fff', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    h('circle', { cx: 14, cy: 7, r: 1.5, fill: '#fff' }))
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

/** 加载 deployggb.js（CDN），返回 GGBApplet 构造器 */
function loadDeployGgb(cdnUrl) {
  if (window.GGBApplet) return Promise.resolve(window.GGBApplet)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = cdnUrl
    script.onload = () => {
      if (window.GGBApplet) resolve(window.GGBApplet)
      else reject(new Error('deployggb.js 已加载但未暴露 GGBApplet'))
    }
    script.onerror = () => reject(new Error(`加载 GeoGebra CDN 失败：${cdnUrl}（检查网络或改为离线资源）`))
    document.head.appendChild(script)
  })
}

/* ---------------- 导出辅助：读对象快照、调回调式 API ---------------- */

const hasFn = (obj, name) => !!obj && typeof obj[name] === 'function'
const safeCall = (api, name, ...args) => {
  if (!hasFn(api, name)) return undefined
  try { return api[name](...args) } catch { return undefined }
}
const safeString = (fn) => {
  try { const v = fn(); return v == null ? '' : String(v) } catch { return '' }
}
const safeNumber = (fn, fallback = 0) => {
  try { const v = Number(fn()); return Number.isFinite(v) ? v : fallback } catch { return fallback }
}

/** 把当前画板对象读成快照（TikZ 兜底生成器用）。 */
function collectObjects(api, xml) {
  const names = hasFn(api, 'getAllObjectNames')
    ? Array.from(api.getAllObjectNames() || []).map(String)
    : []
  const defs = parseConstructionXml(xml || '')
  return names.map((name) => {
    const d = defs.get(name)
    const labelVisible = safeCall(api, 'getLabelVisible', name)
    return {
      name,
      type: String(safeCall(api, 'getObjectType', name) || d?.type || ''),
      def: d?.def || safeString(() => safeCall(api, 'getCommandString', name)),
      x: safeNumber(() => safeCall(api, 'getXcoord', name)),
      y: safeNumber(() => safeCall(api, 'getYcoord', name)),
      color: safeString(() => safeCall(api, 'getColor', name)),
      lineThickness: safeNumber(() => safeCall(api, 'getLineThickness', name)),
      lineStyle: safeNumber(() => safeCall(api, 'getLineStyle', name)),
      filling: safeNumber(() => safeCall(api, 'getFilling', name)),
      pointSize: safeNumber(() => safeCall(api, 'getPointSize', name), 3),
      visible: safeCall(api, 'getVisible', name, VIEW_ID) !== false,
      caption: safeString(() => safeCall(api, 'getCaption', name)),
      labelVisible: labelVisible === undefined ? true : labelVisible !== false,
      value: safeString(() => safeCall(api, 'getValueString', name)),
    }
  })
}

/**
 * 调用「可能同步返回、也可能回调交付字符串」的 GeoGebra API。
 * getBase64 / exportSVG / exportPGF / getScreenshotBase64 各版本行为不一致，统一加超时。
 */
function callStringApi(api, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!hasFn(api, method)) return reject(new Error(`画板不支持 ${method}（该 GeoGebra 版本没有这个导出接口）`))
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (typeof value === 'string' && value.trim()) resolve(value)
      else reject(new Error(`${method} 未返回内容`))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    try {
      const ret = api[method](finish) // 回调式；同步返回的实现在下一行兜住
      if (typeof ret === 'string') finish(ret)
    } catch (e) {
      settled = true
      clearTimeout(timer)
      reject(e)
    }
  })
}

function Board() {
  const containerRef = useRef(null)
  const appletRef = useRef(null)
  const lastSeqRef = useRef(0)

  const [status, setStatus] = useState('loading') // loading | ready | error
  const [error, setError] = useState('')
  const [cdn, setCdn] = useState(null)
  const [commands, setCommands] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [ai, setAi] = useState({ connected: false, seq: 0, title: '' })
  const [exportMsg, setExportMsg] = useState('')
  const [exporting, setExporting] = useState('')
  const [rollback, setRollback] = useState(true)
  const rollbackRef = useRef(true) // 供 effect 内的回调读到最新值（避免闭包过期）

  /** 执行一批命令（按钮和 AI 推送共用）。只用 ref / setState，可安全放在 effect 里。
   *  allowRollback：执行前存 XML 快照，只要有一条失败就把画板还原回快照，
   *  避免模型写错一条命令就留下一张"半成品脏图"（原版只在全部失败时才回滚）。 */
  const runLines = (lines, { reset = false, allowRollback = true } = {}) => {
    const applet = appletRef.current
    if (!applet) return { total: lines.length, failed: ['画板尚未就绪'], normalized: lines, okLines: [] }
    const snapshot = allowRollback ? safeString(() => applet.getXML()) : ''
    if (reset) { try { applet.newConstruction() } catch { /* 旁路 */ } }
    const failed = []
    const okLines = []
    for (const cmd of lines) {
      try {
        if (applet.evalCommand(cmd)) okLines.push(cmd)
        else failed.push(cmd)
      } catch (e) {
        failed.push(`${cmd}（${e.message}）`)
      }
    }
    let rolledBack = false
    if (failed.length && allowRollback && snapshot && hasFn(applet, 'setXML')) {
      try {
        applet.setXML(snapshot)
        rolledBack = true
      } catch { /* 该版本不支持还原就保持现状，至少把失败命令报出来 */ }
    }
    return { total: lines.length, failed, okLines, normalized: lines, rolledBack }
  }

  // 读取配置（CDN 地址 / codebase）
  useEffect(() => {
    fetch(BASE + '/api/config').then((r) => r.json()).then(setCdn).catch((e) => {
      setStatus('error'); setError(e.message)
    })
  }, [])

  // 注入 GeoGebra 画板（带超时兜底：二段式加载失败时不会触发 script.onerror）
  useEffect(() => {
    if (!cdn || !containerRef.current) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled || appletRef.current) return
      setStatus('error')
      setError(
        'GeoGebra 画板 20 秒内没有加载完成。多半是 geogebra.org 的资源被拦截（代理/防火墙），' +
          '或者自建 codebase 地址不可用。可在插件配置里改 cdnBase / codebase。',
      )
    }, BOARD_TIMEOUT_MS)
    ;(async () => {
      try {
        const GGBApplet = await loadDeployGgb(cdn.cdnBase)
        if (cancelled || !containerRef.current) return
        const id = 'ggb-board-' + Math.random().toString(36).slice(2, 8)
        containerRef.current.id = id
        const applet = new GGBApplet({
          appName: 'classic',
          width: containerRef.current.clientWidth || 700,
          height: 480,
          showToolBar: false,
          showAlgebraInput: false,
          showMenuBar: false,
          showResetIcon: true,
          enableLabelDrags: false,
          enableShiftDragZoom: true,
          enableRightClick: false,
          errorDialogsActive: true,
          useBrowserForJS: true,
          showFullscreenButton: false,
          appletOnLoad() {
            clearTimeout(timer)
            appletRef.current = window.ggbApplet || applet
            if (!cancelled) setStatus('ready')
          },
        }, true)
        // codebase 留空时交给 deployggb.js 用它自带的默认值（实测可用）；
        // 显式配置了才覆盖——之前这里从没传过，配置项是死的。
        if (cdn.codebase) {
          try { applet.setHTML5Codebase(cdn.codebase) } catch { /* 老版 deployggb 没这个方法 */ }
        }
        applet.inject(id, 'preferHTML5')
      } catch (e) {
        clearTimeout(timer)
        if (!cancelled) { setStatus('error'); setError(e.message) }
      }
    })()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [cdn])

  // 订阅作图事件：模型调 geogebra_draw 后，命令从这里进来并自动执行。
  // 首选 SSE；SSE 被代理/压缩中间件挡住时退化为每 3 秒轮询 /api/pending。
  useEffect(() => {
    if (status !== 'ready') return
    let closed = false
    let es = null
    let pollTimer = null

    const applyEvent = (msg) => {
      if (!msg || msg.type !== 'draw') return
      if (typeof msg.seq === 'number' && msg.seq <= lastSeqRef.current) return
      if (typeof msg.seq === 'number') lastSeqRef.current = msg.seq
      const lines = Array.isArray(msg.commands) ? msg.commands : []
      if (!lines.length) return
      setCommands(lines.join('\n'))
      const r = runLines(lines, { reset: Boolean(msg.reset), allowRollback: rollbackRef.current })
      r.fromAi = true
      r.title = msg.title || ''
      setResult(r)
      setAi((s) => ({ ...s, seq: lastSeqRef.current, title: msg.title || '' }))
    }

    const stopPolling = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    }
    const startPolling = () => {
      if (pollTimer || closed) return
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(BASE + '/api/pending?since=' + lastSeqRef.current)
          const data = await res.json()
          for (const event of data.events || []) applyEvent(event)
        } catch { /* 网络抖动，下一轮再试 */ }
      }, 3000)
    }

    try {
      es = new EventSource(BASE + '/api/events?since=' + lastSeqRef.current)
    } catch {
      startPolling() // 没有 EventSource 就走轮询
    }
    if (es) {
      es.onopen = () => {
        if (closed) return
        stopPolling()
        setAi((s) => ({ ...s, connected: true }))
      }
      es.onerror = () => {
        if (closed) return
        setAi((s) => ({ ...s, connected: false }))
        startPolling() // SSE 断了就靠轮询接上，别让 AI 的图丢了
      }
      es.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'ready') { setAi((s) => ({ ...s, connected: true })); return }
        applyEvent(msg)
      }
    }

    return () => { closed = true; stopPolling(); if (es) es.close() }
  }, [status])

  const execute = async () => {
    const raw = commands.trim()
    if (!raw) return
    setBusy(true); setResult(null); setError('')
    try {
      const norm = await postJson('/api/normalize', { commands: raw })
      const lines = norm.commands || []
      if (!lines.length) { setError('没有可执行命令'); return }
      setResult(runLines(lines, { allowRollback: rollback }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const clearBoard = () => {
    const applet = appletRef.current
    if (applet) { try { applet.newConstruction() } catch { /* 旁路 */ } }
    setResult(null)
  }

  const normalizePreview = async () => {
    if (!commands.trim()) return
    try {
      const norm = await postJson('/api/normalize', { commands })
      setPreview(norm.commands)
    } catch (e) { setError(e.message) }
  }

  /** 导出：.ggb / PNG / SVG / TikZ（TikZ 优先引擎原生，失败用快照兜底） */
  const doExport = async (kind) => {
    const api = appletRef.current
    if (!api) { setExportMsg('画板尚未就绪'); return }
    setExporting(kind); setExportMsg('')
    try {
      if (kind === 'ggb') {
        const b64 = await callStringApi(api, 'getBase64', 12_000)
        downloadBase64(b64, 'application/vnd.geogebra.file', timestampName('ggb'))
        setExportMsg('✓ 已保存 .ggb（可用 GeoGebra 打开继续编辑）')
      } else if (kind === 'png') {
        let b64 = ''
        if (hasFn(api, 'getPNGBase64')) {
          try { b64 = String(api.getPNGBase64(2, false, 300) || '') } catch { b64 = '' }
          if (!b64) { try { b64 = String(api.getPNGBase64(1, false, 72) || '') } catch { b64 = '' } }
        }
        if (!b64 && hasFn(api, 'getScreenshotBase64')) b64 = await callStringApi(api, 'getScreenshotBase64', 10_000)
        if (!b64) throw new Error('画板不支持 PNG 导出（缺少 getPNGBase64）')
        downloadBase64(b64, 'image/png', timestampName('png'))
        setExportMsg('✓ 已保存 PNG（2 倍分辨率）')
      } else if (kind === 'svg') {
        const svg = await callStringApi(api, 'exportSVG', 10_000)
        downloadText(svg, timestampName('svg'), 'image/svg+xml;charset=utf-8')
        setExportMsg('✓ 已保存 SVG（矢量，可进 Word/Illustrator/Figma）')
      } else if (kind === 'tikz') {
        let pgf = ''
        try { pgf = await callStringApi(api, 'exportPGF', 8_000) } catch { pgf = '' }
        const xml = pgf ? '' : safeString(() => api.getXML())
        const objects = pgf ? [] : collectObjects(api, xml)
        const { document, source } = exportTikZ({ pgf, objects })
        downloadText(document, timestampName('tex'), 'text/x-tex;charset=utf-8')
        setExportMsg(
          source === 'engine'
            ? '✓ 已保存 TikZ（引擎原生，含颜色/线型）'
            : '✓ 已保存 TikZ（快照兜底：点/线段/直线/射线/圆/多边形/函数/文本）',
        )
      }
    } catch (e) {
      setExportMsg('导出失败：' + e.message)
    } finally {
      setExporting('')
    }
  }

  const aiLabel = ai.connected ? 'AI 通道已连接' : 'AI 通道未连接'
  const aiColor = ai.connected ? '#1a6f4b' : '#b9770e'

  return h('div', { style: styles.wrap },
    // 画板
    h('div', { style: styles.boardCard },
      status === 'error'
        ? h('div', { style: styles.errorBox }, h('div', { style: styles.errorTitle }, 'GeoGebra 加载失败'), h('div', null, error),
            h('div', { style: { ...styles.muted, marginTop: 8 } }, '画板从 GeoGebra 官方 CDN 加载。网络受限时可让模型只输出命令文本，复制到本地 GeoGebra 使用；也可以在插件配置里指向自建镜像。'))
        : h('div', null,
            h('div', { style: styles.boardHost, ref: containerRef }),
            status === 'loading' ? h('div', { style: styles.loading }, 'GeoGebra 画板加载中…（首次约 3-5 秒）') : null)),
    // AI 通道状态 + 上一次 AI 作图
    h('div', { style: styles.aiBar },
      h('span', { style: { ...styles.dot, background: ai.connected ? '#1a6f4b' : '#b9770e' } }),
      h('span', { style: { color: aiColor, fontWeight: 600 } }, aiLabel),
      h('span', { style: styles.muted }, ai.connected
        ? ' · 在对话里说「画一个…」，模型会直接画到这里'
        : ' · 面板就绪后会自动重连；一直未连接请刷新页面'),
      ai.seq ? h('span', { style: { ...styles.muted, marginLeft: 8 } }, `· 最近一次 AI 作图 #${ai.seq}${ai.title ? `：${ai.title}` : ''}`) : null),
    // 命令输入
    h('div', { style: styles.card },
      h('div', { style: styles.sectionTitle }, 'GeoGebra 命令'),
      h('textarea', {
        value: commands,
        onChange: (e) => setCommands(e.target.value),
        placeholder: '一行一条命令，例如：\nA=(0,0)\nB=(4,0)\nC=(0,3)\nPolygon(A,B,C)\nSetColor(Polygon(A,B,C), "blue")',
        style: styles.textarea,
        spellCheck: false,
      }),
      h('div', { style: styles.row },
        h('button', { style: styles.button, onClick: execute, disabled: busy || status !== 'ready' },
          busy ? '执行中…' : '在画板上执行'),
        h('button', { style: styles.buttonSecondary, onClick: normalizePreview, disabled: !commands.trim() }, '规范化预览'),
        h('button', { style: styles.buttonSecondary, onClick: clearBoard, disabled: status !== 'ready' }, '清空画板'),
        h('label', { style: styles.checkLabel, title: '任意一条命令失败时，把画板还原到执行前，避免留下半成品脏图' },
          h('input', {
            type: 'checkbox',
            checked: rollback,
            onChange: (e) => { setRollback(e.target.checked); rollbackRef.current = e.target.checked },
          }),
          '失败自动回滚'),
        status !== 'ready' ? h('span', { style: styles.muted }, `画板状态：${status}`) : null),
      h('div', { style: styles.exportRow },
        h('span', { style: styles.exportLabel }, '导出'),
        h('button', { style: styles.buttonSmall, onClick: () => doExport('ggb'), disabled: status !== 'ready' || !!exporting, title: '几何构造文件，可再用 GeoGebra 打开' }, exporting === 'ggb' ? '…' : '存 .ggb'),
        h('button', { style: styles.buttonSmall, onClick: () => doExport('png'), disabled: status !== 'ready' || !!exporting, title: '2 倍分辨率位图，适合课件/作业' }, exporting === 'png' ? '…' : 'PNG'),
        h('button', { style: styles.buttonSmall, onClick: () => doExport('svg'), disabled: status !== 'ready' || !!exporting, title: '矢量图，可无损放大' }, exporting === 'svg' ? '…' : 'SVG'),
        h('button', { style: styles.buttonSmall, onClick: () => doExport('tikz'), disabled: status !== 'ready' || !!exporting, title: 'LaTeX 用：优先引擎原生 PGF，失败自动用快照兜底' }, exporting === 'tikz' ? '…' : 'TikZ'),
        exportMsg ? h('span', { style: styles.exportMsg }, exportMsg) : null),
      error ? h('div', { style: styles.error }, error) : null,
      result ? h('div', { style: styles.card2 },
        h('div', { style: { color: result.failed.length ? (result.rolledBack ? '#b9770e' : '#c0392b') : '#1a6f4b', fontWeight: 600 } },
          (result.fromAi ? '🤖 AI 作图：' : '') + (result.failed.length
            ? `${result.total - result.failed.length}/${result.total} 条成功，${result.failed.length} 条失败` +
              (result.rolledBack ? ' · 已回滚，画板保持执行前的样子' : '')
            : `✓ ${result.total} 条命令全部执行成功`)),
        result.fromAi && result.title ? h('div', { style: { ...styles.muted, marginTop: 4 } }, result.title) : null,
        result.failed.length ? h('div', { style: { ...styles.muted, marginTop: 4 } }, '失败命令：' + result.failed.join(' | ')) : null,
        result.rolledBack && result.okLines && result.okLines.length
          ? h('div', { style: styles.row },
              h('button', {
                style: styles.buttonSmall,
                title: '回滚后重新执行这批里成功的命令',
                onClick: () => {
                  const retry = runLines(result.okLines, { reset: false, allowRollback: false })
                  setResult({ ...retry, fromAi: result.fromAi, title: result.title })
                },
              }, `保留成功的 ${result.okLines.length} 条`))
          : null) : null,
      preview ? h('div', { style: styles.card2 },
        h('div', { style: styles.sectionTitle }, '规范化结果'),
        h('pre', { style: styles.pre }, preview.join('\n'))) : null),
    // 用法提示
    h('div', { style: styles.card },
      h('div', { style: styles.sectionTitle }, '怎么用'),
      h('div', { style: { ...styles.muted, lineHeight: 1.9 } },
        h('strong', null, '① AI 作图（推荐）：'), '直接在对话里说「画一个直角三角形，标出三个角度」→ 模型调用 geogebra_draw → 图纸自动出现在上面的画板，不用复制。',
        h('br'), '② 拍照读题：把题目截图/照片拖进对话框（或点附件按钮），附一句「照这个图作出来」→ 模型读图后自动作图。',
        h('br'), '③ 手动模式：把命令粘到上面的输入框 → 点「在画板上执行」。',
        h('br'), '④ 中文别名/LaTeX/全角标点会自动纠正（「圆(A,3)」→「Circle(A,3)」）。',
        h('br'), '⑤ 导出：.ggb（可再用 GeoGebra 打开继续编辑）/ PNG（2 倍分辨率）/ SVG（矢量）/ TikZ（LaTeX 源码）。',
        h('br'), '⑥ 失败自动回滚：一批命令里只要有一条失败，画板就还原到执行前（不会留半成品脏图），可以用「保留成功的 N 条」只留跑通的部分；不想要就取消勾选。',
        h('br'), '⑦ 画板由 GeoGebra 官方 CDN 加载，需要能访问 geogebra.org。')))
}

const styles = {
  wrap: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1a1a1a' },
  boardCard: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 8, marginBottom: 8, position: 'relative' },
  boardHost: { width: '100%', minHeight: 480, overflow: 'hidden' },
  loading: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a92', background: 'rgba(255,255,255,0.9)' },
  aiBar: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: '8px 12px', marginBottom: 10, fontSize: 12.5 },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: 4 },
  errorBox: { padding: 16, color: '#c0392b' },
  errorTitle: { fontWeight: 700, marginBottom: 6 },
  card: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 12, marginBottom: 10 },
  card2: { background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 10, marginTop: 10 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
  exportRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e3e3e6' },
  exportLabel: { fontSize: 12.5, color: '#8a8a92', marginRight: 2 },
  exportMsg: { fontSize: 12.5, color: '#1a6f4b', marginLeft: 4 },
  buttonSmall: { padding: '4px 10px', border: '1px solid #d9d9de', borderRadius: 6, background: '#f7f7f9', color: '#1a1a1a', cursor: 'pointer', fontSize: 12.5 },
  checkLabel: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: '#4a4a52', cursor: 'pointer', userSelect: 'none' },
  textarea: { width: '100%', minHeight: 120, padding: '8px 10px', border: '1px solid #d9d9de', borderRadius: 8, fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, lineHeight: 1.6, boxSizing: 'border-box', resize: 'vertical' },
  button: { padding: '6px 14px', border: 'none', borderRadius: 8, background: '#1a5276', color: '#fff', cursor: 'pointer', fontSize: 13 },
  buttonSecondary: { padding: '6px 14px', border: '1px solid #d9d9de', borderRadius: 8, background: '#f0f0f2', color: '#1a1a1a', cursor: 'pointer', fontSize: 13 },
  sectionTitle: { fontWeight: 700, marginBottom: 6, color: '#1a5276' },
  muted: { color: '#8a8a92' },
  error: { color: '#c0392b', marginTop: 6 },
  pre: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 6, padding: 10, fontFamily: 'Consolas, monospace', fontSize: 12.5, lineHeight: 1.6, overflow: 'auto', margin: 0 },
}

function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => '数学画板' }, PanelIcon))
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, Board))
}

exports.isPlugin = true
exports.inject = ['slots']
exports.apply = apply


