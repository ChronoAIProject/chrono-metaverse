---
name: metaverse-builder
description: 在 chrono-metaverse 空间里建造（虚拟地块、实体区的扩展层）：坐标和网格约定、方块表、区域和地块规则、形状词表、建造规范、用 metaverse 命令行写建造脚本并自查（build → dev → shot → check → push → 人看预览 → publish）。在这个工作区里做任何建造、摆放家具、修改锚点之前先读。
---

# chrono-metaverse 建造技能

这个工作区是一个空间（`metaverse.json` 里的 `spaceId`）的本地副本。所有修改都经接口提交成**草稿**，
由人看过预览链接后再发布进时间线。你不能直接改线上数据，也不需要改平台仓库。

## 1. 坐标约定

- **单位米，y 轴向上**，右手坐标系。原点在实体区地面的一个角（首次导入扫描时固定）。
- **网格单位 `GRID_UNIT = 0.05` 米（5 厘米）**。网格只用于：区域和地块边界、方块（区块）、锚点盒子、权限范围检查。
  - 格坐标 = 米 / 0.05。`kit.toGrid(1.2) = 24`，`kit.toMetres(24) = 1.2`。
  - 格子盒子写成 `[x0, y0, z0, x1, y1, z1]`，**半开区间**：包含 `x0 ≤ x < x1` 的格子。`[0,0,0,20,1,20]` 是 1 米 × 5 厘米 × 1 米。
- **形状和物件用连续的米坐标**，不吸附到网格。家具的尺寸按真实尺寸写（0.75 米就是 0.75）。
- 旋转用角度：`yaw` 绕 y、`pitch` 绕 x、`roll` 绕 z。变换顺序：缩放 → 翻滚 → 俯仰 → 偏航 → 平移。
  `yaw = 90` 把局部 +x 转到 -z，把局部 +z 转到 +x。

## 2. 方块表（方块风格内容）

- 方块按 32×32×32 格的区块存储，每格一个编号：
  - `0`：空 / 不覆盖（在扩展层写 0 = 清掉扩展层这一格，露出下面重建层的内容）；
  - `1`：空气覆盖（挖掉重建层在这一格的方块）；
  - `2` 起：方块表里的方块（`palette.json`）。用 `base.block('stone')` 按名称查编号。
- 新方块用 `kit.addBlock('brick', 'solid', { color: '#b4503c' })`，之后用名称 `'brick'` 引用；正式编号发布时由服务端分配。
- 操作只能写**扩展层**；重建层（AI 按扫描重建的结构和物体）只能由处理任务改。扩展层优先显示。

## 3. 区域和地块

- `space.json` 里有区域（`regions`）和地块（`plots`），盒子单位是格：
  - **实体区**（`kind: "physical"`）：和现实对应、由扫描生成的部分；
  - **虚拟区**（`kind: "virtual"`）：现实中不存在的扩展部分；**地块**划在虚拟区里，可以单独授权。
- 每次推送都属于一个**路径范围**：实体区（不加 `--plot`）或某个地块（`--plot p1`）。
  - 地块路径下，**每个操作的影响范围都必须完全落在这个地块的盒子里**：填充盒、复制目标、物件的 `bounds`
    换算成的格子、锚点的新旧位置。超出一格都会被整批拒绝。
  - 实体区路径只能改实体区；`_space` 锚点（整个空间级别）只能经实体区路径改。
  - 物件的范围按 `bounds` 计算（min 向下取整、max 向上取整到格）。**贴边摆放时留 1–2 厘米余量**。
  - 改模板等于改所有用到它的物件，那些物件也必须都在范围内。
- 建造脚本里 `base.target` 给出目标范围：`scope`、`boxes`（格）、`bounds`（米）、`origin`（米，最小角）。
  按 `origin` 加相对位置摆放最省事。

## 4. 形状词表要点（docs/SHAPES.md）

| 函数                                    | 形状                    | 适合                         |
| --------------------------------------- | ----------------------- | ---------------------------- |
| `box([w,h,d], { fillet, chamfer })`     | 长方体，可圆角 / 倒角   | 桌面、柜体、墙、板件         |
| `cylinder(r, h, { radiusTop, fillet })` | 圆柱 / 圆台             | 圆桌面、柱子、花盆           |
| `cone(r, h)`                            | 圆锥                    | 灯罩、装饰                   |
| `extrude(轮廓, h, { fillet, chamfer })` | 二维轮廓沿 +y 拉伸      | 异形台面、L 形柜台、弧形吧台 |
| `lathe([[r,y],…])`                      | 旋转体                  | 圆桌底座、立柱、灯、花瓶     |
| `sweep(路径, 截面)`                     | 沿路径扫掠圆 / 矩形截面 | 椅腿、扶手、管子、栏杆       |
| `loft([{y, outline},…])`                | 2–8 个截面放样          | 渐变的柱子、花瓶             |
| `group([…])`                            | 组合                    | 一件家具的所有部件           |
| `instance('模板编号')`                  | 模板实例                | 同款椅子摆很多把             |

