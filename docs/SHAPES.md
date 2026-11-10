# 形状词表与跨语言约定

接口服务（Rust）、网站和命令行（TypeScript）、本地工具（Python）共用本文的数据格式。各边各自实现用得到的部分，靠 `api/crates/metaverse-core/tests/vectors/` 下的测试向量保证结果一致。第 7 节的重建包清单和第 8 节的资源核对记录是服务端瘦身（`docs/design/server-slim.md`）以后的格式。

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
- 两种材质都可以再带：
  - `opacity`：0–1，默认 1。小于 1 时半透明，用于玻璃。网站画成透明材质（不写深度、双面、在不透明物体之后画）；本地工具导出 glb 时写成 `alphaMode: "BLEND"`，透明度放进 `baseColorFactor` 的第四个分量。
  - `unlit`：布尔，默认 false。为真时不受光照，按颜色或贴图原样显示，用于屏幕、灯箱。网站用不打光的材质；glb 里写 `KHR_materials_unlit`。
  - 平铺、着色方式、法线贴图和粗糙度：`tile`、`offset`、`rotate`、`shading`、`normalMap`、`normalScale`、`roughnessMap`、`roughness`、`metalness`，见本节末尾的"贴图坐标的平铺、着色、法线与粗糙度"。都不给时与旧数据完全相同。
- 形状的局部原点：`box`、`cylinder`、`cone`、`extrude`、`lathe`、`loft` 的原点都在底面中心，形状向 +y 延伸。`sweep` 的原点就是路径坐标系的原点。`plate`、`hull` 直接用点的局部坐标，没有特别的原点。

| type | 字段 | 说明 |
|---|---|---|
| `box` | `size: [w, h, d]`；`fillet?: r`；`chamfer?: c`；`segments?: n`（圆角分段，默认 4） | 圆角半径和倒角都会被限制到不超过最短边的一半；两者同时给时以 `fillet` 为准 |
| `cylinder` | `radius`，`height`；`radiusTop?`（不给就是圆柱，给了就是圆台）；`segments?`（默认 32）；`fillet?`（上下边缘圆角） | — |
| `cone` | `radius`，`height`；`segments?` | — |
| `extrude` | `outline`：二维轮廓（见下）；`height`；`fillet?`、`chamfer?`（顶面和底面边缘） | 轮廓在 xz 平面，沿 +y 拉伸 |
| `lathe` | `profile: [[r, y], ...]`（r ≥ 0）；`segments?`（默认 32）；`angle?`（默认 360） | 绕 y 轴旋转的旋转体，用于圆桌、立柱、灯 |
| `sweep` | `path: [[x,y,z], ...]`；`section: { "circle": r }` 或 `{ "rect": [w, h] }`；`smooth?: r`（拐角圆滑半径）；`caps?: true` | 沿路径扫掠截面，用于椅腿、扶手、管子 |
| `loft` | `sections: [{ "y": h, "outline": 轮廓 }, ...]`（2 到 8 个截面，y 递增） | 少量截面之间放样；截面会被重采样到相同点数 |
| `plate` | `points: [[x,y,z], ...]`（3 到 64 个点）；`thickness: t`（0 < t ≤ 1 米） | 平面简单多边形沿 −法向 加厚成的板，用于前台这类斜面折板（见下） |
| `hull` | `points: [[x,y,z], ...]`（4 到 256 个点） | 这些点的凸包实体，用于楔形、船头这类凸多面体（见下） |
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

**板（`plate`）**：

```json
{ "type": "plate", "points": [[0,0,0],[2,0,0],[2,0.9,0.3],[0,0.9,0.3]], "thickness": 0.02 }
```

- **法向**：点的顺序按右手定则给出法向，从法向一侧看是逆时针。具体算法（三种语言相同）：中心 `c` 是各点的平均；Newell 法向 `N = Σ (Pᵢ − c) × (Pᵢ₊₁ − c)`（i 从 0 到 n − 1，最后一点接回第 0 点），面积 = `|N| / 2`，单位法向 `n = N / |N|`。
- **板的范围**：给出的多边形是一个面，板从这个面沿 −法向 延伸 `thickness`，另一个面是 `Pᵢ − t·n`。
- **合法条件**（不满足就整个形状无效）：
  1. 3 到 64 个点，坐标是有限值；`0 < thickness ≤ 1`；
  2. 相邻两点（含最后一点到第 0 点）的距离大于 1 微米；
  3. 面积不小于 1 平方毫米（点几乎共线时不合法）；
  4. **平面度**：最佳拟合平面取过 `c`、法向为 `n` 的平面，每个点到它的距离 `|(Pᵢ − c)·n|` 不超过 1 毫米；
  5. **简单多边形**：投影到一个坐标平面上检查——去掉 `|n|` 分量最大的那个轴（并列时先去 x、再去 y），剩下两个轴按 x、y、z 的顺序当二维坐标。相邻两条边不能折回（共线且方向相反），不相邻的两条边不能相交，端点接触、共线重叠也算相交。
- **包围盒**：各点 `Pᵢ` 和 `Pᵢ − t·n` 一起取包围盒，再按 `transform` 变换（规则同其他形状）。
- **网格**：正面就是给出的多边形（法向 `n`），背面是平移后的多边形（法向 −n），两面都按耳切法三角化（凹多边形也行，共线的点保留）；每条边一个平的侧面。三角形数 = 正面 n − 2 + 背面 n − 2 + 侧面 2n = **4n − 4**。
- **自然贴图坐标**（`uv: "mesh"`）：正面和背面用面内坐标（米）：`u` 轴是第 0 点到第 1 点的方向去掉法向分量后归一化，`v = n × u`，坐标从第 0 点（背面从它平移后的点）量起；侧面 `u` 是沿轮廓累计的边长，`v` 从背面 0 到正面 `t`。

**凸包（`hull`）**：

```json
{ "type": "hull", "points": [[0,0,0],[0.82,0.03,0.11],[0.79,0.62,0.07],[0.04,0.58,-0.21],[0.43,0.05,0.93]] }
```

- **合法条件**：4 到 256 个点，坐标是有限值，而且不能全部重合、共线或共面。判定方法（三种语言相同，容差都是 1 毫米）：`a` = 第 0 点；`b` = 离 `a` 最远的点；`c` = 离直线 `ab` 最远的点；`d` = 离平面 `abc` 最远的点（每一步都取第一个达到最大值的点）。`|b − a|`、`c` 到直线 `ab` 的距离、`d` 到平面 `abc` 的距离，任何一个不超过 1 毫米就无效。比 1 毫米还薄的东西应该用 `plate`。
- **包围盒**：全部点的包围盒（凸包的顶点都取自这些点，所以两者相同），再按 `transform` 变换。
- **网格**：凸包的每个面都是平的（硬边），三角形朝外。凸包顶点数为 V 时三角形数 = **2V − 4**；只有点处于一般位置（没有四点共面、没有三点共线）时这个数才是确定的——有四点共面时，落在面上或边上的点算不算顶点因实现而异。测试向量只对一般位置的点给出三角形数。内部的点不是顶点，不产生三角形。
- **自然贴图坐标**（`uv: "mesh"`）：每个三角形按面法向的主轴投影（米）：x 轴为主时取 `(z, y)`，y 轴为主时取 `(x, z)`，z 轴为主时取 `(x, y)`（并列时先 x、再 y），与 `uv: "box"` 的轴选择相同。

