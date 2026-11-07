// 离线自检：规范化 + 技能 + 面板 API。零网络零 key。
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { normalizeCommands, normalizeCommand } = await import('../lib/normalize.js')
const { createSkillProvider } = await import('../lib/skills.js')

let failed = 0
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  try {
    await fn()
    console.log('ok')
  } catch (err) {
    failed++
    console.log('失败')
    console.error(`  ${err.message}`)
  }
}

await step('中文别名规范化', () => {
  if (normalizeCommand('圆(A,3)') !== 'Circle(A,3)') throw new Error('单字别名失败')
  if (normalizeCommand('角平分线(A,B,C)') !== 'AngleBisector(A,B,C)') throw new Error('多字别名失败')
})

await step('LaTeX 清理', () => {
  if (!normalizeCommand('f(x)=\\frac{x^2}{2}').includes('(x^2)/')) throw new Error('frac 清理失败')
  if (normalizeCommand('h=\\pi') !== 'h=pi') throw new Error('pi 清理失败')
})

await step('全角标点', () => {
  if (normalizeCommand('A=（1，2）') !== 'A=(1,2)') throw new Error('全角清理失败')
})

await step('技能快照完整 + 铁律', async () => {
  if (!existsSync(join(ROOT, 'skills', 'geogebra-commands', 'SKILL.md'))) throw new Error('缺 SKILL.md')
  const provider = createSkillProvider([join(ROOT, 'skills')])
  const c = (await provider.list())[0]
  const skill = await provider.get(c)
  for (const p of ['只用英文命令名', '不输出 LaTeX', '半角标点', 'geogebra_normalize']) {
    if (!skill.content.includes(p)) throw new Error(`缺「${p}」`)
  }
})

await step('面板 API 健康/配置/规范化（内存 ctx 模拟）', async () => {
  const { registerApi } = await import('../lib/api.js')
  const captured = []
  const fakeRes = { writeHead() { return this }, end(chunk) { captured.push(String(chunk)) } }
  const fakeCtx = {
    get: () => ({ requestRejection: () => false }),
    webServer: { register: async ({ handler }) => { globalThis.__geoHandler = handler } },
  }
  await registerApi(fakeCtx, { cdnBase: 'https://x/deployggb.js', codebase: 'https://x/5.0/' })
  const handler = globalThis.__geoHandler
  if (!handler) throw new Error('路由未注册')
  await handler({ method: 'GET', url: '/geogebra-assistant/api/health', headers: {} }, fakeRes)
  if (!JSON.parse(captured.at(-1)).ok) throw new Error('health 错误')
  captured.length = 0
  await handler({ method: 'GET', url: '/geogebra-assistant/api/config', headers: {} }, fakeRes)
  const cfg = JSON.parse(captured.at(-1))
  if (!cfg.cdnBase.includes('deployggb')) throw new Error('config 错误')
})

if (failed > 0) {
  console.error(`\n自检失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过。')
