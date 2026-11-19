# 空间业务配置审计

## 写入与生效

空间作者读取目标版本的完整实体，在所属地块创建草稿，通过 `POST /api/v1/spaces/{space_id}/plots/{plot_id}/drafts/{draft_id}/ops` 提交带新属性的 `placeEntity`，预览该修订后发布。重建层使用重建草稿接口。观看端按请求的空间与版本取快照。回看历史版本时读取该版本的数据。

| 可修改的内容 | 持久化位置和入口 | 核对结果 |
| --- | --- | --- |
| 节目地址、播放协议、面板 | 节目实体 `props.liveScreen.{kind,url,plate}` | 播放器从快照取节目。转播屏只需面板路径。生成看台时从快照保留节目。 |
| 屏幕之间的关系 | `props.broadcastTour.{program,mirror,linkedScreens}` | 实体编号在当前成员空间解析。外景复用镜像实体和播放器。 |
| 机位按钮文字、位置、目标和顺序 | `stops[].{id,label,frame,position,rotation,camera}`、`initial`、`order` | 显示名、进入时的机位、按钮排列和自动播放路线各自读配置。 |
| 机位切换、停留、屏幕布局 | `stops[].{minDistance,hideBeyond,holdMs,screen}` | 手动拉远按距离切换，自动播放按当前机位指定的时间停留。 |
| 飞行器、空间设备、轨迹和数量 | `stops[].equipment[]`，模型可用 `{"entity":"空间内的模型实体编号"}`，该实体通过模型上传 API 绑定 `assetHash` | 查看器按当前空间权限读取 GLB。已发布的资源库名称继续可用，同一模型的多个设备共用资源。 |
| 建筑、标签、地标、方块和区域 | 实体的 `shape`、`assetHash`、`label`、`props.landmark`、`props.backgroundView`，以及地块、锚点和重建操作 | 生成器从最新快照保留作者的标签、机位地标、节目与巡演。模型文件与几何可由同一套上传、草稿和发布流程替换。 |
| 看台生成绑定 | 空间实体的 `props.arenaBindings` | 生成器从快照读取区域、模型、编号前缀与楼层。新建时可传独立绑定文件。实景建筑地址和机位编排由已发布空间保存。 |
| 地图、实景模型、天空和署名 | 环境实体 `props.environment`、`props.externalContent`、`props.backgroundConfig` 及引用的资源 | 重建工具从保存的配置恢复来源与配准。初始化新来源时提供瓦片地址和署名页面。 |
| 空间名称、说明、默认样式、颜色和照明 | `PATCH /api/v1/admin/spaces/{space_id}` 的空间元数据、`styles` 与 `defaultStyleId` | 样式目录接受作者定义的编号、名称、材质参数和扩展。同名空间样式可覆盖基础预设。 |
| 组合成员、旋转、位置、连接和共同样式 | `PATCH /api/v1/spaces/{space_id}/composition` 的 `members`、`links` 和 `themeId` | 已保存的共同样式可引用成员目录中的自定义样式。 |
| 事件来源、事件名和可视化 | 空间事件来源、类型和视觉规则 API | 事件实例按空间来源和时间查询，视觉规则通过实体或锚点引用作用于场景。 |

## 仓库入口

- `web/src/core`、`web/src/viewer`、`web/src/space`、`web/src/workspace` 负责快照解析、资源加载、渲染与编辑。全息材质、地球投影、运动曲线和播放器适配器是渲染实现。GLB 资源库提供可选模型，实际采用的设备由空间配置指定。
- `api/crates` 负责鉴权、范围校验、资源角色和时间线。空间属性与模型引用通过同一草稿修订发布。公开预览令牌绑定草稿修订。用户变更节目或布局沿用既有空间权限和并发冲突检查。
- `sdk/typescript`、`recon` 和 `scenes` 是内容输入端。SDK 从工作区或命令行获得空间和地块。重建工具从工作区读取拉取的实体和地图配置。场景目录里的生成器、素材、演示清单属于创作输入；已发布实体可以通过空间 API 独立编辑。
- `infra/chrono-cd` 的种子描述初始演示空间，部署环境和身份服务地址由部署配置管理。`infra/dev`、`spikes`、夹具与测试使用独立示例或本地服务。身份信任域、部署凭据、镜像摘要、格式版本和资源上限由运维或协议管理。

## 复验

仓库 CI 运行 `node --test .github/scripts/check-scene-boundary.test.mjs` 和 `node .github/scripts/check-scene-boundary.mjs`，检查生产层对场景源码和示例值的引用，以及生产源码、场景配置和部署种子中的实际 YouTube 播放地址。对构建产物的核对另取已发布节目 ID 搜索静态文件。已知字面量扫描的结果需要和实际入口验收一起解读。

`web/e2e/environment.pw.ts` 通过预览 API 提供独立快照。它使用运行时生成的两个不同测试节目 ID，先后验证双屏来源、机位改名、布局、设备实体和播放顺序。真实前厅验收使用已发布数据、实际播放器和远近机位。配置字段和坐标单位见 [巡演配置说明](../scenes/tide-arena/README.md)。