**模板**：

```json
{ "templates": { "chair-a": { "type": "group", "children": [ ... ] } } }
```

模板放在空间的物件集合里（物件 `kind: "template"`），实例用 `{ "type": "instance", "template": "chair-a", "transform": {...}, "material"?: {...} }`。实例给了 `material` 时覆盖模板里的颜色，用于同款椅子不同颜色：

- 实例给的是颜色材质：模板里的颜色部件换成实例的颜色；模板里的贴图部件保留贴图，用实例的颜色做 `tint`。实例材质带了 `opacity` / `unlit` 时一并覆盖，没带的保留模板部件自己的（所以重新上色的椅子上，玻璃部件仍然透明）。
- 实例给的是贴图材质：全部部件换成实例的贴图。
- 新加的平铺、着色、法线、粗糙度字段怎么覆盖，见下一小节"着色、法线、粗糙度"里的"模板实例"。

### 贴图坐标的平铺、着色、法线与粗糙度

扫描烘焙的贴图按包围盒铺满一次就对了；材质库的木纹、地砖、织物要按实际尺寸重复平铺，再带上法线和粗糙度才像。
形状材质（颜色材质和贴图材质都可以）可以再带下面这些字段。**都不给时与旧数据完全相同**：贴图坐标、网站的画法、
glb 导出都不变。

| 字段 | 取值 | 默认 | 含义 |
|---|---|---|---|
| `tile` | `[u, v]`：两个有限数，每个 0 < x ≤ 100 | 不给 | 贴图在表面上每重复一次的实际尺寸（米）。给了就按米算贴图坐标、重复采样；不给就是旧的按包围盒归一化 |
| `offset` | `[u, v]`：两个有限数，绝对值 ≤ 1000 | `[0, 0]` | 贴图坐标的平移（米）；只能和 `tile` 一起给 |
| `rotate` | 有限数，−360 ≤ x ≤ 360 | `0` | 贴图在表面上逆时针转的角度（度）；只能和 `tile` 一起给 |
| `shading` | `"baked"` 或 `"albedo"` | `"baked"` | 着色方式：`baked` 是扫描烘焙贴图的看法（贴图里已经带了光照），`albedo` 是固有色、完整受光（见下） |
| `normalMap` | 资源哈希 | 不给 | 切线空间法线贴图 |
| `normalScale` | 0 ≤ x ≤ 4 | `1` | 法线贴图的强度；只能和 `normalMap` 一起给 |
| `roughnessMap` | 资源哈希 | 不给 | 粗糙度贴图：灰度，白 = 粗糙 |
| `roughness` | 0 ≤ x ≤ 1 | 见"粗糙度和金属度" | 粗糙度；和 `roughnessMap` 一起给时是乘数 |
| `metalness` | 0 ≤ x ≤ 1 | 见"粗糙度和金属度" | 金属度，只有标量，没有贴图 |

**合法条件**（三种语言同样拒绝；向量 `shape_material_*`、`shape_invalid_material_*`）：

1. 取值范围如上；类型不对（`tile` 不是正好两个数、`shading` 是别的字符串、`normalMap` 不是字符串）同样拒绝；
2. `offset`、`rotate` 只能和 `tile` 一起给；`normalScale` 只能和 `normalMap` 一起给；
3. `tile` 只用于有贴图坐标的材质：贴图材质（本来就必须有 `uv`），或者带了 `normalMap` / `roughnessMap` 的颜色材质；
4. 颜色材质带了 `normalMap` 或 `roughnessMap` 就必须给 `uv`；两样都没带时仍然不能有 `uv`，也仍然不能有 `tint`（与原来相同）；
5. `normalMap`、`roughnessMap` 和 `texture` 一样是 64 位小写十六进制的资源哈希。只有 AI 物件集（本地文件）里可以
   写成外链对象 `{url, sha256, size}`，或本地文件 `{file}`（相对物件集文件的路径，不能是绝对路径、不能有 `..`，
   重建工作台 `texture`、`bake` 写的），由本地工具 `bundle` 下载或读取、核对后作为 `texture` 文件进重建包，记录里
   换成哈希（`docs/design/server-slim.md` 第 12 节）；形状本身（重建包和提交里的物件记录）只收哈希。

**资源引用**：`normalMap`、`roughnessMap` 和 `texture` 一样是物件引用的贴图资源。物件的 `textures` 列出形状里这三个
字段的全部哈希（去重，至多 64 个）。接口服务按形状收集引用（`Shape::texture_refs`：草稿追加时查用途和归属、
过清理的栅栏，发布时登记进 `assetRefs`，清理按这些判断引用），本地工具写物件的 `textures`，都把两个新字段算上。

#### 贴图坐标（三种语言相同）

贴图坐标在**声明材质的那一层形状**的局部坐标里算：这一层自己的 `transform` 之前，子形状的 `transform` 已经作用过
（与现在相同）。这一层下面所有还没有材质的部件一起算；`B` 是这些部件网格顶点的包围盒（不是解析包围盒），
`size = max(B.max − B.min, 1e-9)`（逐轴）。

第 1 步，取每个顶点的坐标 `(s, t)`：

| `uv` | 不给 `tile`（旧算法，不变） | 给了 `tile`（单位米） |
|---|---|---|
| `box` | 按顶点法线绝对值最大的轴选投影面（并列时先 x、再 y、再 z）：x → `(z, y)`，y → `(x, z)`，z → `(x, y)`；每个分量减去 `B.min` 的对应分量，再除以 `size` 的对应分量 | 同样选面、同样减 `B.min`，**不除**：相对包围盒最小角的米数 |
| `planar` | 所有顶点都按包围盒最薄的轴（`size` 最小的轴，并列时先 x、再 y、再 z）选投影面，其余同 `box` | 同左，不除 |
| `cylindrical` | `cx`、`cz` 是 `B` 在 x、z 上的中点，`φ = atan2(x − cx, z − cz) + π`（第一个参数是 x 方向的差，φ 在 0 到 2π）；`(φ / 2π, (y − B.min.y) / size.y)` | `R = (size.x + size.z) / 4`（包围盒在 xz 上的平均半径）；`(φ · R, y − B.min.y)`：弧长和高度 |
| `mesh` | 网格生成时的自然坐标（下表左列，不变） | 自然坐标的米版本（下表右列） |

