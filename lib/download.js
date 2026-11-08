// 浏览器侧下载工具（纯函数，零依赖；移植自 Geogebra-WebChat 的 src/lib/export.ts，MIT）。
// 只负责「数据 → 文件」这一小段，方便在 jsdom 里测。

/** 形如 ggb-20261108-201530.ggb 的文件名。 */
export function timestampName(ext) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `ggb-${stamp}.${String(ext).replace(/^\./, '')}`
}

/** 纯 base64（或 data URL）→ ArrayBuffer。 */
export function base64ToArrayBuffer(base64) {
  const s = String(base64 || '')
  const clean = s.includes('base64,') ? s.slice(s.indexOf('base64,') + 7) : s
  const bin = atob(clean.replace(/\s/g, ''))
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

/** 触发浏览器下载。返回文件名，便于测试断言。 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return filename
}

export function downloadBase64(base64, mime, filename) {
  return downloadBlob(new Blob([base64ToArrayBuffer(base64)], { type: mime }), filename)
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  return downloadBlob(new Blob([String(text)], { type: mime }), filename)
}

/** 读取本地文件为纯 base64（打开 .ggb 用）。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      const i = s.indexOf('base64,')
      resolve(i >= 0 ? s.slice(i + 7) : s)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}
