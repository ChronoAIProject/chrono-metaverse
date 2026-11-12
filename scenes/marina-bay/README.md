# MBFC Tower 1 十四层 · 滨海湾外景

基于 OneMap 官方三维地图下载并转换的滨海湾外景，作为扩展层接入现有的 `chronoai-lobby` 空间。复用系统已有的 52 个室内重建物件，通过系统自己的查看器和草稿接口验收。MBFC Tower 1 地址为 **8 Marina Boulevard, Singapore 018981**，位于滨海湾西南岸，金沙酒店在东偏北方向。

## 下载结果与来源

- 官方页面：https://www.onemap.gov.sg/3d
- 官方三维索引：https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/tileset.json
- 官方正射影像：https://www.onemap.gov.sg/maps/tiles/OrthoJPG/{z}/{x}/{y}.png
- 范围：西界经度 103.8500、南纬度 1.2780、东经度 103.8647、北纬度 1.2918。
- 下载 49 个最高精度 B3DM 分片，共 825,204,456 字节；另外下载 36 张第 17 级正射影像。
- 转换出 257 个建筑部件、4 块影像地面，并增加 7 个 Tower 1 楼体分片和示意楼板，合计约 184 MiB。含金沙酒店、艺术科学博物馆、摩天轮、滨海湾周边建筑。
- `assets/onemap/manifest.json` 保留原始分片地址、SHA-256、批次属性和下载时间，`marina-bay.tileset.json` 可作为本地三维分片入口。
- 署名：**Map Data © 2026 SLA**。原始数据没有随代码纳入 Git。

## 系统内预览

在仓库根目录先安装 `web` 和 `sdk/typescript` 的依赖、编译 SDK，再进入本目录：

```sh
npm run dev
```

打开 http://127.0.0.1:4321/s/chronoai-lobby 。这是系统原有查看器，以拉取的空间状态加上本次扩展操作运行。选择“优化 + 扩展”时，办公室保持默认取景主体，滨海湾以真实米制尺寸作为窗外背景。所有外景物件标记 `props.background: true`：不拉远默认镜头，不显示巨大的地块边框，不参与室内剖切或点选；远裁面单独覆盖城市。选择“优化”可查看原有办公室。外景模型资源进入同一空间后，也可通过正式的草稿预览页查看。

截图和浏览器加载报告：

```sh
npm run shot
```

默认使用 macOS 已安装的 Chrome，截图输出在 `out/native-shots/`。

## 配准假设

地理参考来自官方 Tower 1 模型：纬度 `1.2801706774251347`、经度 `103.85419949862057`。模型的地心坐标经过 glTF 轴向校正后，转换为米制、y 向上的局部坐标，保留原始比例和建筑贴图。

办公室位于 **MBFC Tower 1 内部的十四层**。原先按整栋楼的外包范围对齐，会让窗边落到该高度的外墙之外；现在用官方楼体在办公室高度的截面，匹配现有主玻璃的方向，并检查室内地面全部位于楼体内。`build/placement.json` 记录统一旋转约 −6.545°、平移约 `[4.042, 0, 1.606]` 米，最终局部 +Z 指向北偏东约 18.455°；已有办公室坐标保持原位。

现有室内扫描没有提供绝对标高与单元号。十四层楼板暂按 **60 米标高**，办公室沿外墙的位置暂取临滨海湾一侧，仍需现场核准。官方数据没有室内平面图，不能据此确定具体单元。

`build/own-tower.json` 保留完整 Tower 1 外壳；`scripts/align-office.py` 从它生成下部楼体、上部楼体、十四层外墙四片和一块示意结构楼板。距办公室 80 米以内，上部楼体剖开供室内查看；拉远后补回官方完整外壳，显示“ChronoAI · 14层办公室”标记，点击返回室内。示意楼板不代表整层装修或房间布局。楼体分片作为背景加入同一扩展地块。

模型和贴图在浏览器的 `CacheStorage` 中保存，缓存名为 `chrono-metaverse-models-v1`，总量上限 512 MiB，超过后清理较早的资源。刷新先向服务器重新验证预览授权、读取最新草稿，再复用同一授权和修订下已经校验哈希的资源。缓存键只保存授权作用域的哈希。浏览器禁用存储时照常联网加载；清除站点数据会移除缓存。线上原件仍存于现有系统的 MongoDB GridFS，本地下载与转换文件位于本目录的 `assets/`。

缓存和查看器是通用能力。场景的名称、标记文字、实体引用、显示距离及配准参数集中在 `context.json`，楼层沿用 `build/alignment.json` 的来源数据；剖面边界直接从拉取的 `space.json` 实体区推导，不在生成器中重复填写办公室坐标。其他空间可以更换这些输入及模型，不需要修改查看器。通用字段见 `docs/SHAPES.md` 的 `backgroundView` 与 `landmark` 说明。