第 2 步，只在给了 `tile` 时做（不给 `tile` 时贴图坐标就是 `(s, t)`）：

```
a = s + offset[0]
b = t + offset[1]
θ = rotate（度；是 90 的整数倍时 sin、cos 取精确的 0、±1）
u = ( a·cos θ + b·sin θ) / tile[0]
v = (−a·sin θ + b·cos θ) / tile[1]
```

顺序是**先加 offset、再转 rotate、再除 tile**：offset 和 rotate 在表面的米坐标里作用，tile 沿贴图自己的方向（转过
之后）量。效果是贴图在表面上逆时针转 `rotate` 度；offset 让纹理在表面上往反方向移这么多米（`offset: [0.1, 0]` 让纹理
往 −u 方向移 10 厘米）。v 向上，原点在图片左下角（与网站 three.js 相同）；导出 glb 时写 `1 − v`。

`mesh` 模式的自然坐标：

| 形状 | 不给 `tile`（现在的，不变） | 给了 `tile`：米版本 |
|---|---|---|
| `box` | 与 `uv: "box"` 相同的三面投影，按盒子自己的包围盒归一化到 0–1 | 同样的投影，从盒子自己的最小角 `(−w/2, 0, −d/2)` 量起的米数 |
| `cylinder`、`cone`、`lathe` | 侧面 u = 绕 y 轴转过的比例 `i / 步数`（0–1），v = 沿轮廓的累计长度 / 轮廓总长（0–1）；部分旋转的两个切面是 `(r, y)` | 侧面 u = `θ · r`：顶点绕 y 轴转过的弧度（从 +z 转向 +x）乘以该轮廓点的半径，也就是这一圈上从起点量的弧长；v = 沿轮廓从第一点量起的累计长度（米）；切面仍是 `(r, y)`。轮廓是展开圆角之后的：圆柱 `(0,0)→(r,0)→(rTop,h)→(0,h)`，圆锥 `(0,0)→(r,0)→(0,h)` |
| `extrude` | 已经是米：侧面 u = 沿（展开圆弧、圆角后的）轮廓从第 0 点量起的累计长度，v = 高度 y；顶面、底面是 `(x, z)` | 与左边相同 |
| `sweep` | 侧面 u = 截面一周的比例（0–1；矩形四条边各占 1/4），v = 路径累计长度 / 总长；端盖是 `(0.5 + a, 0.5 + b)` | 侧面 u = 沿截面边界的长度（圆：截面角度 × 半径；矩形：从 `(w/2, −h/2)` 起依次量四条边），v = 沿（圆滑后的）路径的累计长度；端盖是 `(a, b)`。`a`、`b` 是截面内的坐标（`a` 沿副法线、`b` 沿主法线，截面中心为 0） |
| `loft` | 侧面 u = 截面的弧长参数（0–1，从形心向 +x 的射线与轮廓的交点起逆时针量），v = `(y − 首截面 y) / (末截面 y − 首截面 y)`；顶面、底面是 `(x, z)` | 侧面 u = 参数 × 顶点所在截面的周长（即沿该截面从起点量的弧长），v = `y − 首截面 y`；顶面、底面是 `(x, z)` |
| `plate` | 已经是米（见上面"板"） | 相同 |
| `hull` | 已经是米（见上面"凸包"） | 相同 |

所以 `extrude`、`plate`、`hull` 给 `tile: [1, 1]`、不给 `offset`、`rotate` 时，贴图坐标与不给 `tile` 相同，只是采样
方式换成重复。另外两点：

- **米是局部坐标的米**：投影用声明材质那一层的局部坐标，`mesh` 用基本形体自己的局部坐标（它自己的 `transform`
  之前）。这一层、它下面或上面的 `scale` 不是 1 时，贴图跟着拉伸；要按真实尺寸平铺，就别在带材质的形状上用缩放，
  或者把 `tile` 按缩放换算。
- **接缝**：柱面投影在 −z 方向、旋转体和扫掠的 `mesh` 坐标在一圈的起点处各有一道接缝（坐标从周长跳回 0）。周长不是
  `tile[0]` 的整数倍时那里纹理接不上；要无缝，把 `tile[0]` 取成周长的整数分之一。

**采样方式**：给了 `tile` 的材质重复采样（glb 采样器 `wrapS = wrapT = 10497`，网站 `RepeatWrapping`）。不给 `tile` 时
各端保持现状：glb 写钳边 `33071`，网站现在用的是重复（坐标在 0–1 内时两者只差边缘一个纹素的过滤；`mesh` 模式下超出
0–1 的米坐标各端照旧）。法线贴图、粗糙度贴图和主贴图共用同一套贴图坐标和同样的采样方式。

#### 着色、法线、粗糙度

**着色方式**（`shading`）：

| | `"baked"`（默认） | `"albedo"` |
|---|---|---|
| 贴图材质 | 扫描烘焙的看法：贴图里已经带了光照。网站上贴图 × tint 只有 0.3 倍受光照，另加同一张贴图 × tint 的 0.72 倍自发光（`web/src/viewer/lighting.ts` 的 `applyTexturedLook`，与现在相同）；glb 写 `KHR_materials_unlit` | 贴图 × tint 是固有色，完整受光（标准的金属度—粗糙度材质，没有自发光）；glb 不写不打光扩展 |
| 颜色材质 | 完整受光（与现在相同） | 相同：颜色材质一直是固有色，两种取值画法一样 |

- `unlit: true` 优先：不打光，按颜色或贴图原样显示，`shading`、法线、粗糙度、金属度都不起作用（资源仍然算引用）。
  `opacity` 与着色方式无关，规则不变。
- 法线贴图、粗糙度、金属度作用在受光照的部分：`albedo` 是全部，`baked` 只有那 0.3 倍，所以对扫描烘焙贴图影响很小。
  模型库、材质库的贴图是固有色，用 `albedo`；扫描烘焙的贴图用 `baked`。

**法线贴图**：切线空间，OpenGL 约定：红 = +u 方向，绿 = +v 方向（贴图上方），与 glTF 相同；`RGB = (n + 1) / 2`，按
线性数据读（不做 sRGB 解码）。切线方向由最终的贴图坐标（`tile`、`offset`、`rotate` 之后）决定，所以法线跟着纹理一起转。
网格不带切线：网站在着色时按贴图坐标推出，glb 不写 `TANGENT`，查看器按 glTF 的规定自己算。`normalScale` 同时乘到法线
的 x、y 两个分量上。

