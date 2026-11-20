# chrono-metaverse 界面改进意见：按 ChronoAI 设计语言统一

市场部 · 2026-11-20。看的是线上的 /connect、/ 和 /workspace（桌面 1440 px、手机 375 px）；三维预览页 /s/… 没有看到，改的时候用同一套规则。第 6 节「素材署名与地图图层」是当天补充的。

## 现在的问题

界面沿用了 CMA 产品界面的样式：荧光绿 #C8F542、#C3FD43 作强调色，Geist 和 Geist Mono 字体，另带一套米色浅色主题（#FAF2E0、#0E61AC）。这些都不是 ChronoAI 的设计语言。页面上也没有 ChronoAI 标识，favicon 是自己画的荧光绿立方体。

请按 ChronoAI 品牌使用说明 v2.4 改，参照公司官网 https://chrono-ai.fun/ 。官网样式表里的 `--c-*` 变量就是 ChronoAI 的颜色和字体。品牌说明在 GitHub 私有仓库 ChronoAIProject/Branding 的 `ChronoAI/README.md`；给 agent 的规则摘要在 `ChronoAI/AGENTS.md`，能读到就先读这份。

## 1. 颜色

直接用这组变量。前七个和官网同名同值，最后两个是官网卡片用的值：

```css
:root {
  --c-bg: #000000;                       /* 页面背景 */
  --c-fg: #FFFFFF;                       /* 标题、正文 */
  --c-btn: #1D51F6;                      /* 品牌蓝：主按钮、色块、图形、大号文字 */
  --c-link: #7691FF;                     /* 黑底上的链接、眉标、小标题、编号 */
  --c-muted: rgba(255, 255, 255, .8);    /* 次要文字 */
  --c-faint: rgba(255, 255, 255, .55);   /* 说明、提示等小字 */
  --c-line: rgba(255, 255, 255, .24);    /* 强分隔线、输入框边框 */
  --c-card: rgba(255, 255, 255, .02);    /* 卡片底 */
  --c-card-line: rgba(255, 255, 255, .12); /* 卡片边框 */
}
```

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| 页面背景 | #0B0B0C | #000000 |
| 卡片 | #141416 底，1px #1F1F23 边，圆角 12px | `--c-card` 底，1px `--c-card-line` 边，圆角 16px |
| 主按钮（前往 NyxID 授权） | 荧光绿底、黑字 | #1D51F6 底、白字（对比度 5.9:1） |
| 眉标（账号与授权） | 荧光绿 | #7691FF |
| 次要文字 | #A1A1AA | `--c-muted`；更小的提示用 `--c-faint` |
| 链接 | 灰色加下划线 | #7691FF，悬停变白 |
| 焦点框 | 荧光绿 | `:focus-visible` 用 2px 白色或 #7691FF 描边，间距 3px（官网的做法） |
| 浏览器顶栏颜色 `theme-color` | 浅色 #FAF2E0，深色 #060606 | 只有深色的页面（如 /connect）两条都写 #000000；能切换深浅色的页面，浅色写 #FFFFFF、深色写 #000000 |

- `--dsw-alias-*` 里所有指向荧光绿的别名都改指 ChronoAI 的颜色，例如 brand-primary、brand-text、state-business-primary、button-primary-fill / hover / active、glow-accent、shadow-accent-hover、ring-accent-soft、scrollbar-hover-l1 / l2。`--dsw-static-lime-*`、`coal-*`、`paper-*`、`ink-*` 四组色板不再使用。
- 品牌蓝 #1D51F6 在黑底上的对比度只有 3.6:1。只用于按钮底色、色块、图形和大号文字，不用于黑底上的正文和小字；小字要强调时用 #7691FF（7.3:1）。
- 空间页的页头可以切换深浅色（跟随系统 / 浅色 / 深色，见 web/README.md）。浅色主题也换成 ChronoAI 的浅色规则：白底 #FFFFFF、黑字，强调色和链接用 #1D51F6，标识换浅底版 `ChronoAI/logo/chronoai-logo-light.svg`。#7691FF 和 #8A8F9C 在白底上对比度不够，不用；浅底上的小号灰字用 #6B7080。米色那套（#FAF2E0 等）不再用。
- 成功、警告、错误的状态色，ChronoAI 规范里没有定义。错误和警告先保留现在的红色、琥珀色，只用在状态本身。「已连接」这类成功状态不再用荧光绿，改用白字加一个 #7691FF 圆点。

