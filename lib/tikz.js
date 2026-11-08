// TikZ 导出（移植自 Geogebra-WebChat 的 src/lib/tikz.ts，MIT，liangdabiao）。
//
// 两条路：
//   ① 引擎原生 exportPGF（未公开 API）→ buildCompactTikZ：去坐标轴/去重复绘图/坐标取整；
//   ② 原生不给（或超时）→ buildSnapshotTikZ：用对象快照（点/线段/直线/射线/圆/多边形/函数/文本）自己拼 TikZ。
// 只保留浏览器与 Node 都能跑的纯函数，不碰 DOM。

/* ------------------------------------------------------------------ *
 * 数值与文本
 * ------------------------------------------------------------------ */

/** 数字格式化：最多 digits 位小数，去掉尾随 0。 */
export function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '0'
  let s = v.toFixed(digits)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0' || s === '') s = '0'
  return s
}

/** 转义 LaTeX 特殊字符（用于标签 / 文本节点）。 */
export function texEscape(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&$#%_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

/* ------------------------------------------------------------------ *
 * 1. 构造 XML → 英文定义
 * ------------------------------------------------------------------ */

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function xmlUnescape(s) {
  return String(s).replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
}

/**
 * 解析 GeoGebra 构造 XML，得到「标签 → {type, def}」映射。
 * 只取每个 command 的第一个输出作为该命令的主对象（Polygon 派生边线由多边形本身推导）。
 */
export function parseConstructionXml(xml) {
  const out = new Map()
  if (!xml) return out

  const types = new Map()
  for (const m of String(xml).matchAll(/<element\s+type="([^"]+)"\s+label="([^"]+)"/g)) {
    types.set(xmlUnescape(m[2]), m[1])
  }

  // 独立对象：<expression label="A" exp="(0, 0)" type="point"/>
  for (const m of String(xml).matchAll(/<expression\s+label="([^"]+)"\s+exp="([^"]*)"([^/]*)\/>/g)) {
    const label = xmlUnescape(m[1])
    const exp = xmlUnescape(m[2])
    const typeAttr = /type="([^"]+)"/.exec(m[3] ?? '')
    out.set(label, { label, type: types.get(label) ?? typeAttr?.[1] ?? '', def: exp })
  }

  // 命令对象：<command name="Segment"><input a0="B" a1="C"/><output a0="t"/></command>
  for (const m of String(xml).matchAll(/<command\s+name="([^"]+)"\s*>([\s\S]*?)<\/command>/g)) {
    const name = xmlUnescape(m[1])
    const inner = m[2]
    const inputs = []
    for (const im of inner.matchAll(/<input\s+([^>]*?)\/>/g)) {
      for (const am of im[1].matchAll(/a\d+="([^"]*)"/g)) inputs.push(xmlUnescape(am[1]))
    }
    const outputs = []
    for (const om of inner.matchAll(/<output\s+([^>]*?)\/>/g)) {
      for (const am of om[1].matchAll(/a\d+="([^"]*)"/g)) outputs.push(xmlUnescape(am[1]))
    }
    const main = outputs[0]
    if (!main) continue
    const def = inputs.length ? `${name}(${inputs.join(',')})` : name
    out.set(main, { label: main, type: types.get(main) ?? '', def })
  }

  for (const [label, type] of types) {
    if (!out.has(label)) out.set(label, { label, type, def: '' })
  }
  return out
}