**粗糙度和金属度**：粗糙度贴图读 G 通道（灰度图三个通道相同；有透明通道时忽略），线性数据，白（1）= 最粗糙。最终
粗糙度 = `roughness ×` 贴图值。给了贴图时 `roughness` 默认 1；没给贴图时默认是各端现在的值（网站不透明 0.82、半透明
0.1，glb 0.9）。金属度只有标量，默认也是各端现在的值（网站 0.02，glb 0）。网站没有环境贴图，粗糙度低于 0.5 的不透明面
会发暗、出亮斑，建模时不要写得低于 0.5；金属度也一样（金属没有漫反射，只剩灯光的高光），金属度越高越暗，网站上
金属件一般取 0.3–0.5。

**颜色空间**：颜色贴图（`texture`）是 sRGB；法线、粗糙度贴图是线性数据。同一个资源哈希可能被不同用途引用，网站的
贴图缓存按（哈希，用途）区分。

**模板实例**：实例给的是颜色材质时，只覆盖颜色（以及 `opacity`、`unlit`，规则不变），新字段不参与覆盖，模板部件保留
自己的 `uv`、`tile`、`shading`、法线、粗糙度等；实例给的是贴图材质时，全部部件换成实例的整个材质（含新字段），贴图
坐标按实例这一层算。按材质合并网格时，分组键要包含全部新字段。

#### glb 导出

本地工具导出形状的 glb（查看和对比用的 `processing/preview_glb.py`、重建工作台的 `bench/glbout.py`）时：

- `TEXCOORD_0` 写最终贴图坐标 `(u, 1 − v)`：`tile`、`offset`、`rotate` 已经算进去，不用 `KHR_texture_transform`；
- 采样器：给了 `tile` 的材质用 `{magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497}`，其余仍是现在的
  `wrapS = wrapT = 33071`；`textures` 按（图片，采样器）去重；
- 颜色贴图照旧写 `baseColorTexture`；`baseColorFactor` 是 tint（贴图材质）或 color（颜色材质）换成线性值，第四个分量
  是 `opacity`（规则不变）；
- `shading: "baked"` 的贴图材质写 `KHR_materials_unlit`，与现在扫描烘焙贴图的导出一致；不打光用不上法线和粗糙度，不写；
- 其余材质（`albedo` 的贴图材质、颜色材质）不写 `KHR_materials_unlit`（`unlit: true` 时照旧写），
  `pbrMetallicRoughness.roughnessFactor = roughness`、`metallicFactor = metalness`（默认值见上）；
- `normalMap` → `normalTexture: {index, scale: normalScale}`。图片原样嵌入，绿色通道不翻：glTF 的法线贴图同样是绿色朝
  贴图上方，v 写成 `1 − v` 只是换了原点，图片在表面上的位置和朝向不变；
- `roughnessMap` → `metallicRoughnessTexture`：另做一张同尺寸、不带颜色空间信息的 PNG，R = 255（不用），G = 粗糙度
  贴图的 G 通道，B = 255（金属度全由 `metallicFactor` 决定）；
- webp 图片写进 glb 之前转成 PNG（glTF 只认 png、jpeg）。

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

### 图层、编号和模板

- `layer` 是 `rebuilt`（重建层：按扫描重建的结构和物体，只经重建路径、由重建包写入）或 `ext`（扩展层：人和 AI 的
  修改，经实体区、地块路径写入）。物件和模板共用一个编号空间，两层也共用。
- **编号分区**：重建层新放的物件（含模板）编号必须以 `rb.` 开头；扩展层新放的物件编号不能以 `rb.` 开头。已有的
  旧编号不受影响：扩展层的照常可以改；重建层的旧编号（瘦身前服务端写的）只能删，要重新放就换成 `rb.` 开头。这样两层
  各用一段编号，地块合作方抢不走重建包要用的编号。锚点不分区（锚点编号有现实含义，数据源按它写事件）。
- **模板只能被同一层引用**：物件形状里 `instance` 引用的模板必须是同一层的模板；改模板的影响范围也只算同一层里
  用到它的物件。扩展层要用重建层的款式，就复制一份成扩展层模板。
- **模板引用的完整性**：每次追加（一批内联操作、一个操作文件、一个重建包）全部作用完，工作状态里物件（含模板）
  引用的模板都要在同一层存在；发布时在"最新版本 + 本次变化"上再查一遍。接口服务只报与这次变化有关的缺口（碰过的
  物件引用的模板不在，或碰过的模板——删掉、改了层或种类——还被引用），基础版本里已有的旧缺口不挡追加和发布。
  不满足时返回 409 `broken_template_ref`，列出缺的引用（物件编号、模板编号）。

### 草稿的种类与操作

操作按草稿所属的路径范围分两种（`docs/design/server-slim.md` 2.4）。核心库的工作状态带着这个"范围种类"，按它决定
能用哪些操作、写哪一层：

| 操作 | 实体区 / 地块草稿（调用方给出的操作） | 重建草稿（只由重建包展开产生，第 7 节） |
|---|---|---|
| `fill`、`hollowBox`、`replace`、`copyRegion`、`addBlock` | 可以（只写扩展层） | 拒绝 |
| `placeEntity` | 只放扩展层；编号不能以 `rb.` 开头 | 只放重建层；编号必须以 `rb.` 开头 |
| `removeEntity`（可带 `ifPresent`） | 只能删扩展层 | 只能删重建层（含旧编号） |
| `setScan`、`clearRebuilt` | 拒绝 | 可以 |
| `createAnchor`（可带 `ifNew`） | 可以 | 可以，必须带 `ifNew` |
| `moveAnchor`、`updateAnchor`、`removeAnchor` | 可以 | 拒绝 |

"拒绝"的操作返回 422 `op_not_allowed`（核心库的错误类别 `notAllowed`）。重建路径的允许范围与实体区路径相同，但
不能动空间级锚点 `_space`；空间没有定义实体区（`regions` 里没有 `kind: physical`）时，实体区路径和重建路径的允许
范围是"不与任何虚拟区、地块的盒子相交"的地方（"除去"模式，只碰到边界不算相交）。

- **`removeEntity` 的 `ifPresent`**（所有草稿都能用）：`{"op": "removeEntity", "entityId": "…", "ifPresent": true}`。
  这个编号的物件不存在就什么都不做（影响范围为空，也不算碰过）；存在时与不带一样。属于另一层的物件照样拒绝。
- **`createAnchor` 的 `ifNew`**（所有草稿都能用）：`{"op": "createAnchor", "anchor": {...}, "ifNew": true}`。这个编号
  现在就有（`exists`），或者在本空间的时间线上出现过（`existed`，草稿基础版本及更早，重放时是最新版本及更早）就
  什么都不做（影响范围为空，不算碰过，但结果里列出跳过了哪些）；从没出现过才新建。锚点 body 照样要合法。所以删掉的
  锚点不会被重建包重新建出来。"出现过"的集合由调用方给（服务端按提交的 `changedAnchors.id` 查）。
