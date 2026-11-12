# 在空间里放置和调整内容

用户通过聊天提出需求、提供模型、查看预览和确认保存。worker 负责生成操作，用户不需要代码、JSON、坐标编辑器或仓库权限。

核心直接使用已有空间协议：`placeEntity` 新增或更新物件，`removeEntity` 删除，锚点和方块也使用各自的标准操作。家具、装饰、展品、建筑和背景不定义不同的编辑流程。`background`、距离显示、标记与材质只是物件的可选属性，不决定上传、权限或保存方式。

## 读取当前状态

在仓库外的空间工作区执行 `metaverse pull`，再 `metaverse edit inspect` 读取当前版本、物件、锚点和范围。修改已有物件时保留其编号和未要求改变的属性，用 `placeEntity` 提交更新；不要先删除再重建。根据用户需求决定位置和尺寸，不以整个场景的大小缩放单个真实物体。

## 外部模型与参数形状

GLB 不需要地图配置或独立地块：

```sh
metaverse-recon content import --model <文件.glb> --id chair-1 --label '休息区座椅' \
  --at 2 0 3 --yaw 30 --scale 1 1 1
```

输出为 `work/edit.json` 和按哈希存储的模型。米制比例默认保持；需要作为背景时才加 `--background`。大模型按平台三角形上限拆成普通物件。其他格式先由来源转换工具转成 GLB。网页附件由当前 worker 读取，不新建其他空间，也不执行文件里的程序。

不需要外部模型的内容直接使用 SHAPES 参数形状，写在标准 `placeEntity.entity.shape` 里；同一计划可混合形状、模型、模板、删除、锚点和方块操作。复杂程序化建造仍可使用已有 SDK 脚本，但这不是用户的前提条件。

## 连续天空和地图

需要地理背景时，在普通背景物件上设置 `props.environment: {version: 1, sky?, map?}`，仍用 `placeEntity` 提交。`sky` 使用等距柱状全景贴图 `{texture, yaw?}`，哈希同时声明在物件 `textures` 中，新图列入编辑计划的 `assets`。`map` 使用 `{latitude, longitude, origin: [x,y,z], heading?, sources}`：参考点的海平面位置以空间米坐标表示，朝向为局部 +z 相对正北的顺时针角。

`sources` 按顺序配置公开 HTTPS、支持 CORS 的 Web Mercator 影像 URL 模板（含 `{z}/{x}/{y}`）、署名、来源页面、`minZoom` 和 `maxZoom`，可带 `[西,南,东,北]` 覆盖范围。至少有一个从第 0 级开始的全球回退来源。不要把来源名称或地点写进通用代码，不使用有界地板或球壳冒充连续环境。地图瓦片保存在浏览器缓存，全景图和环境参数随空间版本保存。

代理物件的形状与范围必须落在当前授权区域内；背景渲染不会授予额外的地块写权限。修改已有环境时保留原编号，读取并保留未要求改变的字段。组合只启用第一个有效环境，因此新增前先检查现有物件。预览至少检查主体近景、拉远超出原地图范围、多个朝向、标记返回、刷新缓存和切换视图。

## 公开的外部数据源

用户可要求使用某个提供方或自己的服务器。公开地图和三维分片是普通物件的数据，不需要仓库、代码或部署权限。地图沿用 `props.environment.map.sources`，支持 `scheme: "xyz" | "tms"`；三维背景使用 `props.externalContent: {version: 1, format: "3d-tiles", sources, reference?}`，`sources` 为 1–4 份等价数据集的入口 `{url, attribution, page, logo?, license?: {label,url}, cache?: {persist,maxAgeSeconds}}`。示例与格式限制见 `docs/SHAPES.md`。

`reference` 的经纬度、海平面原点与朝向沿用地图规则；省略时三维分片使用标准局部 z 向上坐标，原点放在代理 `bounds` 的底面中心。必须保留代理形状、范围及 `background: true`，仍使用同一编辑检查、草稿预览和保存。距离显示和标记使用原有物件属性。