## 2. 字体

| 用途 | 字体 |
| --- | --- |
| 标题 | Inter Tight 600，字距 -0.02em |
| 正文、按钮、导航 | Inter 400 / 500 / 600 |
| 眉标、编号、代码和标识符（openid、组织 ID、/s/… 地址） | IBM Plex Mono 400 / 500 |
| 中文 | 思源黑体（Noto Sans SC），排在上面三种字体后面 |

```css
--c-head: "Inter Tight", "Inter", "Noto Sans SC", system-ui, sans-serif;
--c-body: "Inter", "Noto Sans SC", system-ui, sans-serif;
--c-mono: "IBM Plex Mono", "Noto Sans SC", ui-monospace, monospace;
```

- 去掉 Geist 和 Geist Mono。官网从 Google Fonts 加载 Inter Tight 600/700、Inter 400/500/600、IBM Plex Mono 400/500。
- 字号参考：页面标题 36–40px（手机 28–30px），卡片标题 20px，正文 15–16px，说明 13px。官网首页的大标题是 56–64px，首页首屏可以照官网放大。

## 3. 标识和图标

- 页眉左上角放 ChronoAI 标识：深底版 `ChronoAI/logo/chronoai-logo-dark.svg`（蓝色图形 + 白色字标）。官网用的 https://chrono-ai.fun/assets/chronoai-logo-dark.svg 是同一个文件（2026-11-20 核对，SHA-256 一致）。把文件拷进项目里用，不要直接引用官网地址。
- 尺寸照官网：宽 160px、高 32px。屏幕上宽度不能小于 120px。四周留白不少于图形高度的 1/4，32px 高时约 8px；文字、边框和其他元素不进入这片留白。
- 只用标识文件，不用字体或代码重画。不拉伸，不改色，不加发光和阴影，不降低透明度。
- 项目名 chrono-metaverse 不和标识排在一起，也不给它设计图标或字标。项目名写在页面标题区，例如眉标写「chrono-metaverse · 账号与授权」。
- favicon 换成 ChronoAI 的 App 图标 `ChronoAI/lockups/chronoai-app-icon.svg`（黑底方形，蓝色图形高约为边长的 40%），删掉现在的荧光绿立方体。
- 读不到 Branding 仓库的话，跟市场部要这两个文件。

## 4. 组件（照官网做）

- 主按钮：胶囊形（`border-radius: 999px`），高 40px，左右内边距 18px，Inter 15px 600，#1D51F6 底白字。悬停时 `filter: brightness(1.1)`。
- 次按钮：rgba(255, 255, 255, .08) 底、白字，Inter 15px 500，胶囊形。悬停时底色改成 rgba(255, 255, 255, .16)。
- 禁用按钮：透明度 40%，鼠标显示为不可点。旁边保留「连接 NyxID 后即可查询。」这样的原因说明。
- 卡片：颜色见第 1 节。可以点击的卡片，悬停时边框变成 rgba(118, 145, 255, .45)。
- 页眉：高约 72px，背景 rgba(0, 0, 0, .82) 加 `backdrop-filter: blur(10px)`，底边 1px rgba(255, 255, 255, .06)。左边放标识，右边放导航（Inter 15px 500，白字）。
- 眉标：英文用 IBM Plex Mono 14px 500，全大写，字距 0.08em；中文用思源黑体 14px 500。颜色用 #7691FF，或者和官网一样用白色。
- 步骤列表（连接后如何使用）：编号写成 01、02、03，用 IBM Plex Mono 14px、#7691FF；每一步上方加一条 2px rgba(255, 255, 255, .14) 的线；步骤标题用 Inter Tight 600。
- 状态标签（当前浏览器未连接）：胶囊形，rgba(255, 255, 255, .08) 底，`--c-muted` 字色。
- 输入框：透明底，1px `--c-line` 边，圆角 10px，高 40px。组织 ID 用 IBM Plex Mono。聚焦时边框变 #7691FF。
- 箭头：↗ 只用在去别的网站的链接上（前往 NyxID 授权 ↗、打开 NyxID ↗）。站内链接不用 ↗，「回到首页 ↗」去掉箭头；需要箭头时用 →。
- 首页：现在是一大片黑底中间一张小卡片。改成官网那样左对齐的首屏：眉标、大标题、一段说明、一主一次两个按钮。下面各区块之间用 1px rgba(255, 255, 255, .08) 的线隔开，内容宽 1200–1280px。
- 风格入口（原始扫描、写实建筑……）：小圆点的颜色代表渲染风格，可以保留；入口本身用次按钮的样式。在工作台里切换风格时，当前风格用 #7691FF 边框标出。
- 辅助图形（标识波形的大比例裁切、CHRONOAI 字符点阵、纹样）：只在首页首屏用，而且只用一种，用 Branding 仓库 `ChronoAI/applications/` 里的现成图。功能页（/connect、/workspace）保持纯黑。