- **`setScan`**：设置这次提交的扫描层，一个草稿最多一次。

  ```json
  { "op": "setScan",
    "scan": { "assetHash": "<扫描资源>", "webModelHashes": ["<默认档>", "<低细节档>"],
              "transform": [16 个数，列主序，扫描坐标 → 空间坐标],
              "alignment": { "method": "auto", "rotationDeg": -61.42, "errorCm": 0.8 } },
    "observedAt": "2026-10-20T00:00:00.000Z" }
  ```

  `assetHash` 是 64 位小写十六进制；`webModelHashes` 是 1 到 2 个、不重复的资源哈希（[0] 是网站加载的那一档）；
  `transform` 是 16 个有限数（绝对值 ≤ 10⁷），最后一行 `0 0 0 1`，线性部分的行列式 > 1e-6（不镜像、不退化），平移的
  绝对值 ≤ 100000 米；`alignment` 可选，任意 JSON 对象，规范化后 ≤ 4 KiB，服务端原样保存、不解释；`observedAt`
  可选，RFC 3339。`setScan` 没有格子上的影响范围。
- **`clearRebuilt`**：`{"op": "clearRebuilt"}`。删掉重建层的全部物件（结构、物体、模板），扩展层、锚点、区块都不动；
  影响范围是被删的非模板物件。之后的 `placeEntity` 再放进新的重建层，所以"`clearRebuilt` + 全部物件"就是"重建层整体
  换成这一份"。
- **RFC 3339 时间**（`observedAt`、清单的 `createdAt`）：`YYYY-MM-DD`，`T`、`t` 或空格，`hh:mm:ss`，可选的小数秒，
  时区 `Z`、`z` 或 `±hh:mm`（偏移不超过 23:59）；日期必须存在；只有 23:59:60 按 23:59:59.999 算；在 0000–9999 年
  之间，整个字符串不超过 64 个字符。

### 引用外部模型的物件

从模型库里找到的现成模型，由本地工具导入、修正后导出成 glb（物件模型），上传核对通过后，
物件用 `assetHash` 引用它：

```json
{ "entityId": "sofa-01", "layer": "rebuilt", "kind": "object", "label": "沙发",
  "assetHash": "<处理后的 glb 的资源哈希>",
  "material": { "tint": [214, 196, 176], "shading": "albedo" },
  "transform": { "yaw": 178.5 },
  "bounds": { "min": [1.1, 0, 2.4], "max": [3.0, 0.82, 3.3] },
  "props": { "source": { "library": "polyhaven", "id": "<库里的编号>",
                         "page": "https://polyhaven.com/a/<库里的编号>",
                         "author": "<作者>", "license": "CC0-1.0", "title": "<标题>" } } }
```

- 物件可以只有 `assetHash` 没有 `shape`：网站加载模型，按 `bounds` 的底面中心摆放（模型坐标的原点在底面中心），所以模型的大小在重新导出时就要摆好；朝向可以烘进模型，也可以写在 `transform` 里。网站另有兜底：模型实际包围盒按 `transform` 转过之后的外包盒（下面"摆放"），某条边比 `bounds` 长出 max(2 厘米, 边长的 1%) 以上时，整体等比缩小、底面中心对齐放进 `bounds`，并在控制台记警告（服务端已经按下面"模型与记录一致"拒收这种模型，兜底只防旧数据和坏数据）。
- `transform`（可选，只能和 `assetHash` 一起给）：`{yaw?, pitch?, roll?}`，模型绕自己的原点转的角度（度，规则同形状的
  `transform`：有限值、绝对值不超过 3600，顺序同第 1 节 `Ry(yaw) · Rx(pitch) · Rz(roll)`）。没有 `position`、`scale`：
  位置由 `bounds` 定，缩放烘进模型；给了就拒绝。同一个模型摆几个朝向（会议室的一排椅子）时只要导出、上传一份 glb。
  **摆放**：模型包围盒的 8 个角点转过之后取外包盒，把这个盒子的底面中心对齐 `bounds` 的底面中心。只有偏航、模型原点
  在底面中心时，这就是"原点放在 `bounds` 的底面中心、绕竖直轴转"。本地工具 `models` 导出时把缩放、俯仰、翻滚和调色
  烘进模型，只把偏航写进 `transform`，`bounds` 就是这个外包盒（比模型实际占的地方略大，偏航 45° 时最多大约四成）。
- **物件模型 glb 的要求**（上传时按第 8 节核对，引用时按核对结果判断能不能当物件模型用）：只有三角形；节点用单位
  变换——节点变换和调色烘进顶点（服务端按顶点数据实测包围盒，带旋转的节点会让包围盒偏大）；原点在底面中心；扩展只能用
  `KHR_texture_transform`、`KHR_mesh_quantization`、`KHR_materials_unlit`、`KHR_materials_emissive_strength`；
  不能有骨骼、动画、变形目标、相机、灯光和外部图片；三角形数、贴图边长、贴图像素合计在物件模型的上限内（第 8 节）。
- **模型与记录一致**：只有模型、没有形状的物件，模型的实测包围盒（`check.bounds`）按物件的 `transform` 转过之后的
  外包盒（同上，没有 `transform` 就是它本身）三边长与物件 `bounds` 三边长之差不超过 max(2 厘米, 物件边长的 1%)，
  模型原点在底面中心（按模型自己的包围盒查：`|min.y|`、x 和 z 的中点都不超过 2 厘米），否则
  422 `model_bounds_mismatch`。这条保证网站摆出来和记录一致，范围检查用的 `bounds` 也就是真实的。
- `material`（可选，只能和 `assetHash` 一起给）给整个模型调外观：`tint: [r,g,b]`（sRGB 0–255，乘到模型原来的颜色上）、`opacity`（0–1）、`unlit`（布尔），含义与形状材质相同；没有 `color`、`texture`、`uv`，也没有 `tile`、法线、粗糙度这些形状材质的字段（模型自带的贴图和材质原样用）。
- `material.shading`：`"baked"`（默认）或 `"albedo"`，只影响网站怎么画模型里的材质：
  - `"baked"`（不给时，与现在相同）：模型里带颜色贴图、受光照的材质按扫描烘焙的看法画，0.3 倍受光照 + 0.72 倍自发光（`applyTexturedLook`）；
  - `"albedo"`：模型的贴图是固有色，按 glb 里的材质原样完整受光（不加自发光，模型自带的法线、粗糙度、金属度照常用）。
  - 模型库（Poly Haven、Objaverse 等）的模型应该用 `"albedo"`；从扫描切出来的模型保持 `"baked"`。AI 物件集里带 `model` 的物件由本地工具打包时默认写成 `"albedo"`，物件集里显式写了就照写。glb 本身带 `KHR_materials_unlit` 的材质两种取值都不打光；`unlit: true` 优先。
