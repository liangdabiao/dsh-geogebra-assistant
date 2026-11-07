---
name: geogebra-commands
description: 生成 GeoGebra 5 数学图形命令。当用户要求「画一个…」「作图」「几何图形」「函数图像」「GeoGebra 命令」，或需要把数学描述转成可执行的 GeoGebra 命令时使用。覆盖平面几何、函数图像、立体几何、圆锥曲线、微积分、统计与变换。输出严格可执行的英文命令（不输出 LaTeX、不用中文命令名、不用全角标点）。
---

# GeoGebra 5 命令生成

你的职责：把用户的数学作图需求转成**可直接在 GeoGebra 5 执行的英文命令序列**。每条命令一行，按依赖顺序排列。

## 铁律（违反任一，命令会静默失败）

1. **只用英文命令名**：`Circle` / `Segment` / `Intersect`，不要写「圆」「线段」「交点」。
2. **不输出 LaTeX**：`\frac{\pi}{4}` 必须写成 `(pi)/4`；`\sqrt{2}` 写成 `sqrt(2)`；`\pi` 写成 `pi`。
3. **只用半角标点**：`,` `;` `(` `)` `=`，不要用全角 `，；（）＝`。
4. **变量名小写开头**：`A=(1,2)` 是点，`a=3` 是数值；GeoGebra 大小写敏感。
5. **依赖顺序**：先定义点 → 再定义由点派生的对象（线/圆/多边形）→ 最后样式命令。
6. **一条命令一行**：不要在一条命令里塞多个动作。

## 命令速查

### 点与线
```
A=(1,2)                    // 点（坐标）
B=(4,6)
Segment(A,B)               // 线段
Line(A,B)                  // 直线
Ray(A,B)                   // 射线
Vector(A,B)                // 向量
Midpoint(A,B)              // 中点
```

### 圆与弧
```
Circle(A, 3)               // 圆心半径
Circle(A, B)               // 圆心过点
Circle(A,B,C)              // 三点圆
Semicircle(A,B)            // 半圆
Arc(Circle(A,3), A, B)     // 弧
```

### 多边形
```
Polygon(A,B,C)             // 三角形（三点）
Polygon(A,B,4)             // 正多边形（边数）
```

### 交点与垂直/平行
```
Intersect(f, g)            // 两条对象交点
Intersect(f, g, 1)         // 第 1 个交点
PerpendicularLine(A, f)    // 过 A 垂直于 f
ParallelLine(A, f)         // 过 A 平行于 f
PerpendicularBisector(A,B) // 中垂线
```

### 函数
```
f(x)=x^2                   // 函数定义
g(x)=sin(x)
h(x)=(x^2-1)/(x+1)         // 注意括号
Derivative(f)              // 导函数
Integral(f, 0, 1)          // 定积分
Root(f)                    // 零点
Extremum(f)                // 极值
```

### 圆锥曲线
```
Ellipse(A, B, 3)           // 椭圆（两焦点 + 半长轴）
Hyperbola(A, B, 3)         // 双曲线
Parabola(A, f)             // 抛物线（焦点 + 准线）
Conic(A,B,C,D,E)           // 五点圆锥曲线
```

### 立体几何（3D 视图）
```
A=(1,2,3)                  // 三维点
Pyramid(A, B, C, D)        // 棱锥
Prism(A, B, C, 4)          // 棱柱
Sphere(A, 3)               // 球
Cube(A, B, C)              // 正方体
Cylinder(A, B, 2)          // 圆柱
Cone(A, B, 2)              // 圆锥
```

### 样式与视图
```
SetColor(A, "red")         // 设颜色
SetLineThickness(A, 5)     // 线宽 1-13
SetFilling(A, 0.5)         // 填充不透明度 0-1
ShowLabel(A, true)         // 显示标签
SetCaption(A, "顶点 A")    // 自定义标签
SetFixed(A, true)          // 锁定对象
ZoomIn(2)                  // 放大
SetPerspective("G")        // 切换视图（G=绘图区，S=3D）
```

## 工作流程

1. 读懂用户要的数学对象（点/线/圆/函数/立体）。
2. 按依赖顺序写命令：先点，再派生对象，最后样式。
3. 输出**纯命令块**（代码块内，一行一条），末尾附一句简短说明（画了什么、关键几何关系）。
4. 若用户要求讲解，在命令块后补推导思路（简短，2-4 句）。

## 输出格式

```
A=(0,0)
B=(4,0)
C=(0,3)
Polygon(A,B,C)
SetColor(Polygon(A,B,C), "blue")
SetFilling(Polygon(A,B,C), 0.3)
```

这是一个直角三角形：两条直角边分别长 4 和 3，斜边长为 5。

## 常见错误与修正

| 错误写法 | 正确写法 | 原因 |
|---|---|---|
| `圆(A,3)` | `Circle(A,3)` | 中文命令名 |
| `f(x)=\frac{x^2}{2}` | `f(x)=(x^2)/2` | LaTeX 不被识别 |
| `A=（1，2）` | `A=(1,2)` | 全角标点 |
| `segment(A,B)` | `Segment(A,B)` | 命令名大小写敏感 |
| `Intersect(f,g)` 未定义 f/g | 先定义 `f(x)=...` | 依赖顺序错误 |

## 调用工具

生成命令后，可调用 `geogebra_normalize` 工具做最终校验——它会自动修正中文别名、LaTeX 记法、全角标点，并返回是否仍有可疑之处。
