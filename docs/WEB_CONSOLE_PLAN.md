# CMA 驱动的网页工作台

用户只需描述需求。网页承担查看、委托、跟进与验收；空间内容、布局、事件、组合和重建包的实际编辑交给在线 CMA worker，不建设手工编辑器。

## 网页流程

1. 连接 NyxID，显示当前账号；明确同意此浏览器通过 CMA 访问该账号有权限的 Agent。
2. 填写目标空间编号、可选组织归属和自然语言需求，创建专用在线 worker；也可选择现有 Agent 继续任务。
3. 查看准备阶段、执行状态和对话结果，追加要求；请求身份和幂等键保留，网络失败后可核对或重试原请求。
4. 查看 worker 返回的空间/组合/草稿预览，在网页打开三维查看器；确认后要求同一 worker 发布，或继续修改。
5. 可到 CMA 官方界面处理模型、服务授权、执行审批、运行环境和完整控制。断开网页授权不会自动停止已受理的 worker。

## 授权与调用

```text
用户浏览器 ── HttpOnly 会话 + CSRF ──> metaverse 网页后端
                                              │
                       同用户 OAuth（openid offline_access）
                                              │ 固定 CMA 地址、固定操作集合
                                              v
                                  CMA 普通用户 API / 资源权限
                                              │
                             CMA 自己托管的服务范围 Agent Key
                                              v
                                  NyxID → metaverse API → 资源 ACL
```

不扩大既有 OAuth scope，不向浏览器或 worker 提供用户 OAuth 凭据。旧连接不会自动启用 CMA 调用。新增 CMA 调用需用户明确同意，且每次验证会话、CSRF、账号、授权版本及当前同意状态。CMA 的新环境仍要求用户通过其官方登录建立可续期委托；此网页不代替用户同意。

调查依据：CMA develop 的 `docs/API_Agent_Manager.md`、`docs/API_REST.md`，以及线上 `https://cma.nyxid.ai/agent-manager/openapi.json`。CMA 当前对独立执行命令拒绝带 resource/allowed_service_ids 的 OAuth 令牌（`auth/bearer.rs::permits_independent_commands`），所以不把带服务资源限制的 proxy 令牌转成更大的 CMA 权限。普通用户 OAuth 可直接调用 CMA；CMA 仍核验当前主体与权限。此部署只开放创建、列表、观察、发消息和停止响应等有限操作，不开放任意 URL 或任意 API 代理。

新建 worker 仅申请 metaverse 业务服务，加上 CMA 自身强制基线（模型与技能服务），不申请 GitHub、CD 等服务。空间/组织编号是任务上下文，不是授权；最终权限仍由 NyxID 与 metaverse 决定。先草稿后发布是任务约定；若要从权限上禁止 worker 发布，仍须为它在 NyxID 配置操作范围，不能把提示词当成权限屏障。复用现有 worker 不会修改其原有权限，也不声称其仅可访问 metaverse。

## 验收

- 不提供方块/坐标/schema 等人工编辑表单。
- 常用流程具备可操作的输入、状态、对话、恢复入口和预览，不把 JSON 控制台当成功能。
- 覆盖未同意拒绝、CSRF、断开/重新授权围栏、目标与标识校验、幂等重试、CMA 登录要求、异步受理与实际完成区别。
- 完成后端及浏览器测试、构建和固定摘要部署。用户真实 OAuth 同意及实际 worker 执行的线上验收单独记录。