- **局部原点在底面中心**，形状向 +y 延伸（sweep 除外：原点就是路径坐标系的原点）。`{ at: [x, y, z] }` 把底面中心放到那里。
- 二维轮廓的点写 `[x, z]`，**逆时针**排列（从上往下看 +x 向右、+z 向下时是顺时针，以有向面积为正为准；不确定就用 `kit.ccw(points)`）。
  - `arcs: [{ from: i, bulge }]` 把第 i 点到下一点的边换成圆弧，`bulge = tan(圆心角/4)`，正值外凸；`kit.bulgeFor(90)` 是 90° 弧。
  - `fillets: [{ at: i, radius }]` 给第 i 个顶点倒圆角。现成的轮廓：`rect(w, d, { radius })`、`circle(r)`、`stadium(长, 宽)`、`lShape(w, d, arm)`。
- 材质：`{ color: '#rrggbb' }` 或 `[r, g, b]`；贴图要用已上传资源的哈希。
- **包围盒会向外扩**：sweep 向各方向扩出截面半径（贴地的椅腿从 `y = r` 开始，否则会伸到地面以下、超出地块）；圆角和倒角不影响包围盒。
- 校验很严格：字段拼错、多余字段、尺寸 ≤ 0、轮廓顺时针都会立刻报错（带 JSON 路径），先在本地 `metaverse build` 里看到。

## 5. 建造规范

- **按真实尺寸建造**。常用尺寸（米）：

| 物体        | 尺寸                                         |
| ----------- | -------------------------------------------- |
| 餐桌        | 1.2–1.6 × 0.75–0.9，高 0.75，桌面厚 0.03     |
| 圆桌        | 直径 0.6–1.2，高 0.75                        |
| 茶几        | 高 0.4–0.45                                  |
| 椅子        | 座面 0.45 × 0.45，座高 0.45，靠背顶 0.85–0.9 |
| 吧台 / 柜台 | 高 1.05–1.1，深 0.5–0.6；吧凳座高 0.75       |
| 柜子        | 地柜高 0.9、深 0.45–0.6；衣柜高 2.0          |
| 门 / 窗     | 门 0.9 × 2.1；窗台离地 0.9，窗高 1.2–1.5     |
| 墙          | 厚 0.1–0.2，层高 2.8–3.0                     |
| 通道        | 主通道 ≥ 1.2，桌间距 ≥ 0.6                   |

- **常见形状保留棱角和弧度**：台面边缘 1 厘米圆角（`fillet: 0.01`）、石材台面倒角、圆桌用 `cylinder` + `lathe` 底座、
  椅腿用 `sweep`、弧形吧台用带 `arcs` 的 `extrude`。不要用一个大方块代替整件家具。
- 一件家具一个物件（`group` 组合部件），同款的用模板 + `instance`。编号要有意义且稳定（`table-01`、`chair-01-a`），
  每次 build 生成同样的编号，这样重复运行只会更新、不会堆出重复的物件。
- 给物件加 `label`（悬浮标签）；需要关联现实对象（桌号、座位）时同时建锚点（`kit.anchor`）。
- 家具不要互相穿插，不要悬空或埋进地面（底面 y = 地面高度，实体区地面通常是 0）。
- 方块风格只用于虚拟区的地台、围墙、造景等；家具和结构优先用形状。

## 6. 两种建造方式

|      | 只用 AI 工具（不装东西）                            | 本地脚本（本工作区）                       |
| ---- | --------------------------------------------------- | ------------------------------------------ |
| 适合 | 几个盒子、移动锚点、改标签                          | 大量建造、整片布置                         |
| 做法 | 建草稿 → 批量操作（每次 ≤ 200 条、≤ 1MB）→ 生成预览 | 写 `build/main.ts` → `metaverse push`      |
| 自查 | 人看预览链接                                        | 本地 `metaverse shot` 看图，再给人预览链接 |

几千条操作没法逐字写进工具参数，大改动一定用本地脚本。

## 7. 自查流程

```
metaverse pull                 # 下载最新状态（每次开始前、发布冲突后都要做）
metaverse build                # 运行 build/main.ts，打印变化统计；脚本报错在这里修
metaverse dev                  # 本地查看器（可选，给人看；脚本改了自动刷新）
metaverse shot                 # 截图：out/shots/*.png，用 Read 工具看图检查
metaverse check [--plot p1]    # 检查全部改动都在目标范围内（退出码 0 才能推）
metaverse push [--plot p1]     # 推成草稿，打印草稿编号和预览链接
# —— 把预览链接交给人确认 ——
metaverse publish <草稿编号>   # 人确认后发布（实体区的改动一律由人发布）
```

