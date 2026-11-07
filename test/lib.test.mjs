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
  assert.equal(requestRejection(noService, { headers: {} }), 403)
})
