// TikZ / 下载工具单测：解析构造 XML、快照生成、引擎 PGF 精简。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fmt,
  texEscape,
  parseConstructionXml,
  defRefs,
  toPgfExpression,
  buildSnapshotTikZ,
  buildCompactTikZ,
  stripAxes,
  dedupeDraws,
  roundCoords,
  wrapTikZDocument,
  exportTikZ,
} from '../lib/tikz.js'
import { timestampName, base64ToArrayBuffer } from '../lib/download.js'

test('fmt / texEscape', () => {
  assert.equal(fmt(1.2300001, 3), '1.23')
  assert.equal(fmt(2, 2), '2')
  assert.equal(fmt(-0.0001, 3), '0')
  assert.equal(fmt(NaN), '0')
  assert.equal(texEscape('a_b&c'), 'a\\_b\\&c')
})

test('parseConstructionXml：独立点 + 命令对象 + 类型回填', () => {
  const xml = `<?xml version="1.0"?>
  <construction>
    <element type="point" label="A"/>
    <element type="point" label="B"/>
    <element type="point" label="C"/>
    <element type="segment" label="s"/>
    <expression label="A" exp="(1, 2)" type="point"/>
    <expression label="B" exp="(4, 6)" type="point"/>
    <command name="Segment">
      <input a0="A" a1="B"/>
      <output a0="s"/>
    </command>
    <command name="Circle">
      <input a0="A" a1="3"/>
      <output a0="c"/>
    </command>
  </construction>`
  const defs = parseConstructionXml(xml)
  assert.equal(defs.get('A').def, '(1, 2)')
  assert.equal(defs.get('A').type, 'point')
  assert.equal(defs.get('s').def, 'Segment(A,B)')
  assert.equal(defs.get('s').type, 'segment')
  assert.equal(defs.get('c').def, 'Circle(A,3)')
  assert.equal(defs.get('c').type, '', 'XML 里没有 element 声明时类型留空，由调用方用 getObjectType 补')
})

test('defRefs：取出对象引用，过滤数字参数', () => {
  assert.deepEqual(defRefs('Segment(A,B)'), ['A', 'B'])
  assert.deepEqual(defRefs('Circle(A,3)'), ['A'])
  assert.deepEqual(defRefs('Circle(A,radius)'), ['A', 'radius'])
})

test('toPgfExpression：x → \\x，分数/幂保留；不认识的返回 null', () => {
  assert.equal(toPgfExpression('f(x)=x^2'), '\\x^2')
  assert.equal(toPgfExpression('x^(2)/3-2'), '(\\x)^(2)/3-2')
  assert.equal(toPgfExpression('sin(x)'), 'sin(\\x)')
  assert.equal(toPgfExpression('Integral(f)'), null)
})

test('buildSnapshotTikZ：点/线段/直线/圆/多边形/函数/文本', () => {
  const objects = [
    { name: 'A', type: 'point', def: '(0,0)', x: 0, y: 0, color: '#FF0000', pointSize: 4, labelVisible: true },
    { name: 'B', type: 'point', def: '(4,0)', x: 4, y: 0, color: '#FF0000', pointSize: 4, labelVisible: false },
    { name: 'C', type: 'point', def: '(0,3)', x: 0, y: 3, color: '#FF0000', pointSize: 4, labelVisible: false },
    { name: 's', type: 'segment', def: 'Segment(A,B)', color: '#0055FF', lineStyle: 1, lineThickness: 4 },
    { name: 'l', type: 'line', def: 'Line(A,C)', color: '#000000' },
    { name: 'c', type: 'circle', def: 'Circle(A,2)', color: '#00AA00' },
    { name: 'tri', type: 'polygon', def: 'Polygon(A,B,C)', color: '#888888', filling: 0.3 },
    { name: 'f', type: 'function', def: 'f(x)=x^2', color: '#FF00FF' },
    { name: 'T', type: 'text', def: '', value: 'hello_world', x: 1, y: 1, color: '#000000' },
    { name: 'hide', type: 'point', def: '', x: 9, y: 9, visible: false },
  ]
  const doc = buildSnapshotTikZ(objects)
  assert.match(doc, /\\documentclass/)
  assert.match(doc, /\\definecolor\{ggbc0\}\{HTML\}\{FF0000\}/)
  assert.match(doc, /circle \(2pt\)/, '点用点大小换算半径')
  assert.match(doc, /node\[anchor=south west\]/, 'A 有标签')
  assert.match(doc, /dashed/, '虚线线型')
  assert.match(doc, /-- cycle/, '多边形闭合')
  assert.match(doc, /plot\(\\x,\{\\x\^2\}\)/, '函数表达式')
  assert.match(doc, /hello\\_world/, '文本转义')
  assert.ok(!doc.includes('(9,9)'), '不可见对象不导出')
})

