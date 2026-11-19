# 悬浮看台生成器

在已有空间的快照上运行 `uv run --script build.py snapshot.json output --bindings scene.json`。输出目录包含生成的 GLB、物件列表和该次快照对应的地块操作。生成不会发布场景。省略绑定文件时，使用快照实体的 `props.arenaBindings`。已有空间从 API 获取最新快照，新建时可用 `--bindings` 传入初始绑定。用 `entityPrefix` 指定生成实体的编号前缀，更新已有空间时沿用其前缀。

最小绑定只需要内场区域和输出区域。内场按区域所有格子盒的外包围盒定位，默认取最低面，可用米制 `floorY` 指定楼层。示例配置如下。

```json
{
  "infieldRegion": "hall",
  "outputRegion": "plaza",
  "screen": { "entity": "display", "facePath": [0] }
}
```

`screen` 可省略。`facePath` 是从模型的 shape 根节点到四边形贴图面板的子节点索引路径，根节点自身就是面板时传空数组。楼身的过渡可以通过 `upperBuilding`、`facades`、`entrance`、`floorSlab` 和 `alwaysVisible` 绑定已有物件。前厅的绑定保存在已发布镜像实体的属性里。使用其他区域或模型时可以单独提供这个 JSON。

## 发布会巡演

把版本为 1 的 `props.broadcastTour` 放在扩展视图可见的实体上。节目地址写入节目实体的 `props.liveScreen.url`。生成器从传入的最新快照保留镜像实体已有的节目源、巡演和自定义属性。

- `program` 引用本空间提供节目的实体。其 `props.liveScreen` 指定 `kind`（`youtube` 或 `hls`）、`url` 和矩形面板路径 `plate`。`mirror` 引用提供外框、面板和随镜头移动的播放器的实体，可以与节目实体相同。`linkedScreens` 可列出其他同步转播的屏幕。镜像和转播屏只需指定自己的 `liveScreen.plate`。
- `stops` 定义机位按钮的排列，每个机位有唯一的 `id` 和可见的 `label`。`initial` 指定进入空间时的机位。`order` 按机位 ID 编排“播放拉远”的路线，每次抵达后等待该机位的 `holdMs` 毫秒。
- `frame` 选择坐标原点。`local` 使用空间原点，`screen` 使用镜像屏中心，两者都以米为单位。`earth` 使用地心，以地球赤道半径为单位。用 `environment` 引用带有地理配准的地图实体。各坐标都按 X、Y、Z 排列，Y 向上。机位原点可再应用 `position` 偏移和 `rotation` 旋转（弧度，机位按 YXZ 顺序）。`camera.eye` 和 `camera.target` 是这一坐标系下的眼位和注视点。
- 手动拉远时按相机到镜像屏中心的距离选机位。`minDistance` 以米为单位，每个值唯一，最近一段从 0 开始。可用 `hideBeyond` 指定隐藏当前机位屏幕和设备的距离上限。
- 配置机位的 `screen` 可将镜像屏放在指定的 `position`、`rotation` 和 `scale`。省略时播放器回到原实体。设备也用这些字段设置位置、朝向和缩放。设备和屏幕旋转按 XYZ 顺序。
- `equipment[].model` 可以用 `{"entity":"模型实体编号"}` 引用本空间已上传并绑定 `assetHash` 的 GLB。也可以选择资源库中的 `shuttle` 穿梭艇、`cameraDrone` 摄影无人机、`cargoDrone` 货运无人机、`surveyPlane` 测绘机、`station` 空间站或 `rocket` 火箭。`count` 默认 1，每个巡演最多 256 个实例。`motion.kind` 可选 `route` 环线、`hover` 悬停或 `oscillate` 往复。以 `position` 为中心，`radius` 为三轴振幅，`period` 为主周期（秒），`phase` 为起始相位（弧度）。同组实例均分相位。悬停可用 `lookAt` 指定朝向的位置，往复可用 `turn` 指定角度振幅。

修改已发布空间时，从最新快照读取配置所在的完整实体，在地块草稿中更新其 `props.broadcastTour`。用草稿预览进入扩展视图，点击“播放拉远”，再点击起点机位检查返回。按已验收的草稿修订号发布后，重新打开空间即可读到新编排。