- `props.source` 是**署名**，`props.source` 是对象时按下面的规则严格校验（四种实现相同）：

  | 字段 | 规则 |
  |---|---|
  | `library` | `polyhaven`、`objaverse`、`sketchfab` 之一 |
  | `id` | 库里的编号，1 到 200 个字符，不含控制字符 |
  | `page` | 来源页，`https://` 开头，不超过 2000 个字符，不含空白和控制字符 |
  | `author` | 作者，1 到 200 个字符，不含控制字符 |
  | `license` | SPDX 风格的许可名，只能是 `CC0-1.0`、`CC-BY-4.0`、`CC-BY-3.0`（明确可商用、不传染；NC、ND、SA 一律不收） |
  | `title` | 标题，1 到 200 个字符，不含控制字符 |

  六个字段都必须给，不能有别的字段。署名是**写入方的声明**：服务端只校验格式（库和许可在白名单里、长度、https），
  不核实模型是不是真的来自那里。`props.source` 不是对象时（旧数据里识别来源的字符串 `hint` / `rules`）照旧当不透明的值；
  物体重建算法现在把识别来源写在 `props.detectedBy`，`props.source` 只留给署名。
- **署名必须可见**：场景里有 CC-BY 模型时，网站画面底边常驻一行简短署名（第一个须署名模型的标题、作者、许可，以及总数），不用点开就看得到；展开的"模型来源"面板列出场景里所有 `props.source` 的标题、作者、许可和来源页链接（纯文本，链接只接受 https，带 `rel="noopener noreferrer"`，许可链到许可正文），并注明这些模型可能经过调整（摆放烘进模型、减面、调色、缩小贴图）后重新导出、与原文件不同（CC BY 要求注明改动；说法不依赖具体工具，因为模型由写入方自己导出，服务端只核对格式）；点选物件时信息面板也显示它的来源。CC-BY 的模型必须这样署名。
- 模型库只用许可明确可商用的：Poly Haven（全部 CC0）和 Objaverse 里许可为 CC0 / CC-BY 的对象（每个对象有自己的许可字段，NC、ND、SA 一律排除，SA 也排除以免传染）；Sketchfab 只在设置了 `SKETCHFAB_TOKEN` 时可选。

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
- `shape_*.json`：给定形状，写明期望的包围盒和三角形数（网站和本地工具据此核对网格生成）。三角形数目前只给 `plate`（4n − 4）和点处于一般位置的 `hull`（2V − 4）；`shape_plate_*`、`shape_hull_*`、`shape_material_*` 和对应的 `shape_invalid_*` 覆盖本文新增的板、凸包、`opacity`、`unlit`，以及第 2 节"贴图坐标的平铺、着色、法线与粗糙度"的新字段（合法的取值和越界、类型错、缺少前提的写法）。
- `canonical_entity_model_source.json`：引用外部模型、带 `material.tint` 和 `props.source` 的物件记录的内容哈希。
- `uv/uv_*.json`：贴图坐标。给定形状和材质，按顶点的局部位置和法线找到顶点，写明期望的最终贴图坐标；覆盖 `box`、`planar`、`cylindrical`、`mesh`（盒子、圆柱、挤出、板、扫掠）× 有无 `tile`、`offset`、`rotate`，以及组合上的材质和颜色材质的法线贴图。期望值由 `tests/vectors/tools/texture_vectors.py` 按本文独立算出。网站和本地工具核对（接口服务不生成网格）。
- `authored/authored_*.json`：带外链贴图对象 `{url, sha256, size}` 和本地贴图 `{file}` 的 AI 物件集，合法和不合法各一份，由本地工具的物件集校验按 `valid` 接受或拒绝（接口服务不收物件集）。
- `ops/ops_*.json`：高层操作作用到工作状态的结果，含第 3 节"草稿的种类与操作"的规则（`ifPresent`、带历史的 `ifNew`、编号分区、同层模板、重建草稿的操作、"除去"范围、模板引用的完整性）。Rust 生成，命令行核对。
- `bundle/bundle_*.json`：第 7 节的重建包清单，合法和不合法的写法、出错的字段、引用表、展开成的操作，以及在旧重建层上推一次、推两次的结果（第二次没有变化）；`bundle_limits_default.json` 是第 8 节的默认上限。Rust 跑全部，命令行只跑结构校验和默认上限。

各边的测试都读同一批向量，各类向量的格式和各边要接上的运行器见 `tests/vectors/README.md`。

## 7. 重建包清单

重建包是本地重建的产物：一份清单（`manifest.json`）加清单里列出的文件，经命令行 `metaverse bundle push` 上传到重建
路径、交给重建草稿，由服务端按固定规则展开成操作（`docs/design/server-slim.md` 第 6 节）。清单**与托管位置无关**：只有
相对路径、用途、sha256、大小，不写任何下载地址；同一个包在本地、命令行推送和部署种子里是同一份字节、同一个哈希。

```json
{
  "format": "chrono-metaverse-rebuild-bundle",
  "version": 1,
  "tool": { "name": "metaverse-recon", "version": "0.2.0", "source": "git:<40 位提交哈希>" },
  "note": "前厅第 4 版：AI 物件集 52 件，结构按实测替换",
  "createdAt": "2026-11-20T08:00:00.000Z",
  "base": { "spaceId": "chronoai-lobby", "seq": 4 },
  "scan": {
    "assetHash": "<扫描 zip 的 sha256>",
    "webModelHashes": ["<scan-0.glb>"],
    "transform": [16 个数],
    "observedAt": "2026-10-20T00:00:00.000Z",
    "alignment": { "method": "given", "rotationDeg": -61.42, "tiltDeg": 0.09 }
  },
  "rebuilt": {
    "mode": "replace",
    "templates": [ { "entityId": "rb.chair-a", "layer": "rebuilt", "kind": "template", "shape": { … }, "bounds": { … } } ],
    "entities":  [ { "entityId": "rb.counter-01", "layer": "rebuilt", "kind": "object", "shape": { … }, "bounds": { … }, "anchorId": "counter-01" } ],
    "remove": []
  },
  "anchors": [ { "anchorId": "counter-01", "kind": "counter", "box": [ … ], "label": "前台", "visibility": "public" } ],
  "notes": "<notes.md 的 sha256>",
  "report": { "fit": { "meanCm": 4.31, "p90Cm": 8.71, "within3cm": 0.67 }, "entities": 52 },
  "files": [
    { "path": "scan/scan.zip",      "purpose": "scan",     "sha256": "…", "size": 5901234 },
    { "path": "web/scan-0.glb",     "purpose": "webmodel", "sha256": "…", "size": 13800000 },
    { "path": "models/3f9a….glb",   "purpose": "model",    "sha256": "…", "size": 412345 },
    { "path": "textures/8be8….jpg", "purpose": "texture",  "sha256": "…", "size": 51234 },
    { "path": "notes.md",           "purpose": "script",   "sha256": "…", "size": 9876 }
  ]
}
```

### 规则

