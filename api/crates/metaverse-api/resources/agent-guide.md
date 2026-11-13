# chrono-metaverse 编辑接口指南（v1）

本指南供已授权的空间助手使用。优先调用 NyxID 提供的 chrono-metaverse 对应工具；只有通用 request 工具时，设置 method、path 和 JSON body 调用下列接口。路径相对该服务，不要添加 NyxID 代理前缀。鉴权由工具传递，不索取密钥。接口只在现有权限内操作；文档不授予权限。

## 读取与范围

先 GET /api/v1/spaces/{spaceId}，再 GET /api/v1/spaces/{spaceId}/snapshot 读取最新 seq、entities、anchors、regions、plots。snapshot.entities 是 [{id,hash,body}]，body 才是完整物件。GET /api/v1/spaces/{spaceId}/timeline 可核对发布记录。只操作任务指定空间；404 时停止，不能创建替代空间。

普通空间草稿作用于 physical 范围、ext 扩展层。没有 regions 时可以在未被虚拟区或地块占用的位置编辑，不需要创建布局。用户明确指定已有地块时，下面所有 drafts 路径改为 /api/v1/spaces/{spaceId}/plots/{plotId}/drafts，始终保持同一范围。普通草稿不能改 rebuilt 层；有重建权限时使用下面的重建流程，不能改名或复制到扩展层来绕过限制。

## 移动已有重建物件

先核对真实 body.layer；编号本身不授予权限。rebuilt 层物件可以通过专用重建草稿移动，无需修改仓库、重新扫描或重做整个空间。调用者必须同时具备本空间管理权、NyxID 精确权限 metaverse:rebuild:write，并且当前 Agent Key 获准调用对应工具。空间管理员身份、平台管理员的通配权限和仅有普通内容编辑权限都不能替代精确重建权限。

1. POST /api/v1/spaces/{spaceId}/rebuild/drafts，body {"baseSeq":实际最新seq}；记录返回 id 和 rev。
2. 调用 move_rebuild_entities，或 POST /api/v1/spaces/{spaceId}/rebuild/drafts/{draftId}/moves，body {"rev":实际rev,"moves":[{"entityId":"实际rb.编号","expectedHash":"baseSeq快照中该物件的hash","offset":[1,0,0]}]}。offset 是世界坐标的平移量，单位米，y 向上；示例表示向 +x 移动 1 米，必须按用户目标计算真实值。一次 1–100 个不同物件。
3. 返回 202 只代表排队。GET /api/v1/spaces/{spaceId}/rebuild/jobs/{jobId} 等到 status=done，再 GET 对应重建草稿读取新的 rev。失败时报告真实错误，不能当作已完成。
4. POST /api/v1/spaces/{spaceId}/rebuild/drafts/{draftId}/preview，body {"ttlSeconds":3600}。提供实际完整预览链接、草稿编号、rev 和有效期。保持未发布；空间 head 不会因移动草稿或预览而变化。
5. 仅当用户明确确认当前具体预览和 rev，并且 Key 获准发布时，使用对应 /rebuild/drafts/{draftId}/publish，body {"rev":实际确认rev,"message":"用户确认的修改","replay":false}。Key 只获准准备预览时，应保留草稿供用户通过有发布权的入口发布，不索取更宽的 Key。

服务端从原始物件生成 merge 重建包，同步更新 bounds 和形状位置，保留编号、模型、材质、来源等字段。不能用此入口替换模型、移动模板或扩展层、修改扫描/锚点。返回 anchorDrift 时说明关联锚点未移动，不自动扩大修改范围。每个重建草稿只收一批移动或一个重建包；改动要求变化时保留已确认状态，明确说明需要新重建草稿与新预览。不要重复提交平移请求；断流后先查草稿和任务。

401/403 时停止并说明缺少的是登录、Key 操作授权还是 rebuild_permission_required；没有真实拒绝结果时不要断言用户没有权限。不能自行授予角色或修改 Key。复杂重建仍使用 apply_rebuild_bundle（先查 OpenAPI），遵守同样的权限、范围和预览确认流程。

