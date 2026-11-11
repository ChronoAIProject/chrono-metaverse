# CMA OAuth 接入的职责边界

状态：调查结论与待评审方案，尚未部署。此文不表示当前 NyxID 已具备下述解耦能力。

## 要交付的行为

用户在 Metaverse 点击 NyxID 授权 CMA，之后复用同一份可刷新的授权；浏览器与 Metaverse 服务端都不保存 CMA Agent Key。空间的个人/组织归属决定连接选择，组织角色实时核验。创建、附件、连续消息与原请求恢复必须在真实 CMA 验证，不能用模拟 provider 的成功代替。

## 职责

| 组件 | 负责 | 不应承担 |
|---|---|---|
| NyxID 身份与服务代理 | OAuth 服务 grant、连接访问权、组织成员/连接策略、通用操作授权、可信身份传递 | 解释 CMA 的附件文件名、lifecycle 回执或 Sandbox 业务状态 |
| CMA | 资源归属与能力、Sandbox 配额、运行凭据托管、任务与附件协议、幂等及恢复 | 将另一个 OAuth 客户端的受限 bearer 升格成无限制运行凭据 |
| Metaverse | 授权与刷新、按空间选择连接、固定接口与输入校验、展示真实任务状态、保存原请求 | 代替用户批准、伪造组织身份、换 Key 重发结果不确定的创建 |
| NyxBot 的 CMA 管理功能 | 自己管理的 Sandbox 来源、个人占用名额、原生创建/退休记录 | 在未区分调用来源时把全部第三方 CMA 请求都当作 NyxBot 的原生资源管理 |

目标链路：

```text
浏览器 -- Cookie/CSRF --> Metaverse
                          |
                          | 用户明确授予的 OAuth，仅 CMA resource
                          v
                     NyxID 通用代理
                     grant / 连接 / 操作策略
                          |
                          | 短期签名身份：实际 actor
                          v
                         CMA
                     资源 ACL / 配额 / 幂等 / 运行凭据
                          |
                          v
                        worker

NyxBot 原生环境管理 --> 自己的管理准入 --> 同一 CMA API
                       来源 / 名额 / 退休 fence
```

## 当前部署的事实

2026-11-12 重新探测的 NyxID `/health` 为 `4d182f42ec56`。使用现有 CLI 用户 OAuth 与精确连接，只发只读请求：

| 请求 | 现网结果 | 含义 |
|---|---|---|
| 个人连接 `GET /api/v1/agents` | 409 `cma_configuration_required` | 不能据此断言缺少 OAuth grant；配置/代理链路尚未通过 |
| 组织连接 `GET /api/v1/agents?organization=<当前组织>` | 403 `cma_operation_not_supported` | NyxID 的 CMA 原生准入要求 personal context；尚未到 CMA 资源判权 |

NyxID `service_dispatch_registry::policy_for` 按目录 slug `cma` 选择专用准入器。此行为来自已合并的 [NyxID #2259](https://github.com/ChronoAIProject/NyxID/pull/2259)。其设计明确规定普通 REST/MCP mutation 也受 NyxID 创建来源及个人名额限制。不能把它当成可随意删除的检查。

个人 CMA 连接是自动管理的：端点列表隐藏其 URL，`ensure_user_managed_endpoint` 拒绝修改；因此不能通过普通用户端点编辑接口修正其旧快照。组织连接当前已经指向目录 CMA 地址，仍被 personal context 限制拒绝，说明地址修正不足以解决组织接入。此轮没有修改连接、目录或数据库。

CMA `docs/CMA_Operations.md` 的 “NyxID proxy access to the CMA API” 描述现有签名代理可访问完整 CMA API，包含 mutation，并明确说无需修改或部署 NyxID；CMA 自己执行资源 ACL 与可续期凭据前提。这个服务端契约与现有 NyxID 原生准入范围发生冲突。

## 对当前草稿的审计

[NyxID #2384](https://github.com/ChronoAIProject/NyxID/pull/2384) 混合了两类改动：

| 改动 | 归属与结论 |
|---|---|
| 无凭据自动连接读取当前目录地址，保留显式 custom/provider 路由 | 通用代理缺陷；可独立评审，不需要 Metaverse/CMA 名称或 ID 特判 |
| final dispatch 使用实际 resolved URL | 通用的目标绑定要求；当前修正落在 CMA 适配器，应与代理框架的真实目标语义分别核对 |
| human OAuth 经组织连接时改变 CMA admission owner/eligibility | 涉及原有授权模型，不能只靠一项允许测试证明边界正确，也不能据此声称资源属于组织 |
| 增加 CMA attachments 路径、name 查询规则 | CMA 业务协议适配，加深服务耦合 |
| NyxID 返回 CMA 创建 IDs，Metaverse 解读该专用回执 | CMA 业务恢复适配，引入跨仓库的私有依赖 |

38 项真实 Mongo 回归证明草稿内部的部分不变量；它们没有证明第三方 OAuth、组织资源、真实 Sandbox 创建与连续任务已可用。Metaverse 的绿色 CI 也不能替代这些验收。

Metaverse 已移除上述私有回执消费逻辑：成功响应保持 CMA 原 status/body；代理 409 保持拒绝，不能被转换成 202。恢复测试仅验证公开回执与原 body/Key 的透传，以及冲突不会被当成成功，不能证明当前生产代理已经支持原请求恢复。

## 接下来需要解决的契约

优先复用现有能力，但目前证据不足以声称仅改 Metaverse 即可完成全部目标。应先明确普通第三方服务代理与 NyxBot 原生管理的边界，再决定 NyxID 是否需要通用修正。

若分离两条执行路径，需要服务方与 NyxID 的评审核实：

1. 执行来源必须来自服务端验证的客户端/凭据上下文；浏览器参数、可改 header、别名或另一个 URL 都不能切换管理策略。
2. NyxBot 原生资源管理及其凭据仍受原有来源、名额、容量与退休约束；兼容期内旧凭据不能凭缺省字段获得更大权限。
3. 普通第三方服务代理必须继续执行实时 grant、连接/组织 ACL、通用操作审批、撤销和最终发送检查；不得自动 fallback 为受限更少的调用路径。
4. 服务的资源权限、配额和任务协议由服务执行。组织连接的 owner、实际 actor 和 CMA 资源 owner 分开验证；个人 worker 不能被命名为组织资源来冒充支持。
5. 原创建 body/Key 在连接恢复及丢回执时不变。CMA 的公开幂等契约是返回原操作；代理不能令客户端依赖新增的 CMA 专用错误 details 才能恢复。
6. 应覆盖真实个人与组织资源、原生路径限制、跨来源/主体拒绝、上传、两条 Responses、OAuth 刷新、丢回执恢复以及滚动升级。

本次不会通过删除准入、改目录 slug/别名、手写数据库快照、索取 Agent Key 或转发受限 bearer 给 CMA 来绕过这个契约。

## 发布状态

Metaverse OAuth 草稿及其镜像已构建，NyxID 混合草稿保持 draft；两边均未执行本次生产发布。暂缓联合发布，先完成上面的边界评审和真实链路验证。NyxID 生产部署入口仍缺失，已有的信息请求尚未得到入口，不能将镜像发布当作生产更新。
