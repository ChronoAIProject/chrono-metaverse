# MBFC Tower 1 十四层 · 滨海湾外景

基于 OneMap 官方三维地图下载并转换的滨海湾外景，作为扩展层接入现有的 `chronoai-lobby` 空间。复用系统已有的 52 个室内重建物件，通过系统自己的查看器和草稿接口验收。MBFC Tower 1 地址为 **8 Marina Boulevard, Singapore 018981**，位于滨海湾西南岸，金沙酒店在东偏北方向。

## 下载结果与来源

- 官方页面：https://www.onemap.gov.sg/3d
- 官方三维索引：https://www.onemap.gov.sg/omapi/tilesets/sg_noterrain_tiles/tileset.json
- 官方正射影像：https://www.onemap.gov.sg/maps/tiles/OrthoJPG/{z}/{x}/{y}.png
- 范围：西经度 103.8500、南纬度 1.2780、东经度 103.8647、北纬度 1.2918。
- 下载 49 个最高精度 B3DM 分片，共 825,204,456 字节；另外下载 36 张第 17 级正射影像。
- 转换出 257 个建筑部件、4 块影像地面，合计约 175 MiB。含金沙酒店、艺术科学博物馆、摩天轮、滨海湾周边建筑。
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

现有室内扫描没有提供地理朝向和十四层楼板标高。当前按**楼板标高 60 米、局部 +Z 指向北偏东 25°**配准，把海湾侧外墙放到室内主玻璃窗外。高度与朝向都是估值；需要现场窗景核准，不能视为测绘级定位。官方批次的楼层数不用于计算十四层高度。Tower 1 整栋外壳单独记录在 `build/own-tower.json`，不进入外景显示，以免挡住已重建室内。

在 `scripts/convert-onemap.py` 修改 `OFFICE_HEIGHT`、`HEADING` 后，依次重跑转换和地面脚本即可整体调整。地面采用平面正射影像，水面和树木没有额外生成可运动的几何模型。

## 重新下载、转换和校验

```sh
uv venv .venv --python 3.14
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python scripts/download-onemap.py
.venv/bin/python scripts/convert-onemap.py
.venv/bin/python scripts/prepare-ground.py
.venv/bin/python scripts/verify-scene.py
```

下载脚本只读取 OneMap 公开端点，不需要账户或 API 密钥。模型按建筑拆分，每个物件的局部原点在底面中心；贴图裁剪到当前建筑使用的范围，最大边长 2048；每物件最多 9 万三角形。

室内快照来自现有空间的 seq 5。重新拉取室内时：

```sh
node ../../sdk/typescript/dist/cli.js pull
node scripts/cache-office-assets.mjs
node ../../sdk/typescript/dist/cli.js check
node ../../sdk/typescript/dist/cli.js build
```

`layout.json` 定义室内实体区和 `marina-bay-exterior` 外景地块，已通过系统管理接口加入原空间（seq 6）。原来的室内重建物件、锚点与扫描资源沿用空间已有数据。所有外景实体都在扩展层，使用稳定的 `bay.*` 编号。

上传转换后的模型并生成系统草稿：

```sh
node scripts/upload-models.mjs --probe
node scripts/upload-models.mjs
node ../../sdk/typescript/dist/cli.js check
node ../../sdk/typescript/dist/cli.js push --inline --preview-ttl 604800
```

上传脚本最多并发三个模型，逐个等待系统的 GLB 核对任务完成。服务器已有同一模型时复用；上传清单保存在 `out/model-uploads.json`。`push` 生成系统预览链接，记录于 `out/drafts.json`。草稿不会自动发布；按建造技能要求，由人看过系统预览后再发布。

`node scripts/check-system-preview.mjs` 直接打开线上系统生成的预览链接，依次验收扩展视图和原有室内视图，保存加载报告与截图到 `out/system-preview-check.json`、`out/system-shots/`。