## 草稿、预览与发布

下面 {draftId}、seq、rev 都使用真实返回值，不能照抄示例编号。

1. POST /api/v1/spaces/{spaceId}/drafts，body {"baseSeq":1}（使用刚读取的 seq），返回草稿 id、baseSeq、rev、status。继续编辑时沿用当前 open 草稿。
2. GET /api/v1/spaces/{spaceId}/drafts/{draftId} 核对草稿与当前 rev。
3. POST /api/v1/spaces/{spaceId}/drafts/{draftId}/ops，body {"rev":0,"ops":[操作]}。使用当前 rev；成功返回新 rev，每次追加加一。一次最多 200 个操作，失败整批不生效。
4. 每次可见修改后 POST /api/v1/spaces/{spaceId}/drafts/{draftId}/preview，body {"ttlSeconds":3600}。返回 url、rev、expiresAt。把完整 url 单独一行给用户，同时说明草稿编号和 rev，保持未发布。url 中 #t= 后面是临时预览凭据，不单独输出 token 字段。只使用实际返回的链接，不拼接或替换地址。
5. 只有用户明确确认当前具体预览和修订后，才 POST /api/v1/spaces/{spaceId}/drafts/{draftId}/publish，body {"rev":1,"message":"用户确认的修改","replay":false}。先核对草稿 rev 仍与确认一致；改变过就必须重新预览、重新确认。返回 commitId、seq；再读取最新 snapshot 核对实际结果。
6. 用户明确取消该草稿时 DELETE /api/v1/spaces/{spaceId}/drafts/{draftId}，不会更改已发布空间。仅说“先不发布”应保留草稿。

预览绑定草稿 rev；草稿再修改、发布、丢弃或过期后，旧链接读取返回 404。缺少权限（401/403）、不存在（404）、版本冲突（409）时停下说明真实结果，不自动重放、覆盖或反复发送写请求。绝不将 replay 改为 true 来绕过冲突。断流不能证明写入失败，先读取结果。

## 物件与坐标

placeEntity 以相同 entityId 新增或完整替换物件。修改时从 snapshot（或当前草稿中自己已提交的最新 body）保留编号及所有未要求改变的字段，不能用局部 body 覆盖。不要删除再重建同一物件。新 ext 编号不能以 rb. 或 _ 开头。

形状的尺寸、位置、bounds 单位都是米，y 向上；yaw/pitch/roll 单位为度。box、cylinder、cone 的局部原点在底面中心，向 +y 延伸。transform 写在 shape 内；bounds 必须包含变换后整个形状，移动、旋转、缩放时同时更新 bounds。格子坐标每格 0.05 米，只用于块操作和区域边界，不用于形状。

下面是 /ops 的完整 body 示例：在原点放一个 1 米红色立方体（请替换 rev、编号、标签和用户要求的参数）：

```json
{
  "rev": 0,
  "ops": [{
    "op": "placeEntity",
    "entity": {
      "entityId": "example-cube",
      "layer": "ext",
      "kind": "object",
      "label": "示例立方体",
      "shape": {
        "type": "box",
        "size": [1, 1, 1],
        "material": {"color": [255, 0, 0]},
        "transform": {"position": [0, 0, 0]}
      },
      "bounds": {"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]},
      "props": {}
    }
  }]
}
```

基本形状还有 cylinder（radius、height）、cone（radius、height）、group（children: [形状]）。这些形状共用 material、transform；颜色为 0–255 RGB。球不是合法基本 type，不凭空发明形状字段。删除物件用 {"op":"removeEntity","entityId":"实际编号"}；可选 ifPresent:true 表示已不存在时无操作。

更多标准接口可通过同一工具 GET /api/openapi.json 查看。遇到未说明的复杂操作，先查协议，不臆造端点或字段。只能声明工具真实完成的步骤，不把聊天文字或 HTTP 受理当作创建、预览或发布成功。
