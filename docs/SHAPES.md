# 形状词表与跨语言约定

接口服务（Rust）、网站（TypeScript）、处理服务（Python）共用本文的数据格式。三边各自实现，靠 `api/crates/metaverse-core/tests/vectors/` 下的测试向量保证结果一致。

## 1. 坐标与单位

- 单位米，y 轴向上，右手坐标系。
- 网格单位 `GRID_UNIT = 0.05` 米，只用于定位、区域和地块边界、锚点吸附、占用索引；形状的尺寸和位置都是连续值，不吸附到网格。
- 旋转用角度：`yaw`（绕 y）、`pitch`（绕 x）、`roll`（绕 z）。
- 变换顺序：缩放 → 翻滚 → 俯仰 → 偏航 → 平移。矩阵写法是 `M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`。

## 2. 形状

每个形状是一个 JSON 对象，`type` 决定其余字段。所有形状都可以带：

```json
{ "transform": { "position": [x, y, z], "yaw": 0, "pitch": 0, "roll": 0, "scale": [1, 1, 1] },
  "material": { "color": [r, g, b] } }
```

- `material` 可以是 `{ "color": [r,g,b] }`（sRGB 0–255），也可以是 `{ "texture": "<资源哈希>", "uv": "box" | "planar" | "cylindrical" | "mesh" }`。贴图还可以带 `"tint": [r,g,b]`。
- 形状的局部原点：`box`、`cylinder`、`cone`、`extrude`、`lathe`、`loft` 的原点都在底面中心，形状向 +y 延伸。`sweep` 的原点就是路径坐标系的原点。

| type | 字段 | 说明 |
|---|---|---|
| `box` | `size: [w, h, d]`；`fillet?: r`；`chamfer?: c`；`segments?: n`（圆角分段，默认 4） | 圆角半径和倒角都会被限制到不超过最短边的一半；两者同时给时以 `fillet` 为准 |
| `cylinder` | `radius`，`height`；`radiusTop?`（不给就是圆柱，给了就是圆台）；`segments?`（默认 32）；`fillet?`（上下边缘圆角） | — |
| `cone` | `radius`，`height`；`segments?` | — |
| `extrude` | `outline`：二维轮廓（见下）；`height`；`fillet?`、`chamfer?`（顶面和底面边缘） | 轮廓在 xz 平面，沿 +y 拉伸 |
| `lathe` | `profile: [[r, y], ...]`（r ≥ 0）；`segments?`（默认 32）；`angle?`（默认 360） | 绕 y 轴旋转的旋转体，用于圆桌、立柱、灯 |
| `sweep` | `path: [[x,y,z], ...]`；`section: { "circle": r }` 或 `{ "rect": [w, h] }`；`smooth?: r`（拐角圆滑半径）；`caps?: true` | 沿路径扫掠截面，用于椅腿、扶手、管子 |
| `loft` | `sections: [{ "y": h, "outline": 轮廓 }, ...]`（2 到 8 个截面，y 递增） | 少量截面之间放样；截面会被重采样到相同点数 |
| `group` | `children: [形状, ...]` | 组合；`transform` 作用于全部子形状 |
| `instance` | `template: "<模板编号>"` | 引用同一空间里的模板（同款椅子） |

**二维轮廓**：

```json
{ "points": [[x, z], ...], "closed": true,
  "arcs": [ { "from": i, "bulge": b } ],
  "fillets": [ { "at": i, "radius": r } ] }
```

- `points` 按逆时针排列。
- `arcs` 把第 i 点到第 i+1 点之间的直线换成圆弧，`bulge` 是 tan(圆心角 / 4)：正值向外凸，负值向内凹。
- `fillets` 在第 i 个顶点处倒圆角。

**模板**：

```json
{ "templates": { "chair-a": { "type": "group", "children": [ ... ] } } }
```

模板放在空间的物件集合里（物件 `kind: "template"`），实例用 `{ "type": "instance", "template": "chair-a", "transform": {...}, "material"?: {...} }`。实例给了 `material` 时覆盖模板里的颜色，用于同款椅子不同颜色。

## 3. 物件记录

物件记录的 `body` 字段（设计 4.4）：

```json
{ "entityId": "counter-01", "layer": "rebuilt", "kind": "object",
  "label": "前台", "anchorId": "counter-01",
  "shape": { ... 形状 ... },
  "bounds": { "min": [x,y,z], "max": [x,y,z] },
  "fit": { "meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81 },
  "props": { } }
```

- `bounds` 由生成方计算，用于权限范围检查和网站裁剪。
- `fit` 是可选的拟合质量。
- 结构元素（墙、地面、玻璃）也是物件，`kind: "structure"`，形状通常是带贴图的 `box` 或 `extrude`。

## 4. 区块编码（方块风格）

- 区块是 32×32×32 个 uint16，下标 `index = x + 32·(z + 32·y)`，小端字节序，共 65,536 字节，这是"规范字节"。
- **保留编号**：0 表示空或不覆盖，1 表示空气覆盖（只在扩展层），方块表从 2 开始。
- **区块哈希**：`sha256(0x01 ‖ 规范字节)` 的小写十六进制，其中 0x01 是格式版本。
- **存储**：存储时用 deflate 压缩（zlib 格式），哈希按未压缩的规范字节计算。

## 5. 内容哈希

- 对物件记录、状态清单等 JSON 对象计算内容哈希时，先做规范化：
  - 对象的键按 Unicode 码点排序；
  - 不留空白；
  - 数字用最短的往返表示，整数不带小数点；
  - 字符串用 JSON 标准转义。
- 规范化之后取 `sha256` 的小写十六进制。

## 6. 测试向量

`api/crates/metaverse-core/tests/vectors/` 下放：

- `chunk_*.json`：给定少量非零格子，写明期望的规范字节哈希和压缩后能解回原值；
- `canonical_*.json`：给定 JSON，写明期望的规范化字符串和哈希；
- `shape_*.json`：给定形状，写明期望的包围盒和三角形数（网站和处理服务据此核对网格生成）。

三种语言的测试都读同一批向量。
