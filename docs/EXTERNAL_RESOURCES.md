# 外部资源的服务端获取与缓存

来源配置放在普通背景物件的 `props.environment.map.sources` 或 `props.externalContent.sources` 中。增加提供方、切换来源、调整署名、缓存期限与依赖目录都沿用编辑计划、草稿、预览和发布，无需修改仓库。系统没有提供方名称、城市坐标或建筑编号的分支。

给来源添加 `"delivery": "server"` 即可由服务器获取；省略或设为 `direct` 保持浏览器直连。服务器可读取不开放浏览器 CORS、但允许服务器正常下载的公开 HTTPS 资源。访问拒绝仍返回失败，不自动改变来源标识、注入第三方凭据或退回其他访问路径。来源需要正式账户授权时，应先通过提供方支持的方式获得可用数据或地址；本功能不托管提供方密钥。

```json
{
  "url": "https://tiles.example.org/city/tileset.json",
  "delivery": "server",
  "resourcePrefixes": ["https://cdn.example.org/city-materials/"],
  "attribution": "示例数据提供方",
  "page": "https://tiles.example.org/",
  "license": {
    "label": "数据许可",
    "url": "https://tiles.example.org/license"
  },
  "cache": { "persist": true, "maxAgeSeconds": 3600 }
}
```

上例是三维来源；地图来源沿用 `urlTemplate`、层级和 XYZ/TMS 规则。三维分片默认只允许索引所在目录，额外的纹理或缓冲区目录用 `resourcePrefixes` 显式声明，最多八项。目录必须是 HTTPS、以 `/` 结束且不带查询参数。每一跳重定向也必须在这些范围内。地图请求严格匹配模板中的 z/x/y、配置层级和有效瓦片编号，不能把同一域名当作任意网址代理。服务端当前仅连接标准 HTTPS 443 端口。

浏览器请求本系统接口时携带现有的分享、组合成员、浏览器会话或草稿预览权限。服务器每次先验证版本与来源属于这个空间或草稿，再查询缓存。预览过期、草稿追加操作或发布后，旧预览不能继续读取缓存。所有平台凭据停留在本系统，出站请求不携带 Cookie、Authorization、Referer。署名、标志和许可继续由统一查看器展示；标志仍是无凭据浏览器请求。

公开空间接口为 `GET /api/public/spaces/{space_id}/external?seq=...&entity=...&kind=map|content&source=0&url=...`，草稿为 `GET /api/public/previews/external?...`。浏览器会话走对应的 `/api/auth/nyxid/view/spaces/{space_id}/external` POST 路由。授权响应本身使用 `no-store`，保证缓存命中也重新校验权限。三维索引、B3DM、GLB/glTF、外部 buffer/image 和地图瓦片共用这一机制。

服务器磁盘缓存与永久空间资产分离，不占用 MongoDB。配置：

| 环境变量               | 默认值                                        | 用途                 |
| ---------------------- | --------------------------------------------- | -------------------- |
| `EXTERNAL_CACHE_DIR`   | 系统临时目录下 `chrono-metaverse-external-v1` | 本实例专用的绝对目录 |
| `EXTERNAL_CACHE_BYTES` | 536870912（512 MiB）                          | 磁盘总容量；0 禁用   |

每个实例独占自己的目录，以原子替换写入完整内容，按保存时间淘汰；相同 URL 的并发下载合并。每实例最多八个出站下载，单请求总时限 25 秒；三维单项最多 32 MiB、地图 8 MiB。DNS 全部地址必须为公网地址，并绑定实际连接；系统代理和自动重定向关闭，防止转向内网。

新鲜期遵循 `s-maxage`、`max-age` 或 `Expires`，扣除 `Date`、`Age` 和传输时间；来源配置只能缩短，最长七天。`no-store`、`private`、`no-cache`、未明确允许共享缓存的 `Set-Cookie`、`Vary: *`、未知变化请求头或未声明新鲜期的响应不写缓存。带 `Set-Cookie` 的响应只有明确声明 `public` 或 `s-maxage` 才能保存字节，Cookie 始终丢弃，不保存、不回传。常见的 `Vary: Accept-Encoding/Origin/Authorization/Cookie/Accept/User-Agent` 按固定出站头处理，不携带任何客户端头。过期即重新下载，不返回陈旧数据掩盖 403，也不把失败响应当成有效内容。`persist: false` 同时禁止读取已有磁盘缓存。

同一目录可在进程重新启动后复用。当前 dev 使用容器临时磁盘，重新部署或更换容器后会重新填充；若需要跨容器重建保留，可给每个实例挂载独占持久卷并配置目录。缓存是可重新获取的副本，不作为历史存档或数据授权凭据。需要稳定回放的获准数据包仍通过普通资源上传、内容哈希和空间时间线保存。

## 从矢量瓦片持续生成三维内容

`props.externalContent` 支持 `format: "mvt"`。来源 `url` 指向标准 TileJSON，查看器读取其 XYZ 模板和最高层级，按镜头视锥及距离发现新区域。多边形图层、高度字段、颜色和保护范围都由普通物件配置，无需提供方分支：