看截图时检查：尺寸比例对不对（和门、桌子比）、有没有穿插和悬空、棱角和弧度是否保留、是否超出地块（"优化 + 扩展"视图有虚拟区边界）。
不满意就改脚本再 build / shot，直到满意再 push。

## 8. 建造脚本

`build/main.ts` 默认导出一个函数，参数是基础状态 `base` 和工具包 `kit`，返回操作列表（可以嵌套数组，`null` 会被跳过），
或 `{ message, ops }`（`message` 是提交说明：push 时记下，publish 时作为提交说明发出）。每次 build 都从基础状态重新生成，
不要在脚本里保存状态。

```ts
import type { BuildBase, Kit } from '@chrono-metaverse/sdk';

// 示例：在 2 × 2 米的地块里布置一个咖啡角（地台、两人桌、吧台、带窗的墙、桌号锚点）。
export default function build(base: BuildBase, kit: Kit) {
  const { addBlock, fill, cells, toGrid, place, placeEntity, template, instance } = kit;
  const { table, chair, counter, wall, windowOpening, anchor, createAnchor } = kit;
  const [ox, oy, oz] = base.target.origin ?? [0, 0, 0]; // 地块最小角（米）
  const floor = oy + 0.05; // 地台一格厚（5 厘米），家具放在地台上
  const at = (x: number, z: number): [number, number, number] => [ox + x, floor, oz + z];

  // 同款椅子做成模板，按实例摆放；实例算包围盒要知道模板。
  const chairTemplate = template('cafe-chair', chair({ color: '#7a5c3e' }));
  const templates = new Map([['cafe-chair', chairTemplate.shape!]]);

  const ops = [
    // 地台：方块风格，盒子用格（地块 40 × 40 格 = 2 × 2 米）。
    addBlock('cafe-floor', 'solid', { color: '#9a8f80' }),
    fill(cells([toGrid(ox), toGrid(oy), toGrid(oz)], [40, 1, 40]), 'cafe-floor'),
    placeEntity(chairTemplate),
    // 两人圆桌 + 两把椅子（椅子面朝 +z，对面那把转 180 度面向桌子）。
    place('cafe-table-01', table({ top: 'round', width: 0.7, at: at(1.2, 0.7) }), {
      label: '1 号桌',
    }),
    place('cafe-chair-01a', instance('cafe-chair', { at: at(1.2, 0.25) }), { templates }),
    place('cafe-chair-01b', instance('cafe-chair', { at: at(1.2, 1.15), yaw: 180 }), { templates }),
    // 吧台：长 1.4、深 0.5 米，靠地块后边（+z）。
    place('cafe-counter', counter({ length: 1.4, depth: 0.5, at: at(1.1, 1.68) }), {
      label: '吧台',
    }),
    // 西侧一面带窗的墙：from / to 是墙中线的两端（米），返回的形状已经摆好位置。
    place(
      'cafe-wall-west',
      wall({
        from: [ox + 0.06, oz + 0.02],
        to: [ox + 0.06, oz + 1.98],
        base: floor,
        height: 1.8,
        openings: [windowOpening(0.5, { width: 0.8, sill: 0.8, height: 0.7 })],
      }),
      { kind: 'structure' },
    ),
    // 桌号锚点：盒子用格。
    createAnchor(
      anchor(
        'cafe-t1',
        'table',
        {
          box: [
            toGrid(ox + 0.85),
            toGrid(floor),
            toGrid(oz + 0.35),
            toGrid(ox + 1.55),
            toGrid(floor + 0.75),
            toGrid(oz + 1.05),
          ],
        },
        { label: '1 号桌' },
      ),
    ),
  ];
  return { message: '布置咖啡角', ops };
}
```

`base` 上常用的：`target`（目标范围）、`regions`、`plots`、`anchors`、`entities`、`palette`、`templates`、
`block(名称)`、`blockAt([x,y,z])`、`entity(编号)`、`anchor(编号)`。

脚本由 Node 直接运行（自带的类型擦除）：只用可以擦除的类型写法（不要用 `enum`、`namespace`），
拆成多个文件时相对导入写完整的扩展名（`import { tables } from './tables.ts'`）。

## 9. 出错时

- `build` 报"第 N 条操作：……"：按说明改脚本（N 从 0 开始数）。
- `check` 报超出范围：把物件往里挪，或缩小尺寸；注意 sweep 的截面半径和圆角不会让包围盒变小。
- `push` 提示时间线已前进、`publish` 返回冲突：`metaverse pull` → `metaverse build` → `metaverse push` 生成新草稿。
- 401：令牌失效，重新 `nyxid login --agent-key --profile <名称>`；403：agent key 的操作范围不允许这个接口（例如发布），交给人处理。
