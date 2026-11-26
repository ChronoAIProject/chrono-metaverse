# 丹戎禺屋面与滨水石材

三组住宅与水上活动中心沿用 OneMap 测绘模型。每个测绘编号决定一套配色。坡屋面沿檐口和坡向铺瓦，平台与压顶按水平面铺花岗岩，侧墙和挑檐底使用抹灰。鱼尾狮公园保留七级踏面的原有花岗岩，从另一份花岗岩扫描中裁取完整石面用于立板。瓦型、石材品种、颜色与表面风化按日间观感估计。

颜色、切线法线和粗糙度取自同一套 CC0 扫描。原始图集的实物尺寸及作者记录在 scans.json。颜色图经材质内的相对亮度校正，使不同实拍中的石材和瓦片服从场景配色。

- barrel，Amal Kumar。[Poly Haven](https://polyhaven.com/a/clay_roof_tiles)

- interlock，Amal Kumar。[Poly Haven](https://polyhaven.com/a/clay_roof_tiles_02)

- flat-clay，Amal Kumar。[Poly Haven](https://polyhaven.com/a/clay_roof_tiles_03)

- grey-tile，Rob Tuytel。[Poly Haven](https://polyhaven.com/a/grey_roof_tiles)

- cut-stone，Amal Kumar。[Poly Haven](https://polyhaven.com/a/granite_tile_04)

- render，Amal Kumar。[Poly Haven](https://polyhaven.com/a/painted_plaster_wall)

- 鱼尾狮公园立板从 Granite Tile 02 的单块石面内部取色、法线和粗糙度。[Poly Haven](https://polyhaven.com/a/granite_tile_02)

在场景目录运行 `python scripts/coastal_finishes.py` 可从 residences.json 记录的原始模型重建三组外景。原有鱼尾狮公园建造脚本在导出石阶时应用立板材质。