```json
{
  "version": 1,
  "format": "mvt",
  "sources": [{
    "url": "https://tiles.example.org/index.json",
    "delivery": "server",
    "resourcePrefixes": ["https://tiles.example.org/data/"],
    "attribution": "示例数据提供方",
    "page": "https://tiles.example.org/",
    "license": {"label": "数据许可", "url": "https://tiles.example.org/license"}
  }],
  "reference": {"latitude": 35, "longitude": 139, "origin": [0, -60, 0], "heading": 25},
  "extrusion": {
    "layer": "shapes",
    "heightProperty": "height",
    "minHeightProperty": "base_height",
    "hiddenProperty": "hidden",
    "defaultHeight": 8,
    "maxHeight": 1000,
    "color": "#bbc5c8",
    "maxDistance": 20000,
    "excludeBounds": [[-30, -30, 30, 30]]
  }
}
```

物件仍需代理形状、范围和 `background: true`。`excludeBounds` 是所在成员本地米制坐标的 `[minX,minZ,maxX,maxZ]`；相交的多边形不生成，保留已有精细模型和室内主体。高度单位为米，顶高须大于底高；仅缺少顶高时使用 `defaultHeight`。矢量体块不等同于实景贴图、测绘模型或已核实的实际楼高。

TileJSON 和 PBF 复用现有空间权限、署名和 HTTP 磁盘缓存。MVT 来源只允许索引自身与显式 `resourcePrefixes`，不会因索引位于根路径而开放整个域名。每次读取最多 8 MiB，每份来源最多四个并行请求、32 块可见瓦片，不预取全球数据。移动镜头取消不再需要的下载；几何缓存限制为 48 块及 96 MiB，移除物件释放资源。当前支持标准 Web Mercator XYZ。地图与三维同时启动时，服务端在总时限内排队，最多八个出站下载。

# OneMap 历史接入核查（2026-11-13）

早期场景下载先打开 OneMap 官方三维网页观察网络请求，再读取网页使用的 `/omapi/tilesets/sg_noterrain_tiles/tileset.json` 和 B3DM 分片。旧下载器带有官方 `/3d` 页面 Referer；本次已移除，使用本系统自己的 User-Agent。旧离线缓存也改为记录 HTTP 期限，不复用缺少期限的历史回执，并拒绝持久保存 `private/no-store` 响应。这里调用的是官方网页的数据接口；目前没有找到证明该三维端点属于公开开发者 API 的文档，也没有证据表明旧流程已完成正式开发者授权。不能将其描述为已通过公开 OneMap 3D API 授权。

本地确实取得过完整索引：`scenes/marina-bay/assets/onemap/tileset.json` 为 6,232,726 字节，SHA-256 为 `1f40521025e527ba65ceb70f98fe336b3bc683d5bdebae98b5e34ce672a9db91`。下载清单时间为 2026-11-11 14:57:10 UTC，记录 49 个分片、825,204,456 字节；没有首次索引响应日志，不能据此确定当时的全部请求条件或许可状态。

本次复核：普通地图及影像样本允许公开读取并给出四小时缓存；三维分片样本可读取；直接读取总索引返回 403，正文为 `Direct download is not permitted`；官方网页自身读取索引成功，但响应为 `private, no-store`。所以“本地已有索引”和“当前网站不能直接读取官方索引”可以同时成立。不能把 403 解释成从未下载过，也不能仅因文件已下载就推定可永久缓存或再分发。

官方资料：

- [Open Data Licence](https://www.onemap.gov.sg/legal/opendatalicence.html)：对于适用该许可的数据集，允许下载、分发、修改和商业使用，要求署名及许可链接；第三方权利等例外仍适用。尚未找到这个三维数据集单独适用该许可的明确声明。
- [API Terms of Service](https://www.onemap.gov.sg/legal/apitermsofservice.html)：允许商业及非商业 API 调用，遵循各接口附加限制，适用时使用正式凭据，不得伪装或隐藏客户端身份。
- [网站使用条款](https://www.onemap.gov.sg/termsofuse)：开发应用使用其 API/数据涉及注册及 Developer Agreement；部分服务可单独限制。
- [地图服务文档](https://www.onemap.gov.sg/docs/maps/)：公开列出 XYZ、WMS、WMTS，支持第三方调用，要求 OneMap 标志和署名。
- [开发者文档](https://www.onemap.gov.sg/apidocs/)及[注册入口](https://www.onemap.gov.sg/apidocs/register)：公开目录中未找到 3D Tiles 端点说明。三维数据访问范围仍需以提供方正式文档或授权为准。

本功能不把旧的完整索引自动发布成服务器镜像，不修改旧场景资产的许可标识，也不通过改 Referer、Cookie 或代理环境来重试被拒绝的官方索引。来源署名、数据许可与 HTTP 缓存是不同约束，必须同时满足。