/** 去掉定义里的空白，取出参数列表。 */
function defArgs(def) {
  const m = /^[^(]*\((.*)\)\s*$/.exec(String(def).trim())
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

/** 从定义里取出引用的对象名（支持 Unicode 标签，如 α）。 */
export function defRefs(def) {
  const args = defArgs(def)
  if (args.length) return args.filter((a) => !/^[-+]?[\d.]+$/.test(a))
  return (String(def).match(/[^\s(),]+/g) ?? []).filter((s) => !/^[-+]?[\d.]+$/.test(s))
}

/* ------------------------------------------------------------------ *
 * 2. 颜色池
 * ------------------------------------------------------------------ */

function createColorPool() {
  return { defs: [], map: new Map() }
}

/** 把 #RRGGBB 注册成 \definecolor，返回引用名。 */
function colorRef(pool, hex) {
  const h = String(hex || '').trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return 'black'
  const key = h.toUpperCase()
  let ref = pool.map.get(key)
  if (!ref) {
    ref = `ggbc${pool.map.size}`
    pool.map.set(key, ref)
    pool.defs.push(`\\definecolor{${ref}}{HTML}{${h.slice(1).toUpperCase()}}`)
  }
  return ref
}

/* ------------------------------------------------------------------ *
 * 3. 文档组装 + 精简
 * ------------------------------------------------------------------ */

export function wrapTikZDocument(snippet, extraPreamble = []) {
  return [
    '\\documentclass[10pt]{article}',
    '\\usepackage{pgf,tikz}',
    '\\usepackage{mathrsfs}',
    '\\usetikzlibrary{arrows}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    ...extraPreamble,
    snippet,
    '\\end{document}',
    '',
  ].join('\n')
}

/** 从任意文本里抽出 tikzpicture 片段。 */
export function extractTikzPicture(text) {
  const m = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/.exec(String(text))
  return (m ? m[0] : String(text)).trim()
}

/** 去掉 pgfplots 的坐标轴环境，保留其中的绘图内容；顺带去掉 clip 行。 */
export function stripAxes(pgf) {
  const m = /\\begin\{axis\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{axis\}/.exec(pgf)
  if (!m) return { body: pgf, removed: false }
  let inner = m[2] ?? ''
  inner = inner.replace(/\\clip\s*\([^)]*\)\s*rectangle\s*\([^)]*\)\s*;?/g, '')
  const body = pgf.replace(/\\begin\{axis\}(\[[\s\S]*?\])?[\s\S]*?\\end\{axis\}/, inner)
  return { body, removed: body !== pgf }
}

/** 一条 draw 语句的几何签名（用于去重）。 */
function drawSignature(stmt) {
  const pts = [...stmt.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }))
  let coords = pts.map((p) => `${fmt(p.x, 4)},${fmt(p.y, 4)}`).join(' ')
  // 同一段线段正反两个方向视为同一条：按排序后的端点键归一（原版这里排序对象搞错了，去重实际不生效）
  if (pts.length === 2 && stmt.includes('--')) {
    const keys = pts.map((p) => `${fmt(p.x, 4)},${fmt(p.y, 4)}`).sort()
    coords = keys.join(' ')
  }
  const rest = stmt
    .replace(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g, '(P)')
    .replace(/\d+(?:\.\d+)?/g, 'N')
  return `${rest}|${coords}`
}

/** 按几何签名去重重复的 draw 语句。 */
export function dedupeDraws(body) {
  const seen = new Set()
  const kept = []
  let removed = 0
  let total = 0
  const parts = String(body).split(/(;)/)
  for (const part of parts) {
    if (part === ';') { kept.push(part); continue }
    if (!part.trim()) { kept.push(part); continue }
    total++
    // 用 trim 后的语句算签名：否则换行/缩进会被算进签名，导致几乎去不掉重复
    const sig = drawSignature(part.trim())
    if (seen.has(sig)) { removed++; continue }
    seen.add(sig)
    kept.push(part)
  }
  return { body: kept.join(''), removed, total }
}

/** 把 (x,y) 形式的坐标取整到指定小数位。 */
export function roundCoords(body, digits = 2) {
  return String(body).replace(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g, (_m, x, y) => {
    const f = 10 ** digits
    return `(${fmt(Math.round(Number(x) * f) / f, digits)},${fmt(Math.round(Number(y) * f) / f, digits)})`
  })
}

/** 生成精简版 TikZ：去坐标轴/网格、去重复绘图、坐标取整，保留颜色与线型。输入是引擎原生 PGF。 */
export function buildCompactTikZ(rawPgf, opts = {}) {
  const digits = opts.digits ?? 2
  const picture = /\\begin\{tikzpicture\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{tikzpicture\}/.exec(rawPgf)
  if (!picture) throw new Error('引擎产物里没有 tikzpicture，无法生成精简版')

  // 先取出 tikzpicture 内部，再做去轴/去重：否则 preamble 会粘在第一条 draw 上，导致它永远去不掉
  const innerRaw = picture[2] ?? ''
  const { body: noAxes, removed: removedAxes } = stripAxes(innerRaw)
  const { body: deduped, removed, total } = dedupeDraws(noAxes)
  const rounded = roundCoords(deduped, digits)

  const colorDefs = [...rawPgf.matchAll(/\\definecolor\{[^}]+\}\{[^}]+\}\{[^}]+\}/g)].map((m) => m[0])
  const snippet = [
    colorDefs.length ? colorDefs.join('\n') : '',
    '\\begin{tikzpicture}[line cap=round,line join=round,>=triangle 45,x=1cm,y=1cm]',
    rounded.trim(),
    '\\end{tikzpicture}',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    document: wrapTikZDocument(snippet),
    snippet,
    stats: { removedDuplicates: removed, removedAxes, totalDraws: total },
  }
}