清单本身不超过重建包清单的上传上限（默认 16 MiB，第 8 节）。字段为 `null` 等于没给（数组字段除外：`anchors`、
`files`、`rebuilt.templates`、`rebuilt.entities`、`rebuilt.remove` 给了就必须是数组）。

| 字段 | 规则 |
|---|---|
| `format`、`version` | 必须正好是 `chrono-metaverse-rebuild-bundle` 和 1；任何层级上不认识的字段一律拒绝（以后加字段就升版本） |
| `tool` | `name`、`version` 1–64 个字符，不含控制字符；`source` 可选，只能是 `git:` 加 40 位小写十六进制 |
| `note` | 1–2000 字，去掉空白后不能是空的，不含换行以外的控制字符（同提交说明） |
| `createdAt` | RFC 3339（第 3 节），只为追溯 |
| `base` | 可选；`spaceId` 按空间编号的格式，`seq` ≥ 1。命令行拿它当草稿的基础版本，部署种子不用 |
| `scan` | 可选；字段规则同 `setScan`（第 3 节），`observedAt`、`alignment` 都在 `scan` 里 |
| `rebuilt` | 可选；`mode` 是 `replace`（重建层整体换成这一份）或 `merge`（只放、改列出的物件，再删 `remove` 里的编号）。`remove` 只在 `merge` 时能非空，≤ 2000 个，编号合法、不以 `_` 开头、不重复，不能与 `templates`、`entities` 的编号重复（可以是旧编号）。模板 ≤ 200、物件 ≤ 2000；`templates` 里只能是 `kind: "template"`，`entities` 里不能是模板；`layer` 都必须是 `rebuilt`，编号都以 `rb.` 开头、互不重复。每条记录按第 3 节校验（含 `bounds` 包住形状）；形状引用的模板只能是本包的模板，`merge` 模式下也可以是目标空间重建层已有的模板。出现 `chunks` 字段按不认识的字段拒绝（第一版不写方块） |
| `anchors` | 可选，≤ 2000，编号不重复，不能是 `_space`，锚点 body 按锚点的规则校验 |
| `notes` | 可选，必须是 `files` 里用途为 `script` 的文件的哈希（建模记录） |
| `report` | 可选，任意 JSON 对象，规范化后 ≤ 64 KiB，服务端不解释；字符串（键和值）不能以 `/`、`~`、`file:` 开头，也不能是 `C:\`、`D:/` 这样的盘符路径 |
| 至少有一项 | `scan`、`rebuilt`、`anchors` 至少给一个 |
| 每条记录 | 清单文件里这条记录的原始 JSON ≤ 64 KiB（逐条解析的上限，与操作文件每行的上限相同）。本地工具写清单时记录不缩进 |
| `files[]` | ≤ 4096 项；只有 `path`、`purpose`、`sha256`、`size` 四个字段；`path` 是相对路径：`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，≤ 200 个字符，没有 `.`、`..` 段，不重复；`purpose` 是 `scan`、`webmodel`、`model`、`texture`、`script` 之一；`sha256` 64 位小写十六进制，同一哈希只出现一次；`size` ≥ 1 且不超过该用途的上传上限（第 8 节） |
| 引用 | 记录里引用的**每个**哈希都必须在 `files` 里、用途对得上：`scan.assetHash` → `scan`，`webModelHashes` → `webmodel`，物件的 `assetHash` → `model`，形状材质的 `texture`、`normalMap`、`roughnessMap` 和物件的 `textures` → `texture`，`notes` → `script`。包是完整的：在任何空间里，只要这些文件都在或能上传，就能展开 |

校验按上表的顺序做（先 `format`、`version`，再整体结构，再逐项），出错时给出字段的 JSON 路径（如
`rebuilt.entities[3].assetHash`；整体结构不对时是 `$`）。Rust（`metaverse_core::bundle`）和命令行
（`sdk/typescript/src/core/bundle.ts`）给出同样的字段，向量核对（同一条记录里同时错几处时，命令行可能报在记录本身上）。

### 展开成操作

只在服务端（接口服务交包、部署种子）展开，按清单顺序：

```
1. 有 scan：              {"op": "setScan", "scan": {assetHash, webModelHashes, transform, alignment?}, "observedAt"?}
2. rebuilt.mode = replace：{"op": "clearRebuilt"}
3. 每个模板：             {"op": "placeEntity", "entity": 模板}
4. 每个物件：             {"op": "placeEntity", "entity": 物件}
5. rebuilt.mode = merge：  每个 remove 编号 {"op": "removeEntity", "entityId": 编号, "ifPresent": true}
6. 每个锚点：             {"op": "createAnchor", "anchor": 锚点, "ifNew": true}
```

展开出的操作按重建草稿的规则作用（第 3 节）。同一个包在内容没变时再推一次，结果没有变化：整体替换是"清掉再放同样的
内容"；合并模式的删除带 `ifPresent`；锚点带 `ifNew`。

### 谁查什么

| 在哪 | 查什么 |
|---|---|
| 本地工具 `metaverse-recon bundle` | 生成时按上限导出（上限取工作区的 `limits.json`，没有就用第 8 节的默认值），不实现清单校验和展开 |
| 命令行 `metaverse bundle check` | 本节的全部规则（不展开）；本地有的文件按第 8 节检查 |
| 接口服务：交包 | 本节全部；文件属于本空间且核对结果合乎用途；展开后每条按第 3 节 |
| 接口服务：发布 | 冲突、范围（按最新区域）、模板引用的完整性、没有变化不提交 |

## 8. 资源核对记录与各用途上限

上传的文件由服务端核对：边读边算 sha256，同时按用途检查文件内容（不解码网格、不解码图片，只读文件头、glb 的 JSON 块、
`POSITION` 访问器的数据和图片头），把核对结果记在资源的 `metadata.check` 里（`docs/design/server-slim.md` 4.3–4.6）。
引用一个资源时先要属于本空间，再看 `check` 合不合这个**角色**；不看第一次登记时记的种类。

### 各用途的格式和上限

| 用途 | 经哪条路径 | 接受的格式 | 大小上限（默认） | 检查 |
|---|---|---|---|---|
| `scan` | 重建 | glb、drc、obj、zip | 1 GiB | glb：头、JSON 块（≤ 8 MiB）的结构、没有外部引用，不算三角形和包围盒；drc：`DRACO` 魔数、版本、编码类型是网格；obj：文本、首个关键字；zip：见下 |
| `webmodel` | 重建 | glb | 64 MiB | glb 完整检查，JSON 块 ≤ 4 MiB；三角形 ≤ 50 万；贴图边长 ≤ 4096；全部贴图像素合计 ≤ 2 × 4096²；坐标绝对值 ≤ 100000 米 |
| `model` | 全部 | glb | 50 MiB | glb 完整检查，JSON 块 ≤ 2 MiB；三角形 ≤ 10 万；贴图边长 ≤ 2048；像素合计 ≤ 4 × 2048²；坐标绝对值 ≤ 1000 米 |
| `texture` | 全部 | png、jpeg、webp | 50 MiB | 魔数与格式一致；读图片头拿宽高（读不到就拒绝）；边长 ≤ 4096，像素 ≤ 4096² |
| `ops` | 实体区、地块 | NDJSON，可 gzip | 64 MiB | 解压后 ≤ 256 MiB；每行 ≤ 64 KiB、UTF-8、去掉空白后以 `{` 开头 |
| `script` | 全部 | UTF-8 文本 | 4 MiB | UTF-8，不含 NUL |
| `bundle` | 重建 | JSON | 16 MiB | `format`、`version` 对得上，`files` 是数组（完整校验在交包时做，第 7 节） |

