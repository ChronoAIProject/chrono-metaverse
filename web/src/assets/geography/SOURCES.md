地面细节图采用 Poly Haven 的 CC0 实物扫描。三个通道分别保存草地、铺装与沥青的相对明暗，由原始反照率与 OpenGL 法线合成，以米为单位重复采样。场景的大尺度颜色、道路和阴影来自原有地理影像。

- [草地 Grass Ground](https://polyhaven.com/a/grass_ground)
- [混凝土铺装 Concrete Pavement](https://polyhaven.com/a/concrete_pavement)
- [沥青 Asphalt 01](https://polyhaven.com/a/asphalt_01)

独立草坪和广场网格使用以下 CC0 游戏材质。颜色使用 sRGB，线性表面图的 R、G 保存 OpenGL 切线法线的 X、Y，B 保存粗糙度。草皮一组样本宽 1.4 米，石材一组样本宽 2 米。

- 短草采用 ambientCG 的 Grass 004，源包为 Grass004_2K-JPG。[素材及许可](https://ambientcg.com/a/Grass004)
- 广场和压顶石采用 Poly Haven 的 Granite Tile 04，颜色取 2K，法线和粗糙度取 1K。[素材及许可](https://polyhaven.com/a/granite_tile_04)

铺装表面图的 A 通道保存石材的存水倾向。用同一份 Granite Tile 04 的 1K 高度、OpenGL 法线和粗糙度 PNG，依次作为输入传给 `scenes/marina-bay/scripts/bake-paver-surface.py`，第四个参数指定输出 WebP。石缝和湿边采用周期滤波离线烘焙，填入 128 至 252 的范围；湿痕的米制分布由材质控制。[风化方法参考 hypbr](https://github.com/wrong-nebula/hypbr/blob/58beced3de0d58a827c20a166789be9770855cbb/hypbr/weathering.py)