test('buildSnapshotTikZ：没有可画对象时抛错', () => {
  assert.throws(() => buildSnapshotTikZ([{ name: 'x', type: 'numeric', visible: true }]), /没有可转换为 TikZ/)
})

test('引擎 PGF 精简：去坐标轴 / 去重复绘图 / 坐标取整', () => {
  const pgf = [
    '\\documentclass[10pt]{article}',
    '\\usepackage{pgf,tikz,pgfplots}',
    '\\begin{document}',
    '\\definecolor{ggbcol1}{HTML}{FF0000}',
    '\\begin{tikzpicture}',
    '\\begin{axis}[xmin=-5,xmax=5]',
    '\\clip(-5,-5) rectangle (5,5);',
    '\\draw[color=ggbcol1] (1.23456,2.34567)-- (3.44444,0.11111);',
    '\\draw[color=ggbcol1] (3.44444,0.11111)-- (1.23456,2.34567);',
    '\\end{axis}',
    '\\end{tikzpicture}',
    '\\end{document}',
  ].join('\n')
  const { body, removed } = stripAxes(pgf)
  assert.equal(removed, true)
  assert.ok(!body.includes('\\begin{axis}'))
  assert.ok(!body.includes('\\clip'))
  const inner =
    '\\draw[color=ggbcol1] (1.23456,2.34567)-- (3.44444,0.11111);\n' +
    '\\draw[color=ggbcol1] (3.44444,0.11111)-- (1.23456,2.34567);'
  const { removed: dup } = dedupeDraws(inner)
  assert.equal(dup, 1, '正反两个方向的同一线段应去重')
  assert.equal(roundCoords('(1.23456,2.34567)', 2), '(1.23,2.35)')

  const { document, stats } = buildCompactTikZ(pgf)
  assert.match(document, /\\begin\{tikzpicture\}\[line cap=round/)
  assert.match(document, /\\definecolor\{ggbcol1\}\{HTML\}\{FF0000\}/)
  assert.ok(!document.includes('axis'))
  assert.equal(stats.removedDuplicates, 1)
})

test('wrapTikZDocument / exportTikZ 两条路都给出完整文档', () => {
  assert.match(wrapTikZDocument('\\begin{tikzpicture}\\end{tikzpicture}'), /\\begin\{document\}/)

  const engine = exportTikZ({
    pgf: '\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}',
    objects: [],
  })
  assert.equal(engine.source, 'engine')
  assert.match(engine.document, /\\documentclass/)

  const snapshot = exportTikZ({ pgf: '', objects: [{ name: 'A', type: 'point', x: 0, y: 0, color: '#FF0000' }] })
  assert.equal(snapshot.source, 'snapshot')
  assert.match(snapshot.document, /\\draw\[color=ggbc0\]/)
})

test('下载工具：文件名与 base64 解码', () => {
  assert.match(timestampName('ggb'), /^ggb-\d{8}-\d{6}\.ggb$/)
  assert.match(timestampName('.tex'), /\.tex$/)
  const buf = base64ToArrayBuffer('data:image/png;base64,aGVsbG8=')
  assert.equal(Buffer.from(buf).toString('utf8'), 'hello')
})

