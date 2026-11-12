# 背景、所在楼体与返回主体的标记

这是可选的内容提供工具。普通物件编辑先使用 [通用空间编辑](../../metaverse-builder/references/edit.md)；无需地图配置或楼内配准。这里生成的清单由 `metaverse context` 转换成同一标准编辑计划，统一调用 `metaverse edit` 检查、上传和预览。

用户在网页聊天中描述位置、楼层和效果，由 worker 执行以下操作。用户只需要空间的相应权限；不用 GitHub 账号、平台仓库写权限、部署权限或自己填写坐标。工具源码来自任务固定提交，所有数据写在仓库外的空间工作区。

先 `metaverse pull --assets`，再 `metaverse-recon context inspect`：读取真实区域、主体物件编号、已有背景配置。主体取景、房顶剖切和浏览器缓存由查看器统一处理。背景始终标记 `props.background: true`；不要通过缩小城市模型去迎合室内镜头。

## OneMap 来源

先从用户提供的地点和官方资料确定范围与参考点。楼层不等于绝对标高；缺少实测标高、朝向或单元位置时，把估计依据交给用户核对。

```sh
metaverse-recon context init --prefix exterior. --label '建筑周边背景' \
  --bbox <西经度> <南纬度> <东经度> <北纬度> \
  --reference <纬度> <经度> --floor <楼层> --height <绝对标高米> \
  --heading <朝向度> --attribution '<来源署名>'
metaverse-recon context download
metaverse-recon context inspect
```

`init` 生成版本 1 的 `context.json`。从 inspect 的 `buildings` 选择宿主来源编号，更新 `oneMap.hostSourceId`。可按需求添加 `oneMap.imagery`：`{urlTemplate,zoom,atlasFile,label}`；URL 中用 `{z}/{x}/{y}`。

```sh
metaverse-recon context check
metaverse-recon context convert
metaverse-recon context ground    # 配置了 imagery 时运行
```

`convert` 输出独立建筑模型、宿主模型和坐标变换。`oneMap.initialPlacement` 的 `centerX/frontZ` 是初始平移；后面的楼内配准会精确调整它，不改室内原点。经纬度、范围、楼层、标高、朝向、署名和来源地址均属于配置数据。

当前 OneMap 适配器处理带 RTC_CENTER、_BATCHID 和建筑批次属性的 B3DM；节点 transform 和其他供应商格式会明确拒绝。不同数据源可以先转成 GLB，通过下文的通用导入接入。不能把距离显示控制描述成整座城市的流式加载。

下载缓存保存在当前工作区 `assets/onemap/`，每份文件记录来源地址与内容摘要；切换来源或缓存损坏后会重新下载。它与查看器的浏览器缓存各自独立。

## 需要近景剖开宿主楼体、远景补回整栋楼时

从真实快照选择地面与玻璃外墙，给 `context.json` 添加 `host`。以下是字段示意，编号和文字都由当前空间决定：

```json
{
  "modelFile": "build/own-tower.json",
  "entityPrefix": "exterior.host",
  "label": "所在建筑",
  "levelLabel": "所在楼层",
  "focusRegionId": "主体实体区域编号",
  "floorEntityId": "真实地面物件编号",
  "facadeEntityId": "真实玻璃外墙编号",
  "sectionHeightMeters": 1.4,
  "facadeDirection": [0, 1],
  "facadeNormalMinDot": 0.98,
  "facadeEdgeMinLengthMeters": 3,
  "facadeInsetMeters": 0.12,
  "minimumClearanceMeters": 0.05,
  "boundaryMarginMeters": 0.02,
  "sliceOverlapMeters": 0.01,
  "overviewDistanceMeters": 80,
  "landmark": { "label": "返回主体", "offset": [0, 0, 0.08] },
  "slab": { "thicknessMeters": 0.25, "color": [145, 147, 150, 255] },
  "note": "记录标高、朝向和单元位置的依据与尚待核准的部分"
}
```

切面高度用空间米坐标；依主体所在区域调整，不假定所有楼面都在 y=0。当前自动配准需要地面的 extrude 轮廓，以及带 yaw 的玻璃外墙形状；复杂凹楼体需要人工核对截面凸包。不能将“可显示多层几何”当作“已支持完整楼层语义”。

```sh
metaverse-recon context align
metaverse-recon context build
```

检查 `build/placement.json` 的包含关系和外墙余量，再看原生查看器截图。生成器可重复运行；已保存背景不会扩大主体或点击返回范围。

## 其他来源的 GLB

网页可向已有 worker 上传 GLB/ZIP，或提供模型来源链接。GLB 使用下列命令；ZIP 只读取模型文件，不执行其中的程序。

```sh
metaverse-recon context import --model <文件.glb> --prefix exterior. \
  --label '背景名称' --at <x米> <y米> <z米> --yaw <偏航度> \
  --attribution '<来源署名>' --landmark '返回主体' --overview-distance 80
```

模型保持米制比例和贴图，导入时统一为底面中心原点。背景可以带 `props.backgroundView` 距离显示条件和 `props.landmark` 点击返回标记；字段来自空间协议，不能往查看器添加场景分支。

## 上传、预览与保存

给工作区指定独立的背景地块（`metaverse.json.plot` 或 `--plot`）。初次导入地块尚不存在时，转换器使用它作为新区域编号。

```sh
metaverse context plan
metaverse admin set-layout out/context/layout.json
metaverse pull
metaverse context check
metaverse context push
```

`plan` 只生成布局计划，保留主体和其他地块，并排除已占用区域；先检查计划，再在用户建设需求及当前权限范围内设置布局。无管理权限时说明需要空间管理员提供可用地块，不能扩大授权。布局更新是一次独立时间线提交，模型仍只在草稿中。

`push` 先检查范围，再上传哈希寻址的 GLB，等待服务端核对并生成原生预览；不会自动发布，也不会覆盖已有 `build/main.ts`。用户检查近景、远景、标记、贴图和房顶后，用 `metaverse publish <草稿编号> --rev <已确认修订>` 发布；本地预览记录也会自动携带修订。冲突不能自动覆盖。缓存沿用查看器，清除浏览器站点数据不影响线上保存。

配置保存在第一个背景物件的 `props.backgroundConfig`，与草稿一起发布。换一个 worker 时：

```sh
metaverse pull --assets
metaverse-recon context inspect
metaverse-recon context restore --prefix exterior.
```

恢复会重建 `context.json` 和背景清单，不依赖之前的 worker、脚本目录或 Git。调整配置后可重新下载/转换/配准；只调整摆放、距离、文字时可修改清单数据。不同背景组用不同前缀；工具只替换同前缀背景，不删除主体、锚点或其他背景组。