## 5. 文案

- CMA 第一次出现时写「CMA（ChronoAI Managed Agent）」，之后写 CMA。
- 同一样东西只用一个名字：
  - 项目名：现在混用 chrono-metaverse、metaverse、「chrono-metaverse 查看器」。正文统一写 chrono-metaverse。
  - 连接页：工作台右上角叫「账号与组织」，眉标叫「账号与授权」，标题和首页按钮叫「连接 NyxID」。建议入口和标题都叫「连接 NyxID」。
  - 首页标题「你的空间，聊着改」、工作台标题「打开空间，聊着就能改」和英文眉标「YOUR SPACES, ONE CONVERSATION」说的是一件事，选一句统一。中文界面里不放英文眉标。
- 首页的两个链接示例一模一样：「空间链接形如 /s/空间编号#share=分享令牌，组合链接形如 /s/空间编号#share=分享令牌」，组合链接那个写错了。这类格式说明放进帮助或折叠区，用 IBM Plex Mono 显示。
- 「CMA worker」「proxy 权限」「本部署」「接口级限制」这类词，换成用户看得懂的说法，或者收进「技术细节」折叠区。
- 「这份授权是否只能查询组织角色？」的回答写得好：照实说了做到什么、没做到什么。新文案保持这种写法。
- 中文和英文、数字之间留一个空格，现在做得对，新文案保持。写 AI，不写「人工智能」；少用形容词。
- 页面标题（`<title>`）按页面写，例如「连接 NyxID · chrono-metaverse」，不要每一页都是「chrono-metaverse 查看器」。

## 6. 素材署名与地图图层（2026-11-20 补充）

三维空间里用到的第三方素材按下表处理。这几类许可都允许商用，按要求署名就行，不需要另外取得授权（瓦片来源见下面「要核对的三点」）。

| 素材 | 许可 | 怎么署名 |
| --- | --- | --- |
| 15 个模型 | CC BY 4.0 | 逐个写模型名、作者、原模型页面的链接、许可「CC BY 4.0」（链接到 https://creativecommons.org/licenses/by/4.0/ ），再注明「modified」。面板里写了这些模型经过调整（摆放烘进模型、减面、调色、缩小贴图），CC BY 4.0 要求标明改过。作者附了版权声明、许可声明或免责声明的，照原样保留 |
| 2 个 Poly Haven 素材（天空、黑板） | CC0 | 不要求署名，清单里顺带致谢 Poly Haven |
| 城市楼群：OpenStreetMap 数据，OpenMapTiles 矢量瓦片 | OSM 数据是 ODbL；OpenMapTiles 要求可见署名 | 写「© OpenMapTiles © OpenStreetMap contributors」：OpenMapTiles 链到 https://openmaptiles.org/ ，OpenStreetMap contributors 链到 https://www.openstreetmap.org/copyright |

地图图层：

- 不用 Esri 和 OneMap 两层，只保留 OpenStreetMap 楼体，加上上表的 CC BY 和 CC0 模型。远处的城市楼群本来就来自 OSM 和 OpenMapTiles，Esri 只是卫星底图，这部分画面风格基本不变；近处来自 OneMap 的部分见下面的「注意」。
- 卫星底图去掉以后，地面可以保持现在的样子，也可以重制：用 OSM / OpenMapTiles 里的道路、水面、绿地画一层自己的底图。不换成别家的卫星图。
- 已有空间的地图来源（`props.environment.map.sources` 和 `props.externalContent.sources`，见 docs/EXTERNAL_RESOURCES.md）里，Esri 和 OneMap 的条目一起删掉，相关的署名、logo 和密钥配置也删掉。
- 注意 OneMap 不只是影像。按 scenes/marina-bay/README.md，滨海湾近处的 257 个建筑部件（含 MBFC Tower 1 外壳、金沙酒店、艺术科学博物馆、摩天轮）和近景正射影像都来自 OneMap，远处的卫星图是 Esri World Imagery。去掉 OneMap 以后，这些建筑改用 OSM 楼体，或者重制；「ChronoAI · 14层办公室」标记用的 Tower 1 外壳也要重做。场景配置在 scenes/marina-bay/ 的 context.json 和 build/environment.json，改完按那份 README 重新生成、推草稿，由人看过预览再发布。