先确认服务允许外部浏览器读取全部依赖；拒绝访问时可添加有权限使用的备用源或使用已保存资源，不推测可绕过限制的入口。来源名称、地图入口、标志、许可及位置只写在物件中。不要把私有密钥放进公开来源 URL，也不向提供方转发平台凭据。缓存遵循服务端 HTTP 新鲜期，配置只能缩短，不能以固定天数覆盖 `no-store`。公开链接内容可能随提供方变化，需要精确历史时使用版本入口或上传快照资源。

预览应检查至少两个可替换来源、主体取景、距离显示、刷新缓存、来源不可用状态和移除后停止加载。用户确认的是当前草稿修订，变更提供方后仍需预览。

标准矢量瓦片可用 `props.externalContent.format: "mvt"` 接入：`sources.url` 为 TileJSON，`reference` 复用地图的米制地理参考，`extrusion` 声明多边形图层、顶高/底高字段、隐藏字段、默认/最大高度、颜色和加载距离。`excludeBounds` 保护已有精细内容。保留代理形状、范围和 `background: true`，仍通过普通编辑计划、预览和发布；完整字段见 `docs/EXTERNAL_RESOURCES.md`。不要把轮廓拉伸体块表述为实景贴图或测绘模型。

## 同一份编辑计划

```json
{
  "version": 1,
  "message": "调整空间陈设",
  "baseSeq": 3,
  "ops": [{ "op": "removeEntity", "entityId": "unused-decoration", "ifPresent": true }],
  "assets": []
}
```

`ops` 完全复用空间操作协议，不为具体内容发明第二套类型。`baseSeq` 用刚读取的真实版本；版本变化时重新核对。`assets` 只列本次需要上传的资源：`{hash,format,path?}`，格式为 GLB 或 PNG/JPEG/WebP；路径相对空间工作区，省略时使用 `assets/<hash>.<format>`。已经在线上的资源可以直接引用原哈希。新增资源全部在第一笔网络写入前核对哈希，服务端再次核对格式及尺寸限制。

```sh
metaverse edit check --file work/edit.json
metaverse edit push --file work/edit.json
```

默认在工作区当前作用范围编辑，可显式 `--plot <地块>`。已有实体区不需要新建地块。只有实际需要新范围时才用 `edit plan` 生成布局计划；应用布局需要管理权限，地块授权不能扩大为管理授权。

`push` 生成原生草稿预览。调整后重复检查与预览；用户确认当前预览才 `metaverse publish <草稿编号> --rev <确认的修订>`。SDK 默认沿用预览记录的修订。草稿被更改时必须重新预览；不自动覆盖或重放。

## 内容提供方与权限边界

OneMap、模型库、扫描重建等负责准备资源与物件。地图的 `context` 入口只把旧清单转换为标准操作，再调用 `edit`，没有自己的上传或发布逻辑。新增内容来源应生成同一计划，不向通用编辑层加入来源名称分支。

普通编辑仍受实体区/地块和扩展层权限约束；受保护的重建层通过重建包修改。该边界由图层和授权决定，与内容是不是房顶、家具或建筑无关。

已发布物件的模型、形状、材质、显示属性、标记与位置都在空间快照里。换 worker 后重新 `pull` / `edit inspect` 即可继续编辑；来源工具的配方可以作为可选数据附在物件上。浏览器缓存按资源哈希复用，不承担线上保存职责。

外部地图与三维来源可设置 `delivery: "server"`，由服务器按空间版本或预览权限获取，并按上游 HTTP 规则缓存到独立有界磁盘。跨目录的三维 buffer/image 通过 `resourcePrefixes` 声明 HTTPS 目录。此配置仍是普通物件的 props；不需要仓库权限或增加提供方分支。不得用服务器、伪造 Referer 或来源元数据绕过提供方的明确拒绝；字段与持久性限制见 `docs/EXTERNAL_RESOURCES.md`。
