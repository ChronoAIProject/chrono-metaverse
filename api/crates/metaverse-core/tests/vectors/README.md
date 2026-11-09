# 跨语言测试向量

接口服务（Rust）、网站（TypeScript）、处理服务（Python）各自实现 [SHAPES.md](../../../../../docs/SHAPES.md) 里的格式，用这里的同一批向量核对结果。

- **由 Rust 实现生成**：`tests/vectors.rs` 里定义用例，运行
  `METAVERSE_WRITE_VECTORS=1 cargo test -p metaverse-core --test vectors` 重新生成顶层的全部文件
  （`ops/` 见第 4 节）。
- **平时 `cargo test` 会核对**：每个文件都用 Rust 实现重算一遍；用例和文件对不上（忘了重新生成）时测试失败。
- **不要手改这些文件**。要加用例，改 `tests/vectors.rs` 再重新生成。
- **例外**：`uv/`（贴图坐标）和 `authored/`（AI 物件集的外链贴图）由 `tools/texture_vectors.py` 按 SHAPES 独立算出
  （只用 Python 标准库，不调用任何一边的实现），见第 5、6 节；改用例改这个脚本，`python3 tools/texture_vectors.py`
  重新生成，`--check` 只核对。

每个文件都有 `kind`（`chunk` / `canonical` / `shape` / `ops` / `ops-parse` / `uv` / `authored`）、`name` 和中文
`description`。各边要接上哪些运行器见第 7 节。

## 1. 区块：`chunk_*.json`

对应 SHAPES 4。

| 字段 | 含义 |
|---|---|
| `fills` | 先按顺序执行的填充：`{ "min": [x,y,z], "max": [x,y,z], "block": n }`，半开区间，后写的覆盖先写的 |
| `cells` | 再逐格写入：`{ "x", "y", "z", "block", "index" }`，`index` 是期望的下标 `x + 32·(z + 32·y)` |
| `byteLength` | 规范字节长度，恒为 65536 |
| `byteChecks` | 规范字节里若干位置的期望值：`{ "offset", "value" }`（每个 `cells` 格子两项，核对小端字节序） |
| `nonZeroCount`、`isEmpty` | 非 0 格子数；是否全 0（全 0 的区块不进清单） |
| `canonicalBytesSha256` | `sha256(规范字节)`，不含版本字节，方便排查 |
| `hash` | 区块哈希 `sha256(0x01 ‖ 规范字节)` 的小写十六进制 |
| `compressedBase64` | Rust 用 zlib 压缩后的字节（base64） |

核对方法：

1. 按 `fills`、`cells` 构造区块，核对下标、`byteChecks`、`nonZeroCount`、`isEmpty`、两个哈希；
2. 把 `compressedBase64` 解压，必须得到同一份规范字节；
3. 各语言自己压缩的结果**不要求**与 `compressedBase64` 逐字节相同，只要求能被其他语言解回原值。

## 2. 规范化 JSON：`canonical_*.json`

对应 SHAPES 5。

| 字段 | 含义 |
|---|---|
| `input` | 原始 JSON **文本**（字符串）。先把它当 JSON 解析，再规范化 |
| `canonical` | 期望的规范化字符串 |
| `sha256` | `sha256(canonical 的 UTF-8 字节)` |
| `error` | 只在应当拒绝时出现，目前只有 `"unsafe_integer"`（整数超出 ±(2^53 − 1)） |
| `record` | 可选。把 `input` 当作记录的 `body`：`{ "kind": "entity" \| "anchor", "spaceId", "hash" }`，`hash` 是 `records._id` 的算法——对 `{"body": …, "kind": …, "spaceId": …}` 规范化后取 sha256 |

要点（容易做错的地方都有专门的向量）：

