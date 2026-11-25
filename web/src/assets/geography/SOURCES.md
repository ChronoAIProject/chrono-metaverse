地面细节图采用 Poly Haven 的 CC0 实物扫描。三个通道分别保存草地、铺装与沥青的相对明暗，由原始反照率与 OpenGL 法线合成，以米为单位重复采样。场景的大尺度颜色、道路和阴影来自原有地理影像。

- [草地 Grass Ground](https://polyhaven.com/a/grass_ground)
- [混凝土铺装 Concrete Pavement](https://polyhaven.com/a/concrete_pavement)
- [沥青 Asphalt 01](https://polyhaven.com/a/asphalt_01)

独立草坪和广场网格使用以下 CC0 游戏材质。颜色使用 sRGB，线性表面图的 R、G 保存 OpenGL 切线法线的 X、Y，B 保存粗糙度。草皮一组样本宽 1.4 米，石材一组样本宽 2 米。

- 短草采用 ambientCG 的 Grass 004，源包为 Grass004_2K-JPG。[素材及许可](https://ambientcg.com/a/Grass004)
- 广场和压顶石采用 Poly Haven 的 Granite Tile 04，颜色取 2K，法线和粗糙度取 1K。[素材及许可](https://polyhaven.com/a/granite_tile_04)

铺装表面图的 A 通道保存石材的存水倾向。用同一份 Granite Tile 04 的 1K 高度、OpenGL 法线和粗糙度 PNG，依次作为输入传给 `scenes/marina-bay/scripts/bake-paver-surface.py`，第四个参数指定输出 WebP。石缝和湿边采用周期滤波离线烘焙，填入 128 至 252 的范围；湿痕的米制分布由材质控制。[风化方法参考 hypbr](https://github.com/wrong-nebula/hypbr/blob/58beced3de0d58a827c20a166789be9770855cbb/hypbr/weathering.py)

地图拉伸建筑共用二十八层纹理，七层高楼窗墙取自 ambientCG 的 Facade018A、Facade019A、Facade006、Facade005、Facade013、Facade015 和 Facade020A。Facade015 的横向楼板和 Facade020A 的深色竖柱按各自的楼层间距重复。另有六层中高楼立面使用阳台凹槽、陶板竖条、石材立柱、蓝色层间板、成对窗及横向百叶。四层采用错列阳台、砂岩横窗、带搪瓷竖板的青灰玻璃及跨两层的混凝土框架。其余四种高楼立面使用错位敞廊、成组陶制遮阳板、预制混凝土洞口和错缝玻璃横窗。涂层使用 RibbedFront 材质中的细微明暗。玻璃和混凝土纹理分别来自 Facade005 和 Concrete Floor 02。四层街墙用砖墙、面砖、压型钢板和肋纹混凝土组合窗带、门扇和百叶。窗玻璃采样场景内的庭院日光。三层屋面分别为金属板、灰瓦和混凝土。墙面、金属和屋面扫描素材为 CC0，开间和楼层尺寸为视觉近似。[ambientCG](https://ambientcg.com/list?search=facade) · [Poly Haven 各材质来源](../../../../scenes/marina-bay/references/skyline-finishes/footprints.json)

草皮、花岗岩、地表细节和外墙屋面图集经过二次烘焙。用原始六张 WebP 所在的目录作输入，将另一目录作输出，运行 `scenes/marina-bay/scripts/bake-outdoor-finishes.py`。固定种子分别控制草簇拼接、石材磨耗与板面风化。颜色、法线和粗糙度按相同的归一化坐标取样。图集的 A 通道保存原有玻璃遮罩。
