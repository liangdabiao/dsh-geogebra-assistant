// GeoGebra 数学画板助手 · 技能快照提供方。
// 技能教模型写正确的 GeoGebra 5 命令（避免中文别名/LaTeX/全角标点等常见错误）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const block = m[1]
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  let description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') || null
  if (!description) {
    const lines = block.split(/\r?\n/)
    const start = lines.findIndex((l) => /^description:\s*>/.test(l))
    if (start !== -1) {
      const collected = []
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break
        collected.push(lines[i].replace(/^\s+/, ''))
      }
      description = collected.join(' ').trim()
    }
  }
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

function readDir(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sDir = join(dir, entry.name)
    const skillFile = join(sDir, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const parsed = parse(skillFile)
    if (parsed) out.push({ dir: sDir, file: skillFile, ...parsed, dirName: entry.name })
  }
  return out
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在 DSH 插件里使用',
    '',
    `- 本技能目录：\`${skill.dir}\`。`,
    '- **推荐流程**：直接用 `geogebra_normalize` 工具规范化你生成的命令，再交给用户或面板执行——它会自动修正中文别名、LaTeX 记法、全角标点。',
    '- 面板「数学画板」内嵌 GeoGebra（CDN 加载）：把命令粘进面板的命令框点执行，即可在画板上看到图形；也可在对话里让模型生成命令后复制。',
    '- 写命令的铁律：**只用 GeoGebra 5 英文命令 + 半角标点**；不要输出 LaTeX（`\\frac{\\pi}{4}` → `(pi)/4`）；不要用中文命令名（`圆` → `Circle`）。',
    '- 复杂图形按顺序拆成多条命令（每条一行），先建点/线，再建依赖对象，最后设置样式。',
    '',
  ].join('\n')
}

export function createSkillProvider(dirs) {
  const list = [].concat(dirs)
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'geogebra-assistant',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  return {
    name: 'geogebra-assistant',
    async list() {
      return list.flatMap(readDir).map(candidate)
    },
    async get(c) {
      const s = list.flatMap(readDir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = s.body + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    },
  }
}

export { readDir, addendum }
