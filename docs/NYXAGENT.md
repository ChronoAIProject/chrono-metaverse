# NyxAgent 在线空间聊天

工作台支持通过 NyxID Agent Key 调用 NyxAgent `nyxagent/chat`。打开 `/workspace`，选择已有空间，再点 **NyxAgent**。

## 授权

1. 先登录工作台，点击“授权此浏览器调用 NyxAgent”。
2. 打开 NyxID 授权页，选择当前登录账号拥有的个人 Agent Key；仅授予 `proxy` 和 `llm-nyx`、`chrono-metaverse`、`chrono-llm-public` 三个服务。默认聊天模型需要最后一个服务。不要开启全部服务或自动包含新连接服务。
3. NyxID 批准并交付浏览器子凭据后，工作台核验账号、服务范围以及 `nyxagent/chat` 模型可用性，成功后才允许发送。

`chrono-metaverse` 测试部署在 NyxID 中是自定义服务，允许没有目录标识；模型服务按目录标识核验。同一模型服务的个人连接与组织连接可以同时授权，不算额外服务。

NyxAgent 与 CMA 分别授权、保存凭据。Key 留在此浏览器的独立授权存储中，服务端不持久保存，不放入对话、URL 或日志。凭据会跨刷新保留；断开按钮撤销此浏览器的子凭据并清除本地授权，不撤销父 Key。退出组织后仍可撤销自己的子凭据。

组织空间仍使用当前用户的个人 Key；组织归属只选择目标资源。工作台检查当前组织角色，实际工具调用仍由 NyxID 和 metaverse 校验权限。服务连接或模型未获授权时，要在 NyxID 完成对应配置。

## 使用与恢复

- 以自然语言描述空间修改。助手的固定指令要求先读取最新状态、修改草稿、生成预览，并在用户明确确认具体预览后才发布。工具权限由 NyxID 决定；这些指令不额外授予权限。
- 完成的回答可以打开同站预览。后续消息沿用 NyxAgent 返回的会话编号。聊天及未确认请求按账号和空间保存在当前标签页，最多保留最近 30 条消息。
- 流式输出只有收到已提交的完成或失败终态才算确认结果。中断连接可能已经产生外部修改；刷新不会自动重发。
- 出现恢复区时，优先“核对 NyxAgent 结果”；响应还没提交时可能暂时读不到。也可“恢复 NyxAgent 原请求”，发送完全相同的正文和幂等编号。必须使用原凭据，不能换 Key 重放。
- 开始新对话只清除本地记录，不撤销已经发生的操作。先核对未确认结果。

## 接口边界

浏览器仅访问同源 `/api/auth/nyxid/nyxagent/` 的固定 POST 操作：`key/request`、`key/poll`、`key/check`、`key/revoke`、`message`、`response`。所有操作使用已验证的 HttpOnly 网站会话和 CSRF；调用 NyxAgent 时原样转发专用 Agent Key。

服务端固定经现有 `NYXID_BASE_URL` 下的 `/api/v1/proxy/s/llm-nyx/v1/` 访问模型、Responses SSE 和已保存响应，不接受自定义上游地址、任意模型或任意代理路径。消息使用 `store: true`，并传递原 `Idempotency-Key`；不会自动重试写入。无需增加部署环境变量。

本地联调可使用真实本地 NyxID；授权页支持 HTTPS，或仅指向 `localhost`、IPv4/IPv6 回环地址的 HTTP。普通内网地址和远程 HTTP 地址仍会被拒绝。NyxID 的 `FRONTEND_URL` 应指向本地授权网页，Metaverse 的 `NYXID_BASE_URL`、JWKS 和签发方应指向本地 NyxID 后端。

NyxID 的 OpenAPI 抓取策略可能拒绝本地地址，此时服务提供 `chrono-metaverse__request` 通用工具。新消息会引导助手先通过该工具读取 `GET /api/agent-guide`；指南包含草稿、修订、预览、发布和取消流程，以及能直接通过实际接口校验的物件示例。更多接口仍可读取 `/api/openapi.json`。指南是公开的静态协议说明，不包含空间数据，也不改变鉴权或 NyxID 的地址抓取策略。

新消息使用 `instructionsVersion: 2` 固定这份引导；待确认消息原样保存该版本。旧消息省略版本或使用 `1` 时，服务端仍生成旧版上游请求，升级后重试不会改变幂等请求内容；其他版本在调用上游前返回 422。

这条通道使用 NyxAgent 的 Key 绑定会话，不包含个人 NyxBot 的历史、记忆或 specialists。扫描、文件导入和主机重建仍使用 CMA 或本地重建工具。

## 验证

`web/src/workspace/nyxagent.test.ts` 验证分块 SSE、终态与会话编号、授权及存储隔离；`NyxAgentPanel.test.tsx` 验证发送、预览、续聊、断流恢复和换 Key 限制。后端 `tests/oauth_support/nyxagent_tests.rs` 使用真实 MongoDB 与模拟 NyxID/NyxAgent，验证原始 Key 转发、授权范围、CSRF、组织归属、幂等头和错误脱敏。

真实模型调用需要用户在浏览器批准对应 Agent Key。模拟集成通过及测试站部署成功，不等于已经用用户真实 Key 完成空间编辑。
