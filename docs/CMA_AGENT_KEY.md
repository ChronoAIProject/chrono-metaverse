# CMA 浏览器 Agent Key 聊天

工作台的“聊天授权方式”支持 `OAuth` 和 `Agent Key`。默认使用
[用户 OAuth](CMA_OAUTH.md)，两种方式共用同一个聊天窗、公开 CMA API 和任务恢复记录。
不会因为一种方式失败而自动使用另一种方式，也不会在切换或刷新时重发待确认消息。

## 点击授权与复用

选择 `Agent Key` 后，网页通过 NyxID 已有的 Agent Key 登录申请、审批与轮询接口领取
独立的登录子凭据。授权页预填请求码、`cma` 服务和 `proxy` 权限；用户只需点击选择
当前账号的 CMA 专用授权并确认，不需要复制 Key 或配置客户端。

子凭据仅保存在当前网站的浏览器 `localStorage`，按登录账号隔离。刷新和新标签页
复用同一凭据；未交付申请暂存在当前标签页 `sessionStorage`，刷新继续原轮询。
Metaverse 服务器只在请求期间转发凭据，不持久保存 Key，也不写入任务、日志或 URL。
交付后先保存再检查 CMA，服务配置失败不会消耗一次性交付或要求重复审批。

同一账号的凭据可用于其有权访问的个人或组织空间。组织是目标资源，不能改变 Key
的实际主体；旧的组织主体 Key 不会迁移为当前用户的个人凭据。网页对组织请求保留
实时成员检查，CMA 独立检查 Agent 的资源权限。

## 请求与撤销

网页明确发送 `x-metaverse-cma-auth: agent_key`，并携带浏览器 Key。服务器仍验证
浏览器会话、同源 Origin、CSRF 和聊天同意状态，再实时核对 NyxID 子凭据所属账号、
CMA 专用服务范围及 `proxy` 权限。缺少 Key 或授权失效时拒绝请求，不改用 OAuth。
固定操作包括连接检查、列举 Agent、创建、观察、发送、查询响应、停止和模型上传。

连接检查还要求 CMA `/auth/session` 的主体一致且 `api_commands:true`。NyxID 的批准
不等于 CMA 已接受操作授权；CMA 返回 401 或缺少聊天能力时保留凭据和原请求，显示
服务错误。撤销仅操作本次浏览器登录子凭据，不撤销父 Key。

CMA 需要配置服务绑定的普通 Key introspection：`CHRONO_NYXID_SERVICE_ID` 对应实际
CMA catalog，CMA confidential client 注册到该 catalog 的 `introspection_client_ids`。
不能通过 userinfo 成功推断 CMA 服务授权有效。CMA 运行环境中的服务 Key 继续由 CMA
管理，与网页使用的登录子凭据相互独立。

## 待确认操作

创建、消息、停止及上传记录同时保存原请求编号和不可逆的凭据版本摘要。浏览器
发送写操作时携带 `x-metaverse-cma-credential`，服务器核对当前实际凭据的版本后
才转发给 CMA。切换 OAuth、替换 Key 或恢复旧版记录时不能跨凭据重放结果未知的
操作；切回原 Key 可使用原内容与编号恢复。原 Key 已撤销或丢失时，先在 CMA 核对
结果，再明确清除恢复记录。OAuth 刷新导致令牌变化时遵循同一规则。

若首次提交因凭据版本变化而被 Metaverse 明确拒绝、尚未向 CMA 发送，网页会保存
这个确定结果，重新核验连接后允许用户手动重试。该标记在每次发送前先消耗，网络
中断后不会保留；此前已有未知尝试的请求即使本次被拒绝，也不能借此更换凭据重发。