`.venv/bin/python scripts/check-context-reuse.py` 使用临时工作区验证不同名称、楼层、实体编号、平移及 90° 旋转，不修改当前场景。它复用本地已下载的模型，不联网；报告保存在 `out/context-reuse-check.json`。验收脚本的模型数量、远景分片数量、标记名称及点击返回范围也从当前场景清单推导。

`context.json` 的 `oneMap` 配置集中定义下载范围、地理参考、楼层、标高、朝向、宿主建筑来源编号、初始位置、来源署名和影像标签；空间、地块及区域编号从 `metaverse.json` 和拉取的 `space.json` 读取。下载、转换和地面生成脚本均支持 `--workspace <目录>`，宿主建筑分片从下载清单查找，更换地点不用改脚本。修改配置后，依次重跑转换、地面和楼内配准脚本即可整体调整。地面采用平面正射影像，水面和树木没有额外生成可运动的几何模型。

`.venv/bin/python scripts/check-import-reuse.py` 通过本机模拟源验证两个不同地点、楼层、宿主建筑、空间、区域及影像级别的完整下载和转换流程，不依赖线上数据或现有资源；该检查也纳入持续集成。

## 重新下载、转换和校验

```sh
node ../../sdk/typescript/dist/cli.js pull
uv venv .venv --python 3.14
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python scripts/download-onemap.py
.venv/bin/python scripts/convert-onemap.py
.venv/bin/python scripts/prepare-ground.py
.venv/bin/python scripts/align-office.py
.venv/bin/python scripts/verify-scene.py
```

下载脚本只读取 OneMap 公开端点，不需要账户或 API 密钥。模型按建筑拆分，每个物件的局部原点在底面中心；贴图裁剪到当前建筑使用的范围，最大边长 2048；每物件最多 9 万三角形。

室内重建来自空间的 seq 5；保存外景后的空间版本为 seq 8。重新拉取工作区时：

```sh
node ../../sdk/typescript/dist/cli.js pull
node scripts/cache-office-assets.mjs
node ../../sdk/typescript/dist/cli.js check
node ../../sdk/typescript/dist/cli.js build
```

重新拉取会同时得到已保存的背景。配准生成器按通用的背景标记筛出主体；预览验收替换当前配置前缀下的背景记录，避免重复计数。

`layout.json` 定义室内实体区和 `marina-bay-exterior` 外景地块，已通过系统管理接口加入原空间（seq 6），seq 7 补入办公室上方的虚拟范围以容纳完整楼体。原来的室内重建物件、锚点与扫描资源沿用空间已有数据。所有外景实体都在扩展层，使用稳定的 `bay.*` 编号。

上传转换后的模型并生成系统草稿：

```sh
node scripts/upload-models.mjs --probe
node scripts/upload-models.mjs
node ../../sdk/typescript/dist/cli.js check
node ../../sdk/typescript/dist/cli.js push --inline --preview-ttl 604800
```

仅重做楼体剖面时运行 `node scripts/upload-models.mjs --host`，其余 261 个模型直接复用已有资源，通过摆放变换整体配准。上传脚本最多并发三个模型，逐个等待系统的 GLB 核对任务完成。服务器已有同一模型时复用；上传清单保存在 `out/model-uploads.json`。`push` 生成系统预览链接，记录于 `out/drafts.json`。草稿不会自动发布；按建造技能要求，由人看过系统预览后再发布。

`node scripts/check-system-preview.mjs` 直接打开线上系统生成的预览链接，依次验收扩展视图和原有室内视图，保存加载报告与截图到 `out/system-preview-check.json`、`out/system-shots/`。

`node scripts/check-office-overview.mjs` 在同一原生预览中验收完整楼体、办公室标记与点击返回，同时检查刷新后的资源下载数为零、预览授权重新验证，报告保存至 `out/office-overview-check.json`。

2026-11-12 楼内配准验收：所有 263 个扩展物件通过范围与模型校验；线上原生预览加载 315 个物件、287 个模型实例，300 个资源请求成功，无脚本或网络错误。办公室地面全部位于 Tower 1 的对应高度截面内，最近外墙余量约 0.12 米。默认取景与原有办公室一致。

2026-11-12 缓存与整楼验收：新草稿包含 268 个外景物件，原生预览共加载 320 个物件、292 个模型实例；首次下载 305 份资源，刷新后资源下载数为 0，预览授权两次均重新验证。拉远能看到完整 Tower 1 和十四层办公室标记，点击返回室内。线上无脚本或网络错误，场景保持草稿状态。

2026-11-12 用户确认预览后保存至原空间：`seq 8`，提交 `aa65f277caf34001b23eb9af3beba69e`。保存后读取快照确认新增 268 个背景物件，原有 52 个室内物件的哈希、6 个锚点和扫描资源均一致。