署名放在哪里、什么样子：

- OSM 和 OpenMapTiles 的署名直接显示在三维画面的一个角上（右下角是惯例），不能只放在要点开的「引用版权」面板里。PR #58 把署名全部收进了面板（之前有 CC BY 模型时画面底边有常驻的署名行），地图署名要恢复常驻显示，docs/ARCHITECTURE.md 里对应的说明一起改。可以在用户开始操作时或 5 秒后收起，收起后角上留一个 (i)，点开能看到完整的来源和许可。这是 OpenStreetMap 基金会署名指南（2021-06-25）对可浏览地图的要求。
- 15 个模型和 2 个 Poly Haven 素材的完整清单放在「引用版权」面板里。面板和按钮的名字建议改成「来源与许可」，更直白。
- 署名只用文字，不放第三方的 logo（ChronoAI 品牌说明：提到别家的产品只写名称，不用对方的 logo）。现在 `viewer__source-credit` 会显示来源的 logo 图片，去掉。
- 样式：Inter 12px，字色 `--c-muted`，下面垫一层 rgba(0, 0, 0, .6) 的底，放在任何画面上都看得清；链接悬停变 #7691FF。

要核对的三点：

- 矢量瓦片从哪里来。自己用 OpenMapTiles 工具生成，或者用允许商用的服务，就按上表署名。如果用的是 MapTiler 的服务：免费套餐只限非商业和测试用途，商用要付费，署名也要改成「© MapTiler © OpenStreetMap contributors」。
- 是否改过 OSM 的数据。只是照原样显示楼体，署名就够；如果改了数据（比如手工改楼高、和别的数据合并）再公开显示，ODbL 要求能提供改过的数据，或者说明改法。
- Poly Haven 的文件拷进项目自己托管。运行时直接从 api.polyhaven.com 取文件的话，还要遵守它单独的 API 条款。

## 7. 顺手修

- viewport 里去掉 `maximum-scale=1, user-scalable=no`，让手机能双指放大。
- 手机 375px 宽现在没有横向滚动，改完以后保持。

## 8. 不要做

- 不用 NyxID 的紫色 #5A2AF1、NyxID 标识和 Mona Sans 字体。这是 ChronoAI 的页面，NyxID 只写名字；官网上的「Try NyxID ↗」按钮也是 ChronoAI 蓝。
- 不保留荧光绿和米色主题。
- 不自己用字体排口号 Build for what comes next.。要放口号时，用 Branding 仓库 `ChronoAI/lockups/` 里的组合文件。
- 不给 chrono-metaverse 做 logo，也不和 ChronoAI 标识拼成组合。
- 不用 Esri 和 OneMap 的图层，也不换成别家的卫星图；署名里不放第三方 logo。

## 9. 改完自查

- 样式里不再引用 `--dsw-static-lime-*`、`coal-*`、`paper-*`、`ink-*`；全站搜不到 #C8F542、#C3FD43、#FAF2E0、#0E61AC 和 Geist。
- 黑底上小于 18px 的文字都没有用 #1D51F6；白底上没有用 #7691FF、#8A8F9C 写小字。
- 标识宽度不小于 120px，四周留白不少于图形高度的 1/4；favicon 是黑底蓝色图形。
- 手机 375px 宽能双指放大，没有横向滚动。
- 截一张 /connect 的图，和官网首页放在一起看：颜色、字体、按钮形状应该是同一套。
- 空间数据和浏览器的网络请求里，没有 arcgisonline.com、arcgis.com、onemap.gov.sg、onemap.sg 的地址。
- 打开任何一个空间，不点按钮就能在画面角上看到「© OpenMapTiles © OpenStreetMap contributors」，两个链接都能打开。
- 「来源与许可」里 15 个 CC BY 4.0 模型都有作者、原链接、许可链接和 modified；2 个 Poly Haven 素材写了致谢；没有第三方 logo。
