# dsh-geogebra-assistant · GeoGebra 数学画板

DeepSeek Harness（dsh）插件：**在对话里说一句话，图形自动出现在侧栏的画板上**。

参考 [Geogebra-WebChat](https://github.com/liangdabiao/Geogebra-WebChat)（MIT）。与原版的差异：**命令推送由宿主工具完成，面板不再自己跑一套 LLM 循环**；GeoGebra 从官方 CDN 加载，插件包只有 ~10KB（原版内置 50MB 离线资源）。

## 装上以后有什么

| 能力 | 说明 |
|---|---|
| **AI 自动作图** | 你在主对话里说「画一个直角三角形，标出三个角度」→ 模型调用 `geogebra_draw` → 命令经事件总线和 SSE 推到面板 → 画板**自动执行出图**，不需要复制粘贴 |
| **拍照/截图读题** | 把题目图片拖进主对话（或点附件按钮），说一句「照这个图作出来」→ 模型读图（复述条件、标注，看不清会说明而不编）→ 调 `geogebra_draw` 出图 |
| **导出 .ggb / PNG / SVG / TikZ** | 面板命令框下方四个按钮：`.ggb`（几何构造，可再用 GeoGebra 打开）、`PNG`（2 倍分辨率）、`SVG`（矢量）、`TikZ`（LaTeX 源码，优先引擎原生 PGF，失败自动用快照兜底） |
| **失败自动回滚** | 一批命令里只要有一条失败，就把画板还原到执行前（`getXML` 快照 → `setXML` 还原），不留半成品脏图；同时给「保留成功的 N 条」按钮，可只留跑通的部分。开关可关 |
| `geogebra_draw` 工具 | 模型侧入口：一行一条命令，可带 `title` 和 `reset`（重新画时清空旧图） |
| `geogebra_normalize` 工具 | 命令规范化：中文别名（`圆(A,3)`→`Circle(A,3)`）、LaTeX（`\frac{\pi}{4}`→`(pi)/4`）、全角标点（`，`→`,`）。`geogebra_draw` 内部也会做同样处理 |
| **数学画板面板** | 内嵌 GeoGebra（CDN）：AI 推送的图自动渲染；也支持手动粘命令执行、清空、规范化预览、失败命令逐条报告；顶部有「AI 通道」连接状态 |
| `geogebra-commands` 技能 | 教模型写正确的 GeoGebra 5 命令：铁律 + 命令速查 + 读图规则 + 常见错误对照表 |

## 使用

### AI 作图（主路径）

1. 对话里说：**「画一个直角三角形，标出三个角度」**
2. 模型生成命令并调用 `geogebra_draw`
3. 侧栏「数学画板」面板**自动出图**（面板没开也没关系，打开时会补画最近一张）
4. 图形可拖动、缩放；面板里能看到模型这次用的命令，可直接改完点「在画板上执行」

> 面板本身**不提供对话输入框**，也不存对话历史——AI 的“脑子”在主对话里，面板是画布。这一点和原版「左画板右聊天」的形态不同：原版把聊天搬进页面，dsh 版复用主对话。

### 手动模式

1. 复制命令 → 粘到面板输入框 → 点「在画板上执行」
2. 画板实时渲染；中文别名和 LaTeX 会自动纠正

## 实现要点

- **作图事件总线**（`lib/bus.js`，宿主内存单例）：保留最近 20 条作图事件，序号单调递增。面板后开也能补收最后一张。
- **推送通道**：`GET /geogebra-assistant/api/events`（SSE，首连只补最近一条，避免重放整段历史）+ `GET /api/pending?since=N`（轮询兜底，SSE 被代理/压缩中间件挡住时面板自动退化为 3 秒轮询）。
- **执行**：面板收到 `{type:'draw', commands, reset, title}` 后逐条 `evalCommand`，失败命令在面板上逐条列出。
- **导出**（`lib/tikz.js` + `lib/download.js`，移植自原版 `src/lib/tikz.ts`）：`.ggb` 走 `getBase64()`，PNG 走 `getPNGBase64(2,false,300)`，SVG 走 `exportSVG(cb)`，TikZ 先试未公开的 `exportPGF(cb)`（8 秒超时）→ 成功则去坐标轴/去重复绘图/坐标取整；失败则用 `getXML()` 解析出的对象快照自己拼 TikZ（覆盖点/线段/直线/射线/圆/多边形/函数/文本）。所有回调式 API 统一加超时，避免面板卡死。

## 为什么用 CDN

原版 Geogebra-WebChat 内置 50MB 的 GeoGebra 5.0 web3d 离线资源（203 个文件）。dsh 插件分发不适合带这么大体积，因此改为从 `geogebra.org` 官方 CDN 加载（`deployggb.js` + web3d codebase）。代价是**需要能访问 geogebra.org**；网络受限时可只用 `geogebra_normalize` 工具生成命令，复制到本地 GeoGebra 使用。

CDN 地址在插件 Configuration 里：`cdnBase`（deployggb.js 地址）、`codebase`（HTML5 codebase，**留空 = 用 deployggb.js 自带默认值**，只有自建镜像时才填）。

## 自检

```bash
npm install && npm test && npm run selftest && npm run build
```

- `npm test`：22 个测试
  - 主测试集 `test/lib.test.mjs`（12 个）：中文别名多字优先、全角标点、LaTeX 清理、多行分割、技能铁律、面板鉴权、事件总线发布订阅与裁剪、`geogebra_draw` 推送、SSE 首连补发与实时推流、pending 增量
  - TikZ 测试 `test/tikz.test.mjs`（9 个）：构造 XML 解析、`defRefs`、表达式转 `\x`（含命令名白名单拒绝）、快照生成（点/线/圆/多边形/函数/文本/不可见过滤）、引擎 PGF 去轴去重取整、文件名与 base64 解码
  - 面板 DOM 冒烟 `test/panel.dom.test.mjs`（1 个，jsdom）：挂载真实 `dist/client.js`，断言 AI 事件真的驱动 `evalCommand`、同 seq 去重、增量不清空；构造一条失败命令验证「失败自动回滚」（快照还原 / 保留成功部分 / 关开关后不回滚）；再逐个点导出按钮验证 `.ggb`/PNG/SVG/TikZ 真的产出文件内容（含 TikZ 快照兜底）
- `npm run selftest`：7 步自检（规范化 + 技能 + 面板 API + AI 作图链路 + 事件流），零网络

## 版本记录

### 0.3.2 —— 修「样式命令被当成失败，把好图回滚掉」

**现象**：让 AI 画「正四面体 + 外接球」，面板显示 `12/23 条成功，11 条失败 · 已回滚`，画板空白。失败的正好是 `SetPerspective` 和全部 `SetColor` / `SetFilling` / `SetLineThickness` / `SetPointSize`。

**根因**：GeoGebra 的 JS API `evalCommand` 对**不新建对象**的命令（`Set*`、`Show*`、`Hide*`、`Zoom*`、`SetPerspective`…）**即使执行成功也返回 `false`**。0.1–0.3.1 直接拿返回值当成败依据，于是这些命令全被判失败；0.3.1 的"任意失败即回滚"再把这个误判放大成"把已经画好的图自己擦掉"。

**修法**（`client.js` 的 `runLines`）：

1. 返回 `true` → 成功；
2. 返回 `false` 但 `getAllObjectNames()` 出现了**新名字** → 成功（真建出了对象）；
3. 返回 `false` 且属于样式/视图类命令 → 只要**目标对象存在**就算成功，记进 `soft`（面板显示「另有 N 条样式命令…实际已生效」），不参与回滚判定；目标对象不存在才是真失败（例如 `SetColor(拼错的名字,…)`）；
4. 其余 `false` → 真失败（命令名写错、参数非法）。

顺带修掉一个隐患：状态判断原来用「对象数组长度 > Set 大小」，一旦出现重名就会误判成"新建了对象"，现在只看「有没有新名字」。对象名判定改用 Unicode 正则，中文对象名（如 `SetColor(三角形A,…)`）也能被正确识别。

测试补了三条（jsdom，桩里故意模仿「Set* 返回 false 但生效」这个真机行为）：样式命令不触发回滚且显示 soft 条数、目标不存在的样式命令算真失败并回滚、真失败仍能回滚并可「保留成功部分」。

### 0.3.1 —— 失败自动回滚

| 点 | 说明 |
|---|---|
| 为什么要它 | 模型偶尔会写错一条命令。没有回滚时，这条失败、其它照旧执行，画板上就留下一张**半成品脏图**，还叠在上一张图上，越用越乱 |
| 怎么做 | 执行一批命令前 `getXML()` 存快照 → 只要有一条失败 → `setXML(快照)` 还原。快照在执行 `newConstruction()`（清空）**之前**取，所以「重画一张」失败时也能回到原图 |
| 和原版的差别 | 原版只在**全部**命令失败时才回滚（`failed.length === commands.length`），一条错的就白画；这里改成**任意一条失败就回滚**，另外给「保留成功的 N 条」按钮，由你决定要不要留 |
| 降级行为 | 如果当前 GeoGebra 版本没有 `setXML`，就退回旧行为：只报失败命令，不动画板（不会把自己搞坏） |
| 测试 | DOM 测试里用 `evalCommand` 对特定命令返回 `false` 来构造失败：断言回滚一次且用的是执行前快照、文案含「已回滚」、按钮只重放成功的命令、关掉开关后不再回滚 |

### 0.3.0 —— 补齐原版的「读图」和「导出」

| 能力 | 说明 |
|---|---|
| **拍照/上传读题** | 走 dsh 主对话的附件能力（插件侧不用改）：图片拖进对话 + 一句「照这个图作出来」→ 模型读图后调 `geogebra_draw`。技能里补了读图规则：先复述题面/标注/条件，看不清要说明、**不编造条件**，并按图还原线型（虚线/点线用 `SetLineStyle`，且对象要显式命名） |
| **导出 .ggb / PNG / SVG / TikZ** | 面板四个导出按钮；TikZ 双路：引擎原生 `exportPGF` 优先，失败自动用对象快照兜底（点/线段/直线/射线/圆/多边形/函数/文本） |
| 顺手修的原版问题 | ① 去重签名对同一线段的正反方向没归一（原版实际去不掉重复）；② dedupe 把语句前导换行算进签名，导致几乎永远不生效；③ 表达式白名单过松，`Integral(f)` 这类命令名会漏进 TikZ 编译报错。现已分别修正 |

### 0.2.0 —— 把 AI 真正接上

| 问题 | 说明 |
|---|---|
| **AI 根本没接上** | 0.1.0 只有命令输入框，模型生成的命令永远到不了面板，必须人工复制粘贴。0.2.0 加了 `geogebra_draw` + 事件总线 + SSE，真正自动出图 |
| `codebase` 配置是死的 | 0.1.0 构造 `GGBApplet` 时从没传 `codebase`，配置项改了不生效；且原默认值 `apps/latest/5.0/web3d/` 实测 403。现在留空交给 deployggb 自带默认值，显式配置时才 `setHTML5Codebase()` |
| 画板加载无超时 | deployggb 是二段式加载，中途失败不触发 `script.onerror`，面板会永远停在「加载中」。现在 20 秒超时并给出可操作的错误提示 |
| 面板说明误导 | 0.1.0 的说明写着「在侧栏里用自然语言画图」，但面板里没有自然语言入口。现在文档和面板文案都写明：AI 在主对话，面板是画布 |

## 安装

```bash
# 从 GitHub 直接装（dist/client.js 已入库，装完即可用）
dsh plugin --profile web add github:liangdabiao/dsh-geogebra-assistant

# 本地开发（改源码后 HMR + 条目重启）
dsh plugin --profile web add D:/path/to/dsh-geogebra-assistant
```

> **dist/client.js 是入库文件**。dsh 宿主直接消费已构建的客户端 bundle（`package.json` → `exports["./client"]`），缺少它插件会激活失败、侧栏面板不出现。改完源码记得 `npm run build` 再提交。

改了 Host 半边（工具/路由）后需要让插件条目重启一次才能在运行中的 dsh 里生效：设置 → 插件里关掉再打开，或重启 dsh。浏览器半边重建 `dist/client.js` 后会被 HMR 推给已打开的页面。

## 许可

MIT。实现参考 [Geogebra-WebChat](https://github.com/liangdabiao/Geogebra-WebChat)（liangdabiao）的 `src/lib/normalize.ts`。GeoGebra 版权归 GeoGebra GmbH。
