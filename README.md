# dsh-geogebra-assistant · GeoGebra 数学画板

DeepSeek Harness（dsh）插件：**在侧栏里用自然语言画数学图形**——模型生成 GeoGebra 命令，面板内嵌画板实时渲染。

参考 [Geogebra-WebChat](https://github.com/liangdabiao/Geogebra-WebChat)（MIT）。与原版的关键差异：**画板从 GeoGebra 官方 CDN 加载**，插件包只有 ~20KB（原版内置 50MB 离线资源）。

## 装上以后有什么

| 能力 | 说明 |
|---|---|
| **数学画板面板** | 内嵌 GeoGebra（CDN）：输入命令 → 点「在画板上执行」→ 实时出图。支持清空、规范化预览、失败命令逐条报告 |
| `geogebra_normalize` 工具 | 命令规范化：中文别名（`圆(A,3)`→`Circle(A,3)`）、LaTeX（`\frac{\pi}{4}`→`(pi)/4`）、全角标点（`，`→`,`）。模型生成命令后可自动校验 |
| `geogebra-commands` 技能 | 教模型写正确的 GeoGebra 5 命令：铁律（英文命令名/无 LaTeX/半角标点）+ 命令速查（点线圆/多边形/函数/圆锥曲线/立体/样式）+ 常见错误对照表 |

## 使用

1. 对话里说：**「画一个直角三角形，标出三个角度」**
2. 模型生成 GeoGebra 命令
3. 复制命令 → 粘到侧栏「数学画板」输入框 → 点「在画板上执行」
4. 画板实时渲染；中文别名和 LaTeX 会自动纠正

## 为什么用 CDN

原版 Geogebra-WebChat 内置 50MB 的 GeoGebra 5.0 web3d 离线资源（203 个文件）。dsh 插件分发不适合带这么大体积，因此改为从 `geogebra.org` 官方 CDN 加载（`deployggb.js` + `web3d` codebase）。代价是**需要能访问 geogebra.org**；网络受限时可只用 `geogebra_normalize` 工具生成命令，复制到本地 GeoGebra 使用。

CDN 地址可在插件 Configuration 里修改（`cdnBase` / `codebase`），便于自建镜像。

## 自检

```bash
npm install && npm test && npm run selftest && npm run build
```

- `npm test`：8 个单测（中文别名多字优先/全角标点/LaTeX 清理/多行分割/技能铁律/面板鉴权）
- `npm run selftest`：规范化 + 技能 + 面板 API，零网络


## 安装

```bash
dsh plugin --profile web add dsh-geogebra-assistant
```

## 许可

MIT。实现参考 [Geogebra-WebChat](https://github.com/liangdabiao/Geogebra-WebChat)（liangdabiao）的 `src/lib/normalize.ts`。GeoGebra 版权归 GeoGebra GmbH。