/* ------------------------------------------------------------------ *
 * 4. 快照降级生成器
 * ------------------------------------------------------------------ */

/** GeoGebra 表达式 → pgfplots \x 表达式；不认识的写法返回 null（宁可不画也不出错图）。 */
export function toPgfExpression(expr) {
  let e = String(expr || '').trim()
  if (!e) return null
  const eq = /^[^=]*=\s*(.+)$/.exec(e)
  if (eq) e = eq[1]
  e = e.replace(/\s+/g, '')
  e = e.replace(/\bx\s*\^\s*\(([^)]+)\)/g, '(\\x)^($1)')
  e = e.replace(/\bx\b/g, '\\x')
  e = e.replace(/\\\\x/g, '\\x')
  // 白名单校验：去掉 \x、\pi 与已知函数名后，只允许数字/运算符/括号/幂
  // （否则 GeoGebra 命令名如 Integral(f) 会原样漏进 TikZ，编译出错）
  const rest = e
    .replace(/\\x|\\pi/g, '')
    .replace(/\b(sin|cos|tan|cot|sec|csc|asin|acos|atan|sinh|cosh|tanh|sqrt|abs|exp|ln|log|floor|ceil|round|pi)\b/gi, '')
  if (!/^[0-9+\-*/().^]*$/.test(rest)) return null
  return e
}

/**
 * 快照 TikZ 生成器：引擎 exportPGF 不可用/超时时，用对象快照生成可编辑 TikZ。
 * objects 每项：{ name, type, def, x, y, color, lineThickness, lineStyle, filling, pointSize,
 *                visible, caption, labelVisible, value }
 */
