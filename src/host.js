// GeoGebra 数学画板助手 · Host 半边。
// 工具：geogebra_draw（把命令推到侧栏面板并自动出图）、geogebra_normalize（命令规范化）。
// 技能：geogebra-commands（教模型写正确命令）。
// 面板：内嵌 GeoGebra CDN 画板（浏览器端加载），通过 /api/events 接收 AI 作图事件。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { normalizeCommands, hasLatex, hasChineseAlias } from '../lib/normalize.js'
import { publishDraw, currentSeq } from '../lib/bus.js'
import { registerApi } from '../lib/api.js'

export const name = 'geogebra-assistant'

export const inject = ['tools', 'skills', 'webServer', 'connection']

export const Config = Schema.object({
  cdnBase: Schema.string().default('https://www.geogebra.org/apps/deployggb.js')
    .description('GeoGebra deployggb.js CDN 地址'),
  codebase: Schema.string().default('')
    .description(
      'GeoGebra HTML5 codebase 地址。留空 = 用 deployggb.js 自带的默认值（推荐）；' +
        '只有在自建镜像时才填，形如 https://cdn.example.com/5.4.920.0/',
    ),
})

const configRef = { config: Config }

const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false, required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      data: { type: 'string' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

function diagnosis(lines) {
  const warnings = []
  for (const cmd of lines) {
    if (hasLatex(cmd)) warnings.push(`「${cmd}」仍含 LaTeX 记法`)
    if (hasChineseAlias(cmd)) warnings.push(`「${cmd}」仍含中文别名`)
    if (/[（），；：＝＋－＊／［］｛｝]/.test(cmd)) warnings.push(`「${cmd}」仍含全角标点`)
  }
  return warnings
}

export const drawTool = {
  name: 'geogebra_draw',
  description:
    '把 GeoGebra 图形直接画到用户侧栏的「数学画板」面板上（不需要用户复制粘贴，面板会自动执行）。' +
    '用户说「画一个…」「作个图」「画函数图像」时用它而不是只输出命令文本。' +
    '用户发来题目截图/照片时，先读图复述条件（字母标注、数值、坐标系），看不清的地方要说明、不要编造，再调本工具作图。' +
    'commands 一行一条，按依赖顺序（先点、再派生对象、最后样式）；中文别名/LaTeX/全角标点会被自动规范化。' +
    '画完再用一两句话解释构图和几何关系。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['commands'],
    properties: {
      commands: {
        type: 'string',
        description: 'GeoGebra 命令，一行一条，例如 "A=(0,0)\\nB=(4,0)\\nC=(0,3)\\nSegment(A,B)"',
      },
      reset: { type: 'boolean', description: '作图前是否清空画板（默认 false，接着上一张画）' },
      title: { type: 'string', description: '这次作图的一句话标题，会显示在面板顶部' },
    },
  },
  timeoutMs: 10_000,
  output: OUTPUT,
  async execute(args) {
    const raw = String(args.commands || '')
    const lines = normalizeCommands(raw)
    if (lines.length === 0) return result(false, '没有可执行的命令（输入为空或全是注释），面板没有变化。')

    const event = publishDraw({
      commands: lines,
      reset: Boolean(args.reset),
      title: String(args.title || ''),
    })
    const warnings = diagnosis(lines)
    const summary =
      `已推送到画板面板（事件 #${event.seq}，${lines.length} 条命令${event.reset ? '，已清空旧图' : ''}）。` +
      `${warnings.length ? `有 ${warnings.length} 处可疑写法。` : ''}` +
      '用户在侧栏「数学画板」里会直接看到这张图。'
    const body = lines.join('\n') + (warnings.length ? `\n\n[提示]\n- ${warnings.join('\n- ')}` : '')
    return result(true, summary, body)
  },
}

export const normalizeTool = {
  name: 'geogebra_normalize',
  description:
    '规范化 GeoGebra 5 命令：自动修正中文命令别名（圆→Circle）、LaTeX 记法（\\frac{\\pi}{4}→(pi)/4）、全角标点（，→,）。' +
    '只在需要「先看规范化结果、但暂不画图」时使用；要真正画出来请用 geogebra_draw（它内部已做同样规范化）。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['commands'],
    properties: {
      commands: { type: 'string', description: 'GeoGebra 命令（可多行，一行一条）' },
    },
  },
  timeoutMs: 10_000,
  output: OUTPUT,
  async execute(args) {
    const raw = String(args.commands || '')
    const normalized = normalizeCommands(raw)
    const rawLines = raw.split(/\n|;/).map((l) => l.trim()).filter(Boolean)

    if (normalized.length === 0) return result(false, '没有可执行的命令（输入为空或全是注释）。')
    const warnings = diagnosis(normalized)
    if (normalized.length !== rawLines.length) {
      warnings.push(`命令数从 ${rawLines.length} 变为 ${normalized.length}（部分行被清理为空）`)
    }

    const summary = `已规范化 ${normalized.length} 条命令${warnings.length ? `（${warnings.length} 处提示）` : ''}。`
    const body = normalized.join('\n') + (warnings.length ? `\n\n[提示]\n- ${warnings.join('\n- ')}` : '')
    return result(true, summary, body)
  },
}

/** 面板/工具状态，供自检与排查用（不进模型上下文）。 */
export function describeState() {
  return { seq: currentSeq(), codebase: configRef.config?.codebase || '' }
}

export function apply(ctx, config) {
  configRef.config = config
  ctx.skills.registerProvider(() => createSkillProvider([join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]))
  ctx.tools.register(drawTool)
  ctx.tools.register(normalizeTool)
  ctx.effect(() => registerApi(ctx, config), `${name}: routes`)
}