**zip**（扫描）：中央目录 ≤ 1 MiB、≤ 64 个成员，不收 zip64；本地头与中央目录一致（文件名、大小）、压缩方式只能是存储或
deflate、没有加密、各成员的数据区间都在文件内且互不重叠；成员名不能是绝对路径、不能含 `..` 段；`__MACOSX/` 下的成员和
`.DS_Store` 忽略（仍查路径安全）；其余必须正好一个网格成员（glb、drc、obj），别的只能是 jpg、png、mtl。服务端不解压成员。

**glb 完整检查**（网页用模型、物件模型）：

1. 头：魔数 `glTF`、版本 2、头里的总长度等于文件大小；第一个块是 JSON，第二个块（可选）是 `BIN`，没有别的块。
2. JSON：`asset.version` 是 `"2.0"`；`buffers` 至多 1 个，不能有 `uri`；`images` 只能用 `bufferView` + `mimeType`
   （`image/png` 或 `image/jpeg`）；缓冲区视图在 BIN 块里，访问器在各自的缓冲区视图里，不收稀疏访问器；图元只收三角形；
   `POSITION` 是 `VEC3`，浮点数（声明了 `KHR_mesh_quantization` 时也可以是字节或短整数），有有限的 `min`、`max`；不收
   骨骼、动画、变形目标、相机；扩展只能用 `KHR_texture_transform`、`KHR_mesh_quantization`、`KHR_materials_unlit`、
   `KHR_materials_emissive_strength`（`extensionsRequired` 只能是前两个），任何对象上的 `extensions` 键也按这张表查。
   数组长度上限：节点 10000、网格 1000、每个网格的图元 256、访问器 20000、缓冲区视图 20000、材质 256、贴图 256、
   图片 64、场景 16。
3. 三角形数：从场景（`scene`，没写就是 0）的根节点往下走，节点不能成环、不能有两个父节点；每个引用网格的节点，
   三角形数 =（有 `indices` 时是它的 `count`，否则是 `POSITION` 的 `count`）/ 3，必须是整数；同一个网格被几个节点引用
   就算几次。
4. 实测包围盒：读 `POSITION` 的数据算每个访问器的实际最小、最大值，与声明的 `min`、`max` 相差超过
   max(1e-4 × |值|, 1e-6) 就拒绝；世界包围盒 = 每个访问器的实测盒子的 8 个角点经所在节点的世界变换后取外包，坐标上限按它查。
   节点的 `matrix` 必须能分解成平移、旋转、缩放（最后一行是 0 0 0 1、没有切变），否则 `glb_json`：网站把它先分解再组合，
   最后一行不看。
5. 图片头：PNG 读 `IHDR`；JPEG 从 `SOI` 起按段长度逐段跳过直到 `SOF0`–`SOF2`（走完这张图还没找到就拒绝）；魔数必须与
   `mimeType` 一致。单张边长、全部像素合计按用途的上限查。

### 核对记录 `metadata.check`

只取决于文件内容，格式版本 `v` 目前是 1：

| 格式 | `check` |
|---|---|
| glb | `{v: 1, format: "glb", triangles, nodes, meshes, materials, images: [{w, h, mime}], maxTextureSide, texturePixels, extensions: [...], bounds: {min, max}}`。`bounds` 是实测的世界包围盒；扫描用途的 glb 只做轻量检查，`triangles`、`bounds` 为 `null` |
| png、jpeg、webp | `{v: 1, format, width, height}` |
| zip | `{v: 1, format: "zip", mesh: "<网格成员名>", members}` |
| drc、obj、ndjson、gzip、text、json | `{v: 1, format}` |

### 按角色判断

| 角色 | 引用的地方 | `check` 要满足 |
|---|---|---|
| 扫描 | `setScan.scan.assetHash` | `format` 是 glb、drc、obj，或是有 `mesh` 的 zip |
| 网页用模型 | `setScan.scan.webModelHashes[]` | `format = glb`，有 `triangles` 和 `bounds`，三角形、贴图边长、像素合计、坐标、扩展都在网页用模型的上限内 |
| 物件模型 | 物件的 `assetHash`、事件显示的 `entityAsset` | `format = glb`，同上但按物件模型的上限；另有第 3 节"模型与记录一致" |
| 贴图 | 形状材质的 `texture`、`normalMap`、`roughnessMap`，物件的 `textures`，方块贴图 | `format` 是 png、jpeg、webp，边长、像素在贴图上限内 |
| 文本 | 提交的 `scriptRef`、清单的 `notes` | `format = text` |

上限按**当前配置**判断：调低上限以后，旧资源也可能不能再被新引用（已有提交不受影响）。只做过轻量检查的 glb（扫描用途）
不能当网页用模型或物件模型；同一份字节再按这两种用途上传时，服务端做完整检查后补写 `check`。

### 上限 `uploadLimits`

`GET /api/v1/spaces/{space_id}` 返回当前生效的上限 `uploadLimits`，命令行写进工作区的 `limits.json`，本地工具和
命令行据此提前检查；没有 `limits.json` 时用默认值（下面就是默认值；Rust `metaverse_core::limits`，TypeScript
`sdk/typescript/src/core/limits.ts`，向量 `bundle/bundle_limits_default.json` 核对两边相同）：

```json
{ "v": 1,
  "scan":     { "maxBytes": 1073741824 },
  "webmodel": { "maxBytes": 67108864, "maxTriangles": 500000, "maxTextureSide": 4096, "maxTexturePixels": 33554432, "maxCoord": 100000 },
  "model":    { "maxBytes": 52428800, "maxTriangles": 100000, "maxTextureSide": 2048, "maxTexturePixels": 16777216, "maxCoord": 1000 },
  "texture":  { "maxBytes": 52428800, "maxSide": 4096, "maxPixels": 16777216 },
  "ops":      { "maxBytes": 67108864 },
  "script":   { "maxBytes": 4194304 },
  "bundle":   { "maxBytes": 16777216 } }
```

glb JSON 块的上限、zip 中央目录的上限、glb 各数组的长度上限是固定常量，不开放配置。