export function buildSnapshotTikZ(objects, opts = {}) {
  const byName = new Map(objects.map((o) => [o.name, o]))
  const pool = createColorPool()
  const body = []
  const skipped = []
  let drawn = 0

  const pointOf = (name) => {
    const o = byName.get(name)
    return o && o.type === 'point' ? o : null
  }

  for (const o of objects) {
    if (o.visible === false) continue
    const def = o.def || ''
    const color = colorRef(pool, o.color)
    const width = o.lineThickness > 0 ? Math.min(6, o.lineThickness) / 2 : 0.6
    // GeoGebra 线型：0 实线 / 1 虚线 / 2 点线 / 3 点划线
    const dash = o.lineStyle === 1 ? ',dashed' : o.lineStyle === 2 ? ',dotted' : o.lineStyle === 3 ? ',dash dot' : ''
    const style = `[color=${color},line width=${fmt(width)}pt${dash}]`

    if (o.type === 'point') {
      body.push(`\\draw[color=${color}] (${fmt(o.x)},${fmt(o.y)}) circle (${fmt(Math.max(1, o.pointSize || 3) * 0.5)}pt);`)
      const label = o.caption || (o.labelVisible ? o.name : '')
      if (label) {
        body.push(
          `\\draw[color=${color}] (${fmt(o.x + 0.12)},${fmt(o.y + 0.12)}) node[anchor=south west] {\\footnotesize $${texEscape(label)}$};`,
        )
      }
      drawn++
      continue
    }

    if (o.type === 'segment') {
      const refs = defRefs(def)
      const p = pointOf(refs[0])
      const q = pointOf(refs[1])
      if (!p || !q) { skipped.push(`${o.name}(segment)：无法确定端点`); continue }
      body.push(`\\draw${style} (${fmt(p.x)},${fmt(p.y)}) -- (${fmt(q.x)},${fmt(q.y)});`)
      drawn++
      continue
    }

    if (o.type === 'line' || o.type === 'ray') {
      const refs = defRefs(def)
      const p = pointOf(refs[0])
      const q = pointOf(refs[1])
      if (!p || !q) { skipped.push(`${o.name}(${o.type})：无法确定端点`); continue }
      const dx = q.x - p.x
      const dy = q.y - p.y
      const len = Math.hypot(dx, dy) || 1
      const ext = 20 / len
      let x1 = p.x
      let y1 = p.y
      let x2 = q.x
      let y2 = q.y
      if (o.type === 'line') { x1 -= dx * ext; y1 -= dy * ext }
      x2 += dx * ext
      y2 += dy * ext
      body.push(`\\draw${style} (${fmt(x1)},${fmt(y1)}) -- (${fmt(x2)},${fmt(y2)});`)
      drawn++
      continue
    }

    if (o.type === 'polygon' || o.type === 'polyline') {
      const pts = defRefs(def).map(pointOf).filter(Boolean)
      if (pts.length < 3) { skipped.push(`${o.name}(${o.type})：顶点不足`); continue }
      const coords = pts.map((p) => `(${fmt(p.x)},${fmt(p.y)})`).join(' -- ')
      const fill = o.filling > 0 ? `fill=${color}!20,` : ''
      body.push(
        `\\draw[${fill}color=${color},line width=${fmt(width)}pt] ${coords}${o.type === 'polygon' ? ' -- cycle' : ''};`,
      )
      drawn++
      continue
    }

    if (o.type === 'circle' || o.type === 'conic' || o.type === 'semicircle' || o.type === 'arc') {
      const m = /^Circle\s*[\[(]\s*([^,]+),\s*(.+?)\s*[\])]$/i.exec(def)
      if (m) {
        const center = pointOf(m[1].trim())
        let radius = Number(m[2])
        if (!Number.isFinite(radius)) {
          const other = pointOf(m[2].trim())
          radius = other && center ? Math.hypot(other.x - center.x, other.y - center.y) : 0
        }
        if (center && radius > 0) {
          body.push(`\\draw${style} (${fmt(center.x)},${fmt(center.y)}) circle (${fmt(radius)});`)
          drawn++
          continue
        }
      }
      skipped.push(`${o.name}(${o.type})：无法解析圆心/半径`)
      continue
    }

    if (o.type === 'function') {
      const expr = toPgfExpression(def || o.value)
      if (expr) {
        body.push(`\\draw${style} [smooth,samples=100,domain=-5:5] plot(\\x,{${expr}});`)
        drawn++
        continue
      }
      skipped.push(`${o.name}(function)：表达式无法转换`)
      continue
    }

    if (o.type === 'text') {
      const label = o.caption || o.value
      if (label) {
        body.push(`\\node[color=${color},anchor=west] at (${fmt(o.x)},${fmt(o.y)}) {${texEscape(label)}};`)
        drawn++
        continue
      }
    }

    skipped.push(`${o.name}(${o.type || 'unknown'})：暂不支持该类型`)
  }

  if (drawn === 0) throw new Error('画板上没有可转换为 TikZ 的对象')

  const head = [
    '% GeoGebra 快照 TikZ 导出（引擎原生 exportPGF 不可用时的兜底）',
    '% 覆盖：点 / 线段 / 直线 / 射线 / 圆 / 多边形 / 函数 / 文本；函数默认 domain=-5:5。',
  ]
  if (skipped.length) head.push(`% 已跳过 ${skipped.length} 个对象：${skipped.slice(0, 8).join('；')}`)

  const picture = [
    ...head,
    '\\begin{tikzpicture}[line cap=round,line join=round,>=triangle 45,x=1cm,y=1cm]',
    ...body,
    '\\end{tikzpicture}',
  ].join('\n')

  return wrapTikZDocument(picture, pool.defs)
}

/** 便捷入口：给引擎原生 PGF 就精简，给不出来就用快照兜底。 */
export function exportTikZ({ pgf, objects }) {
  if (pgf && /\\begin\{tikzpicture\}/.test(pgf)) {
    return { document: buildCompactTikZ(pgf).document, source: 'engine' }
  }
  return { document: buildSnapshotTikZ(objects || []), source: 'snapshot' }
}

export { createColorPool, colorRef }
