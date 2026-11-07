// GeoGebra 数学画板助手 · Host 半边。
// 工具：geogebra_normalize（命令规范化，零依赖纯函数）。
// 技能：geogebra-commands（教模型写正确命令）。
// 面板：内嵌 GeoGebra CDN 画板（浏览器端加载）。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { normalizeCommands, normalizeCommand, hasLatex, hasChineseAlias } from '../lib/normalize.js'
import { registerApi } from '../lib/api.js'

export const name = 'geogebra-assistant'

export const inject = ['tools', 'skills', 'webServer', 'connection']

export const Config = Schema.object({
  cdnBase: Schema.string().default('https://www.geogebra.org/apps/deployggb.js')
    .description('GeoGebra deployggb.js CDN 地址'),
  codebase: Schema.string().default('https://www.geogebra.org/apps/latest/5.0/web3d/')
    .description('GeoGebra HTML5 codebase 地址'),
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

export const normalizeTool = {
  name: 'geogebra_normalize',
  description:
    '规范化 GeoGebra 5 命令：自动修正中文命令别名（圆→Circle）、LaTeX 记法（\\frac{\\pi}{4}→(pi)/4）、全角标点（，→,）。' +
    '生成 GeoGebra 命令后调用本工具做最终校验，把结果交给用户或面板执行。',
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
    const warnings = []
    const rawLines = raw.split(/\n|;/).map((l) => l.trim()).filter(Boolean)

    if (normalized.length === 0) return result(false, '没有可执行的命令（输入为空或全是注释）。')
    if (normalized.length !== rawLines.length) {
      warnings.push(`命令数从 ${rawLines.length} 变为 ${normalized.length}（部分行被清理为空）`)
    }
    // 检查规范化后是否仍有 LaTeX 或中文
    for (const cmd of normalized) {
      if (hasLatex(cmd)) warnings.push(`「${cmd}」仍含 LaTeX 记法`)
      if (hasChineseAlias(cmd)) warnings.push(`「${cmd}」仍含中文别名`)
      if (/[（），；：＝＋－＊／［］｛｝]/.test(cmd)) warnings.push(`「${cmd}」仍含全角标点`)
    }

    const summary = `已规范化 ${normalized.length} 条命令${warnings.length ? `（${warnings.length} 处提示）` : ''}。`
    const body = normalized.join('\n') + (warnings.length ? `\n\n[提示]\n- ${warnings.join('\n- ')}` : '')
    return result(true, summary, body)
  },
}

export function apply(ctx, config) {
  configRef.config = config
  ctx.skills.registerProvider(() => createSkillProvider([join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]))
  ctx.tools.register(normalizeTool)
  ctx.effect(() => registerApi(ctx, config), `${name}: routes`)
}