- 键按 **Unicode 码点**排序。JavaScript 的默认排序按 UTF-16 码元，会把 U+1F600 排在 U+FF61 前面，必须自己按码点比较（`canonical_code_point_order`）。
- 数字按 ECMAScript `Number.prototype.toString` 输出：`1.0 → 1`、`-0 → 0`、`1e16 → 10000000000000000`、`1e21 → 1e+21`、`1e-7 → 1e-7`。Python 的 `repr` 在 `1e16` 上会写成 `1e+16`，需要自己实现（`canonical_numbers`）。
- 解析浮点数必须精确舍入。Rust 端为此打开了 serde_json 的 `float_roundtrip`。
- 字符串只转义 `"`、`\` 和 U+0000–U+001F（优先 `\b \f \n \r \t`，其余小写 `\u00xx`）；`/`、DEL、非 ASCII、U+2028 原样输出（`canonical_strings`）。

## 3. 形状：`shape_*.json`

对应 SHAPES 2。

| 字段 | 含义 |
|---|---|
| `shape` | 形状 JSON |
| `templates` | 可用的模板：`{ "模板编号": 形状 }`，可能为空对象 |
| `valid` | 是否应当通过校验 |
| `bounds` | `valid = true` 时的期望包围盒 `{ "min": [x,y,z], "max": [x,y,z] }`（米） |
| `tolerance` | 包围盒比较的绝对误差，目前是 `1e-9` |
| `triangles` | 可选。网格应有的三角形数：`plate` 一律给出（4n − 4），`hull` 只在点处于一般位置时给出（2V − 4，V 是凸包顶点数）；其他形状暂不给 |
| `errorPath`、`errorMessage` | `valid = false` 时 Rust 给出的 JSON 路径和说明，仅供参考；其他语言只要求同样拒绝。`errorPath = null` 表示在解析阶段就被拒绝（字段拼错、类型不认识） |

包围盒规则写在 `crates/metaverse-core/src/shape.rs` 的模块文档里，要点：

1. 局部包围盒按解析几何算，与分段数无关；圆角、倒角、`smooth` 只会缩小形状，忽略；`lathe` 不管 `angle` 一律按整圈；`sweep` 向各方向扩出截面外接半径；轮廓里的圆弧要算上落在坐标轴方向的极值点。
2. 再用 `transform` 变换局部包围盒的 8 个角点取包围盒，顺序是缩放 → 翻滚 → 俯仰 → 偏航 → 平移（`M = T · Ry · Rx · Rz · S`）。
3. 角度是 90° 的整数倍时 sin/cos 取精确的 0、±1；其他角度用标准库的三角函数，所以要按 `tolerance` 比较。
4. `group` 先求各子形状（含子形状自己的变换）的并，再整体变换；`instance` 取模板（含模板自己的变换）的包围盒再变换。

板和凸包的包围盒、合法条件、三角形数见 docs/SHAPES.md 第 2 节：`plate` 取各点和沿 −法向 平移厚度后的点，`hull` 取全部点。其他形状的三角形数取决于各自的分段方式，暂不给出。

**材质的平铺、着色、法线、粗糙度**（SHAPES 2"贴图坐标的平铺、着色、法线与粗糙度"）：`shape_material_tile`、
`shape_material_albedo_maps`、`shape_material_color_normal_map`、`shape_material_color_roughness`、
`shape_material_baked_explicit`、`shape_material_limits` 是合法的写法（全部是 `[2, 1, 0.5]` 的盒子，包围盒精确），
`shape_invalid_material_*` 各错一处：`tile` 越界、不是两个数、没有贴图坐标却带 `tile`，`offset` / `rotate` 越界或没给
`tile`，颜色材质带 `normalMap` 却没给 `uv`，`normalMap` 不是资源哈希，`normalScale` 越界或没给 `normalMap`，`roughness`、
`metalness` 越界，`shading` 不认识，形状里写了只有 AI 物件集才收的外链对象 `{url, sha256, size}`。

这批用例在 `tests/vectors.rs` 的 `texture_material_cases` 里，和其他形状向量一样由 Rust 实现生成（先按规格写好，
Rust 实现之后重新生成，文件没有变化）。接口服务、本地工具（`worker/`）、命令行三边都按同样的规则接受或拒绝，
错误路径一致。

## 4. 高层操作：`ops/ops_*.json`

对应设计 8.3 和 `crates/metaverse-core/src/ops.rs`。命令行（`sdk/typescript`）在本地应用操作（dev / shot / diff / check），用这批向量核对结果与服务端一致。

- **由 Rust 实现生成**：用例在 `tests/ops_vectors.rs` 里，运行
  `METAVERSE_WRITE_VECTORS=1 cargo test -p metaverse-core --test ops_vectors` 重新生成 `ops/` 下的全部文件；平时 `cargo test` 会重算并核对。
- **放在子目录 `ops/`**：`tests/vectors.rs` 把顶层的每个 `.json` 当作区块、规范化或形状向量核对，重新生成时还会删掉顶层的全部 `.json`，所以操作向量单独放一个目录。

### 4.1 作用结果：`kind = "ops"`

| 字段 | 含义 |
|---|---|
| `spaceId` | 计算记录哈希用的空间编号 |
| `base.palette` | 方块表（`palettes.blocks[]` 的形状：`{ id, name, kind, color \| texture, tags }`） |
| `base.fills` | 按顺序把格子写进基础状态：`{ "layer": "rebuilt" \| "ext", "box": [x0,y0,z0,x1,y1,z1], "block": n }`（格，半开区间） |
| `base.entities`、`base.anchors` | 基础状态里的物件、锚点 body（直接放进状态，不再校验） |
| `base.regions`、`base.plots` | 区域和地块，`scope` 据此算允许范围 |
| `scope` | `null`（不检查范围）、`"physical"` 或 `"plot:<编号>"` |
| `ops` | 操作列表（接口请求体里的 JSON 形状） |
| `probeCells` | 作用完成后要读的格子 `[x, y, z]` |
| `expect.baseChunks` | 按 `base.fills` 构造出的非空区块 `{ layer, cx, cy, cz, hash }`，先核对基础状态 |
| `expect.footprints` | 每条操作的影响范围 `{ "cells": [盒子…], "spaceWide": bool }`，按作用之前的状态计算；失败时只到失败的那条（影响范围本身就算不出来时不含那条） |
| `expect.ok` | 整批是否成功 |
| `expect.error` | 失败时：`{ "kind": "invalid" \| "scope", "index": 第几条（从 0 开始）, "message": Rust 的说明（仅供参考） }` |
| `expect.touched` | 成功时碰过的键：`{ chunks: [{layer,cx,cy,cz}], entities, anchors, palette }` |
| `expect.chunkChanges` | 与基础状态相比，碰过的区块的变化 `{ layer, cx, cy, cz, hash \| null }`（`null` = 区块变空，即删除；没变的不列） |
| `expect.chunks` | 作用后的全部非空区块 `{ layer, cx, cy, cz, hash, nonZeroCount }` |
| `expect.entities`、`expect.anchors` | 作用后的全部物件、锚点 `{ id, hash }`，`hash` 是 `records._id`（`{body, kind, spaceId}` 规范化后的 sha256） |
| `expect.provisionalBlocks` | 草稿里新增的方块 `{ name, id }`（临时编号） |
| `expect.probes` | `probeCells` 每格的 `{ cell, ext, rebuilt, effective }` |

作用规则（与 `WorkingState::apply_in_scope` 相同）：

1. 按顺序处理每条操作：先按**当前**状态算影响范围；给了 `scope` 就检查影响范围是否完全落在允许的盒子里（空间级的影响只允许 `physical`）；再作用到状态。
2. 任何一条失败，整批失败，状态保持不变。错误分两类：`invalid`（操作本身不合法、引用不存在、记录校验失败）和 `scope`（超出路径范围）。
3. 记录哈希按服务端存下的 body 计算：值为 `null` 的可选字段去掉，物件的 `props` 缺省为 `{}`（`props` 里面的 `null` 保留）。

### 4.2 结构检查：`kind = "ops-parse"`

`cases: [{ "input": 操作 JSON, "valid": bool }]`。`valid = false` 的输入必须在解析阶段就被拒绝（字段拼错、多余字段、类型不对、方块编号超出 0–65535、盒子不合法等）；`valid = true` 的只要求能解析，不要求能作用成功。

## 5. 贴图坐标：`uv/uv_*.json`

对应 SHAPES 2"贴图坐标的平铺、着色、法线与粗糙度"。放在子目录里：Rust 不生成网格，顶层的运行器也不认 `kind = "uv"`。

| 字段 | 含义 |
|---|---|
| `shape` | 形状 JSON，最外层带 `material`（贴图材质，或带法线贴图、有 `uv` 的颜色材质） |
| `templates` | 可用的模板，目前都是空对象 |
| `wrap` | glb 采样器的重复方式：`"repeat"`（给了 `tile`，`wrapS = wrapT = 10497`）或 `"clamp"`（没给，`33071`）。网站不给 `tile` 时保持现在的重复方式 |
| `tolerance` | `{ "position": 1e-5, "normalDot": 0.99, "uv": 1e-5 }` |
| `vertices` | 要核对的顶点：`{ "where", "position": [x,y,z], "normal": [x,y,z], "uv": [u,v] }`，`where` 是说明 |

核对方法：

1. 用各自的网格生成（网站 `web/src/core/shapes/build.ts`，本地工具 `processing/shape_mesh.py`）生成 `shape` 的网格；
   最外层的 `transform` 先去掉（贴图坐标在变换之前算，去掉不影响结果；目前的向量都没有最外层变换）；
2. 每个 `vertices` 用位置和法线找顶点：位置每个分量相差不超过 `tolerance.position`，并且单位法线与给出的方向
   （归一化后）点积不小于 `tolerance.normalDot`。至少要找到一个；找到几个，每个的贴图坐标都要与 `uv` 相差不超过
   `tolerance.uv`（逐分量）。用位置和法线而不是下标，是因为各语言三角化、顶点排列的顺序不同；同一位置的不同面靠
   法线区分。接缝上同一位置、同一法线有两个贴图坐标的顶点（圆柱 mesh 坐标的 +z、柱面投影的 −z）不放进向量；
3. `uv` 是网格里存的贴图坐标（v 向上，原点在图片左下角），不是 glb 里写的 `1 − v`。

覆盖：`box`（不给 `tile`；`tile`；`offset` + `rotate` 90°；`rotate` 30°）、`planar`（墙、挤出的地面）、`cylindrical`（有无
`tile`）、`mesh`（盒子的米坐标；圆柱不给 / 给 `tile`；挤出不给 / 给 `tile` + `offset` + `rotate`；板；扫掠）、写在组合上的
材质（子形状带 `transform`）、颜色材质带法线贴图。不给 `tile` 的几个（`uv_box_normalized`、`uv_cylindrical_normalized`、
`uv_mesh_cylinder_normalized`、`uv_mesh_extrude`）就是原来的算法。

## 6. AI 物件集的外链贴图：`authored/authored_*.json`

对应 SHAPES 2 合法条件第 5 条和 `docs/design/server-slim.md` 第 12 节：外链贴图 `{url, sha256, size}` 只出现在 AI 物件集
（本地文件）里，由本地工具 `bundle` 按外部模型同样的下载规则下载（主机列表 `METAVERSE_RECON_MODEL_HOSTS`，单个大小上限
`METAVERSE_RECON_MAX_TEXTURE_BYTES`），按贴图用途的上限（边长 4096）检查，作为 `texture` 文件进重建包，记录里换成哈希。
接口服务不收物件集，不跑这批向量。

| 字段 | 含义 |
|---|---|
| `cases` | 用例：`{ "name", "description", "authored": 物件集, "valid": bool, "summary"?, "where"? }` |
| `cases[].summary` | `valid = true` 时：`{ entities, templates, models, textureUrls }`：物件、模板、外部模型的个数，`textureUrls` 是去重后的外链贴图地址数，本地工具要整理出这么多个下载 |
| `cases[].where` | `valid = false` 时错在哪里：物件集里的路径（说明，仅供参考） |

- `authored_texture_urls_valid.json`：结构、组合、模板、实例、外部模型、烘焙指令和外链贴图混用的完整示例（同一个
  外链用了两次，只算一个），颜色材质带外链的法线、粗糙度贴图，以及一个最小的物件集。本地工具的物件集校验必须接受。
- `authored_texture_urls_invalid.json`：从最小的物件集改一处：不是 https、带用户名、`sha256` 大写或长度不对、`size`
  是 0、超过 16 MiB、是小数、是字符串、缺了，多了字段，工作台的 `{file}` 引用，`texture` 是数字，`normalMap`、
  `roughnessMap` 的外链写错，模板里的外链写错，烘焙指令和 `normalMap`、`tile` 一起出现。本地工具的物件集校验在下载之前
  就必须全部拒绝。

外链地址里的哈希、大小、提交号都是编的，用例只用来核对校验，不下载。

## 7. 各边的运行器

| 向量 | 接口服务（Rust，`metaverse-core`） | 网站（`web/`） | 本地工具（`worker/`） | 命令行（`sdk/typescript`） |
|---|---|---|---|---|
| `chunk_*`、`canonical_*` | `tests/vectors.rs` | —（`src/core/codec.test.ts` 用内联的向量） | `tests/test_shared_vectors.py` | `tests/vectors.test.ts` |
| `shape_*` | `tests/vectors.rs` | `src/core/shapes/solid.test.ts`（板、凸包、材质的网格） | `tests/test_shared_vectors.py` | `tests/vectors.test.ts` |
| `ops/` | `tests/ops_vectors.rs` | — | — | `tests/vectors.test.ts` |
| `uv/` | —（不生成网格） | `src/core/shapes/uv.test.ts` | `tests/test_shared_vectors.py`（`test_uv_vectors`） | —（不生成网格） |
| `authored/` | —（不收物件集） | — | 本地工具 `bundle` 的物件集校验（设计 13.2 S6b 接上，合法的还要核对 `textureUrls`） | — |

顶层的运行器按文件名前缀（`chunk_`、`canonical_`、`shape_`）挑文件，不会读到 `uv/`、`authored/`；这两类各边单独接上。
`shape_material_*`、`shape_invalid_material_*` 在顶层，现有的形状运行器直接读到：接口服务
（`vectors_match_rust_implementation`、`generated_vectors_are_current`）、本地工具、命令行按同样的规则接受或拒绝；
网站的运行器只核对合法用例的网格。
