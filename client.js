// ============================================================================
// GeoGebra 数学画板助手 · 浏览器半边。
// 面板 = GeoGebra 画板（CDN 加载 deployggb.js）+ 命令输入框（执行/清空/规范化预览）。
// 画板通过 GGBApplet 注入，命令用 evalCommand 逐条执行。
// ============================================================================
const h = require('react').createElement
const { useState, useEffect, useRef } = require('react')

const PANEL_ID = 'geogebra-assistant'
const BASE = 'geogebra-assistant'

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

function Board() {
  const containerRef = useRef(null)
  const appletRef = useRef(null)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [error, setError] = useState('')
  const [cdn, setCdn] = useState(null)
  const [commands, setCommands] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)

  // 读取配置（CDN 地址）
  useEffect(() => {
    fetch(BASE + '/api/config').then((r) => r.json()).then(setCdn).catch((e) => {
      setStatus('error'); setError(e.message)
    })
  }, [])

  // 注入 GeoGebra 画板
  useEffect(() => {
    if (!cdn || !containerRef.current) return
    let cancelled = false
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
            appletRef.current = window.ggbApplet || applet
            if (!cancelled) setStatus('ready')
          },
        }, true)
        applet.inject(id, 'preferHTML5')
      } catch (e) {
        if (!cancelled) { setStatus('error'); setError(e.message) }
      }
    })()
    return () => { cancelled = true }
  }, [cdn])

  const execute = async () => {
    const raw = commands.trim()
    if (!raw) return
    setBusy(true); setResult(null); setError('')
    try {
      // 先规范化
      const norm = await postJson('/api/normalize', { commands: raw })
      const lines = norm.commands || []
      if (!lines.length) { setError('没有可执行命令'); setBusy(false); return }

      const applet = appletRef.current
      if (!applet) { setError('画板尚未就绪，请等几秒或刷新'); setBusy(false); return }

      const failed = []
      for (const cmd of lines) {
        try {
          const ok = applet.evalCommand(cmd)
          if (!ok) failed.push(cmd)
        } catch (e) { failed.push(`${cmd}（${e.message}）`) }
      }
      setResult({ total: lines.length, failed, normalized: lines })
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

  return h('div', { style: styles.wrap },
    // 画板
    h('div', { style: styles.boardCard },
      status === 'error'
        ? h('div', { style: styles.errorBox }, h('div', { style: styles.errorTitle }, 'GeoGebra 加载失败'), h('div', null, error),
            h('div', { style: { ...styles.muted, marginTop: 8 } }, '画板从 GeoGebra 官方 CDN 加载。如果网络受限，可让模型只生成命令文本，复制到本地 GeoGebra 使用。'))
        : h('div', null,
            h('div', { style: styles.boardHost, ref: containerRef }),
            status === 'loading' ? h('div', { style: styles.loading }, 'GeoGebra 画板加载中…（首次约 3-5 秒）') : null)),
    // 命令输入
    h('div', { style: styles.card },
      h('div', { style: styles.sectionTitle }, 'GeoGebra 命令'),
      h('textarea', {
        value: commands,
        onChange: (e) => setCommands(e.target.value),
        placeholder: '一行一条命令，例如：\nA=(0,0)\nB=(4,0)\nC=(0,3)\nPolygon(A,B,C)\nSetColor(Polygon(A,B,C), "blue")',
        style: styles.textarea,
        spellcheck: false,
      }),
      h('div', { style: styles.row },
        h('button', { style: styles.button, onClick: execute, disabled: busy || status !== 'ready' },
          busy ? '执行中…' : '在画板上执行'),
        h('button', { style: styles.buttonSecondary, onClick: normalizePreview, disabled: !commands.trim() }, '规范化预览'),
        h('button', { style: styles.buttonSecondary, onClick: clearBoard, disabled: status !== 'ready' }, '清空画板'),
        status !== 'ready' ? h('span', { style: styles.muted }, `画板状态：${status}`) : null),
      error ? h('div', { style: styles.error }, error) : null,
      result ? h('div', { style: styles.card2 },
        h('div', { style: { color: result.failed.length ? '#c0392b' : '#1a6f4b', fontWeight: 600 } },
          result.failed.length ? `${result.total - result.failed.length}/${result.total} 条成功，${result.failed.length} 条失败` : `✓ ${result.total} 条命令全部执行成功`),
        result.failed.length ? h('div', { style: { ...styles.muted, marginTop: 4 } }, '失败命令：' + result.failed.join(' | ')) : null) : null,
      preview ? h('div', { style: styles.card2 },
        h('div', { style: styles.sectionTitle }, '规范化结果'),
        h('pre', { style: styles.pre }, preview.join('\n'))) : null),
    // 用法提示
    h('div', { style: styles.card },
      h('div', { style: styles.sectionTitle }, '怎么用'),
      h('div', { style: { ...styles.muted, lineHeight: 1.9 } },
        '① 对话里说「画一个直角三角形，标出三个角度」→ 模型生成 GeoGebra 命令',
        h('br'), '② 复制命令粘到上面的输入框 → 点「在画板上执行」',
        h('br'), '③ 画板实时渲染；支持中文别名/LaTeX 自动纠正（「圆(A,3)」→「Circle(A,3)」）',
        h('br'), '④ 画板是 GeoGebra 官方 CDN 加载，需要能访问 geogebra.org')))
}

const styles = {
  wrap: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1a1a1a' },
  boardCard: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 8, marginBottom: 12, position: 'relative' },
  boardHost: { width: '100%', minHeight: 480, overflow: 'hidden' },
  loading: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a92', background: 'rgba(255,255,255,0.9)' },
  errorBox: { padding: 16, color: '#c0392b' },
  errorTitle: { fontWeight: 700, marginBottom: 6 },
  card: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 12, marginBottom: 10 },
  card2: { background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 10, marginTop: 10 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
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
