# 跨语言测试向量

接口服务（Rust）、网站（TypeScript）、处理服务（Python）各自实现 [SHAPES.md](../../../../../docs/SHAPES.md) 里的格式，用这里的同一批向量核对结果。

- **由 Rust 实现生成**：`tests/vectors.rs` 里定义用例，运行
  `METAVERSE_WRITE_VECTORS=1 cargo test -p metaverse-core --test vectors` 重新生成全部文件。
- **平时 `cargo test` 会核对**：每个文件都用 Rust 实现重算一遍；用例和文件对不上（忘了重新生成）时测试失败。
- **不要手改这些文件**。要加用例，改 `tests/vectors.rs` 再重新生成。

每个文件都有 `kind`（`chunk` / `canonical` / `shape`）、`name` 和中文 `description`。

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
| `errorPath`、`errorMessage` | `valid = false` 时 Rust 给出的 JSON 路径和说明，仅供参考；其他语言只要求同样拒绝。`errorPath = null` 表示在解析阶段就被拒绝（字段拼错、类型不认识） |

包围盒规则写在 `crates/metaverse-core/src/shape.rs` 的模块文档里，要点：

1. 局部包围盒按解析几何算，与分段数无关；圆角、倒角、`smooth` 只会缩小形状，忽略；`lathe` 不管 `angle` 一律按整圈；`sweep` 向各方向扩出截面外接半径；轮廓里的圆弧要算上落在坐标轴方向的极值点。
2. 再用 `transform` 变换局部包围盒的 8 个角点取包围盒，顺序是缩放 → 翻滚 → 俯仰 → 偏航 → 平移（`M = T · Ry · Rx · Rz · S`）。
3. 角度是 90° 的整数倍时 sin/cos 取精确的 0、±1；其他角度用标准库的三角函数，所以要按 `tolerance` 比较。
4. `group` 先求各子形状（含子形状自己的变换）的并，再整体变换；`instance` 取模板（含模板自己的变换）的包围盒再变换。

三角形数暂未给出：网格的分段方式由网站的网格生成代码确定后，再在这里补 `triangles` 字段。
