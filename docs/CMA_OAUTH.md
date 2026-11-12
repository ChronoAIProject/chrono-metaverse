# CMA 用户 OAuth 直连接入

工作台复用现有 NyxID confidential OAuth client，采用 Code + PKCE。浏览器只持有
HttpOnly 会话 Cookie；访问和刷新令牌加密托管在 Metaverse，CMA runtime 的服务
Agent Key 仍由 CMA 自己管理。网页默认选择 OAuth；也可明确切换到 [浏览器 Agent Key](CMA_AGENT_KEY.md)。
OAuth 模式不读取或发送浏览器 Key，也不删除已保存的 Key。

```text
浏览器 ──点击授权──> NyxID（确认当前用户及 CMA 服务范围）
  │                     │ Code + PKCE
  │ Cookie + CSRF       v
  └──────────────> Metaverse（加密保存并刷新用户 OAuth）
                         │ Bearer + 固定公开 API + 原幂等编号
                         v
                        CMA ──实时 introspection──> NyxID
                         │ 用户权限、资源 ACL、命令授权
                         v
                    CMA Agent / Sandbox
```

授权请求为 `openid roles offline_access proxy`，并使用 NyxID 的
`/api/v1/proxy/s/cma` 作为 RFC 8707 resource 标识。这个 URL 限定令牌的服务范围；
**业务 HTTP 请求仍直接发送给 `CMA_BASE_URL`，不经过 NyxID 服务代理**。

已有的身份登录不自动获得 CMA 授权。用户在 NyxID 明确同意一次后，刷新网页、打开新
标签页和切换空间均复用保存的 OAuth grant。断开连接删除本部署的 grant，失效相关
会话；待确认消息、内容和幂等编号保持不变，授权或轮询不会自动重发写入。

聊天窗记住当前账号选择的授权方式。切换方式先取消原连接状态并重新核验，不自动
重发待确认消息。两种方式共用相同请求内容与幂等编号，恢复仍由用户明确点击。

## 连接与权限

`worker/connection` 验证会话、同源 Origin、CSRF、OAuth grant、当前组织成员关系，
再以 OAuth 直接请求 CMA `/auth/session`。主体必须与网页登录用户一致，而且 CMA
必须返回 `api_commands:true`，才向网页报告可连接。旧 CMA 缺少该字段或返回 false
时显示服务能力错误，不显示“已连接”，也不引导反复授权。

组织选择指定 Metaverse 目标空间，不能把用户 OAuth 变成组织身份。Metaverse 实时
检查组织成员权限；CMA 独立检查具体 Agent 的访问和操作权限。组织列表通过 CMA 的
`organization` 参数筛选已有共享资源。CMA 当前创建 API 没有组织归属参数，新建
worker 归当前用户，任务上下文保留目标组织；不得声称已创建组织拥有的 CMA worker。

CMA 的账号环境授权仍是独立前提：新建 Sandbox 如果返回
`sandbox_credential_setup_required`，用户需要以同一账号在 CMA 完成可续期运行环境
授权；网页保留原任务，只有用户明确重试后才重新发起创建。

## CMA reader 与发布条件

CMA 需要支持受限用户 OAuth 的持久命令授权，并配置
`CHRONO_NYXID_OAUTH_API_RESOURCE` 为 provider 返回的**规范 CMA resource URL**。
当前 NyxID 把旧域名 resource 规范化为
`https://api.nyxid.ai/api/v1/proxy/s/cma`。该配置属于 CMA，不是 Metaverse 客户端 ID，
也不包含客户端秘密；无需修改 NyxID 代码。

2026-11-12 实测了独立第三方 OAuth 客户端的两种真实 grant：

- 身份 grant：`openid roles offline_access`、空服务授权；CMA 身份检查成功，聊天
  返回 `403 command_authority_required`。
- 受限 CMA grant：额外 `proxy`、规范 CMA resource、仅一个 CMA connection；同样
  身份检查成功，聊天返回同一拒绝。测试客户端随后均已删除，未扩大为所有服务授权。

这说明 CLI OAuth 的两轮成功不能证明网页 OAuth 可用。当前 Metaverse 与 CMA 修复
必须共同验收后再上线；本地模拟和源码测试不代替真实网页授权、连续聊天、刷新、
请求恢复与模型导入的线上验收。
