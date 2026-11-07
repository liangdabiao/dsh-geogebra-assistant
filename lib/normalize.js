// GeoGebra 命令规范化：中文别名 / LaTeX / 全角标点 → GeoGebra 5 合法命令。
// 移植自 Geogebra-WebChat 的 src/lib/normalize.ts（MIT，liangdabiao）。
// 这解决了大模型输出 GeoGebra 命令时的三大常见问题：
//   ① 中文别名（模型可能写「圆」而不是 Circle）
//   ② LaTeX 记法（模型可能写 \frac 而不是除法）
//   ③ 全角标点（中文输入法导致的 ＋ ， 等）

// 中文别名 → 英文命令（多字优先于单字避免前缀误匹配）
const ALIAS = {
  // 多字
  设置颜色: 'SetColor', 设置填充: 'SetFilling', 设置不透明度: 'SetFilling',
  设置线宽: 'SetLineThickness', 设置线型: 'SetLineStyle',
  设置定点: 'SetFixed', 设置标签模式: 'SetLabelMode',
  显示标签: 'ShowLabel', 隐藏标签: 'ShowLabel', 设置标签: 'SetCaption',
  角平分线: 'AngleBisector', 平行线: 'ParallelLine',
  抛物线: 'Parabola', 双曲线: 'Hyperbola', 旋转: 'Rotate',
  关于点对称: 'Reflect', 关于线对称: 'Reflect', 关于原点对称: 'Reflect',
  平移向量: 'Translate', 位似: 'Dilate',
  交点: 'Intersect', 垂线: 'PerpendicularLine', 垂直: 'PerpendicularLine',
  切线: 'Tangent', 中垂线: 'PerpendicularBisector',
  二等分: 'AngleBisector', 内切圆: 'Incircle', 外接圆: 'CircumcircleArc',
  最小值: 'Min', 最大值: 'Max', 导数: 'Derivative', 积分: 'Integral',
  极坐标: 'Point', 椭圆: 'Ellipse',
  球面: 'Sphere', 外侧角: 'Angle', 圆心角: 'Angle',
  // 单字
  点: 'Point', 直线: 'Line', 射线: 'Ray', 线段: 'Segment',
  圆: 'Circle', 半圆: 'Semicircle', 弧: 'Arc',
  多边形: 'Polygon', 棱锥: 'Pyramid', 棱柱: 'Prism',
  圆柱: 'Cylinder', 圆锥: 'Cone', 球: 'Sphere',
  中点: 'Midpoint', 三角形: 'Polygon', 四边形: 'Polygon',
  正方形: 'Polygon', 五边形: 'Polygon', 六边形: 'Polygon',
}

// 按前缀长度降序排列，确保「球面」优先于「球」匹配
const ALIAS_ENTRIES = Object.entries(ALIAS).sort((a, b) => b[0].length - a[0].length)

// 全角标点 → 半角
const FULLWIDTH_MAP = {
  '（': '(', '）': ')', '，': ',', '；': ';', '：': ':',
  '＝': '=', '＋': '+', '－': '-', '＊': '*', '／': '/',
  '［': '[', '］': ']', '｛': '{', '｝': '}', '　': ' ',
}

function toHalfwidth(line) {
  return line.replace(/[（），；：＝＋－＊／［］｛｝　]/g, (ch) => FULLWIDTH_MAP[ch] ?? ch)
}

/** 找到 openIdx 处 `{` 的配对 `}` 下标，找不到返回 -1 */
function matchBrace(s, openIdx) {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 去除 LaTeX 包装：\frac{a}{b} → (a)/(b)，\sqrt{x} → sqrt(x)，\pi → pi 等 */
function stripLatex(cmd) {
  let s = cmd
  // \frac{a}{b} → ((a)/(b))
  s = s.replace(/\\frac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
    (_, num, den) => `((${num})/(${den}))`)
  // \sqrt[n]{x} → x^(1/n)
  s = s.replace(/\\sqrt\[(\d+)\]\{([^{}]*)\}/g, (_, n, x) => `(${x})^(1/${n})`)
  // \sqrt{x} → sqrt(x)
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_, x) => `sqrt(${x})`)
  // \pi → pi, \theta → theta 等
  s = s.replace(/\\(pi|theta|alpha|beta|gamma|delta|infty)/gi, '$1')
  // \cdot → *, \times → *
  s = s.replace(/\\cdot|\\times/g, '*')
  // \left / \right 移除
  s = s.replace(/\\left|\\right/g, '')
  // ^{...} → ^(...)
  s = s.replace(/\^\{([^{}]*)\}/g, '^($1)')
  // 常见 LaTeX 命令
  s = s.replace(/\\(?:text|mathrm|mathbf)\{([^{}]*)\}/g, '$1')
  return s
}

/** 规范化单条命令 */
export function normalizeCommand(raw) {
  let cmd = String(raw || '').trim()
  if (!cmd) return ''
  // 全角 → 半角
  for (const [fw, hw] of Object.entries(FULLWIDTH_MAP)) cmd = cmd.replaceAll(fw, hw)
  // 中文别名前缀替换
  for (const [zh, en] of ALIAS_ENTRIES) {
    if (cmd.startsWith(zh)) { cmd = en + cmd.slice(zh.length); break }
  }
  // LaTeX 清理
  cmd = stripLatex(cmd)
  return cmd.trim()
}

/** 规范化多条命令（先把全角分号转半角再分割，避免「；」被当命令内容） */
export function normalizeCommands(text) {
  return String(text || '')
    .replace(/；/g, ';')   // 全角分号先统一
    .replace(/，/g, ',')
    .replace(/（/g, '(').replace(/）/g, ')')
    .split(/\n|;/)
    .map((line) => normalizeCommand(line.trim()))
    .filter(Boolean)
}

/** 检测是否包含 LaTeX 记法 */
export function hasLatex(text) {
  return /\\(frac|sqrt|pi|theta|cdot|times|left|right|text|mathrm)/i.test(String(text || ''))
}

/** 检测是否包含中文别名 */
export function hasChineseAlias(text) {
  return ALIAS_ENTRIES.some(([zh]) => String(text || '').includes(zh))
}

export { ALIAS, ALIAS_ENTRIES, FULLWIDTH_MAP, stripLatex, toHalfwidth, matchBrace }
