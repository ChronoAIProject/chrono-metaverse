# CMA 直连与浏览器 Agent Key

当前工作台使用 CMA 的公开 API，业务请求不经过 NyxID 服务代理。

```text
浏览器：按登录账号与空间归属保存 CMA 专用 Agent Key
    │ 同源请求，附带浏览器 Key
    ▼
Metaverse API：核对网页会话、归属、同意和 Key 范围，临时转发
    │ Authorization: Bearer <browser-key>
    ▼
CMA API：向 NyxID 验证 Key 的 CMA 服务授权，再检查资源权限
```

NyxID 继续提供网页登录、组织成员核验和 Key 的签发、撤销与验证。
Metaverse 的网页登录 OAuth 不代替 CMA 执行授权。
Key 只持久化在浏览器的独立授权存储中，不进入服务端数据库、任务正文或聊天恢复记录。
个人和组织的 Key 按空间归属分别选择、保存、核验。

## 首次授权与复用

用户点击授权，在现有 NyxID 审批页选择对应归属的 CMA 专用授权并确认。
网页先保存领取的子凭据，再调用 `worker/key/check`：

1. NyxID 验证子凭据、主人、仅 CMA 的服务范围及 `proxy` scope。
2. Metaverse 携带同一个 Key 直接请求 CMA `/auth/session`。
3. CMA 必须返回 `authenticated:true`，且 `subject` 与 Key 主人一致。

两项核验都通过，网页才显示“已连接 CMA”并启用聊天。
刷新、切换空间和新标签页复用浏览器中的对应 Key，并重新核验。
临时错误或 CMA 拒绝不会删除已领取的 Key；点击“重新检查 CMA 授权”复用原凭据。
NyxID 明确判定凭据失效、归属错误或服务范围不符时，才清除对应本地记录。

CMA 请求返回 401 时，工作台关闭发送能力并重新核验连接，保留原任务与幂等编号。
连接恢复不会自动重发消息。创建、消息和上传继续使用原有的固定公开 API。
核验只是认证检查，不代表任意 worker 的资源权限或托管环境授权已获批准。

## 一次性服务配置

Metaverse API 设置 `CMA_BASE_URL` 为 CMA 的 HTTPS 根地址；生产为 `https://cma.nyxid.ai`。
请求经同源 Metaverse API 临时转发，因此无需为此接入增加浏览器跨域来源。

CMA 已实现服务绑定的普通 Agent Key 验证，参见 CMA `docs/CMA_Operations.md`
的 “Ordinary NyxID agent API credentials” 章节。部署需满足：

- CMA 的 `CHRONO_NYXID_SERVICE_ID` 指向 **CMA 自身**的 NyxID 目录 UUID。
- 该目录项的 `introspection_client_ids` 包含 CMA **已有**的 confidential OAuth client ID。
- CMA 使用自己的现有 client ID/secret 调用 NyxID introspection。

这是现有服务配置，不需要新建 OAuth client，也不需要修改 NyxID 代码。
Metaverse 不能替 CMA 登记自身的网页登录客户端，更不能持有 CMA 的 client secret。

生产目录 `b48c8aff-02a6-43b6-87b5-98d3e66c1a06` 的登记内容为：

```http
PUT /api/v1/services/b48c8aff-02a6-43b6-87b5-98d3e66c1a06
Content-Type: application/json

{
  "introspection_client_ids": ["c0cd33d2-27ba-4b8d-b38e-562364fadb72"]
}
```

应用前重新读取并保留已有登记。该接口要求目录管理权限，登记字段另要求 admin。
2026-11-12 当前 CLI 账号为 operator，实际修改被 403 拒绝，因此尚未应用此登记。
同一个本地 Key 在 NyxID 有效，直连 CMA 只读接口仍为 401；不能将此版本记为真实 CMA 操作验收通过。

补齐登记并确认 CMA 运行配置后，先用原 Key 验证只读认证，再在专门测试资源上验证创建、连续两条消息和附件。
NyxID 代理的 `cma_configuration_required` 属于另一条调用路径，不是这条直连路径的修复前提。
