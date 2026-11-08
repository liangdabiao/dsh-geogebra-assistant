// 作图事件总线（host 侧内存实现）。
//
// 链路：模型在对话里调用 geogebra_draw 工具 → host 把规范化后的命令 publish 进总线
//       → 浏览器面板通过 SSE（或轮询兜底）取走 → 画板上 evalCommand 自动出图。
// 这样「AI 作图」不需要用户复制粘贴命令，也不需要在面板里再跑一套 LLM 循环。
//
// 刻意保留最近 MAX_HISTORY 条：面板没开的时候 AI 已经画了图，
// 用户后开面板也能补收最后一张（面板首次连接只补最近一条，避免重放整段历史）。
const MAX_HISTORY = 20

let seq = 0
const history = []
const subscribers = new Set()

/**
 * 发布一次作图请求。
 * @param {{commands: string[]|string, reset?: boolean, title?: string}} input
 * @returns {{seq: number, type: string, commands: string[], reset: boolean, title: string, at: string}}
 */
export function publishDraw({ commands, reset = false, title = '' } = {}) {
  const list = Array.isArray(commands) ? commands : String(commands || '').split(/\n|;/)
  const event = {
    seq: ++seq,
    type: 'draw',
    commands: list.map((line) => String(line).trim()).filter(Boolean),
    reset: Boolean(reset),
    title: String(title || ''),
    at: new Date().toISOString(),
  }
  history.push(event)
  if (history.length > MAX_HISTORY) history.shift()
  for (const fn of [...subscribers]) {
    try {
      fn(event)
    } catch {
      // 单个订阅者写失败（面板已关）不影响其它订阅者，也不影响工具返回
    }
  }
  return event
}

/** 订阅作图事件，返回取消订阅函数。 */
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** 取 seq > fromSeq 的事件。 */
export function eventsSince(fromSeq = 0) {
  const from = Number(fromSeq) || 0
  return history.filter((event) => event.seq > from)
}

/** 当前序号（面板用它对齐增量）。 */
export function currentSeq() {
  return seq
}

/** 当前订阅者数量（自检/诊断用）。 */
export function subscriberCount() {
  return subscribers.size
}

/** 清空总线（只给测试用）。 */
export function resetBus() {
  seq = 0
  history.length = 0
  subscribers.clear()
}
