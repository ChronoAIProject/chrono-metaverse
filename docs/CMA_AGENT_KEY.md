# 历史浏览器 Agent Key 接入

浏览器 Agent Key 方案已由 [CMA 用户 OAuth 直连](CMA_OAUTH.md) 替代。

迁移后网页清除 `metaverse-cma-credential:` 和 `metaverse-cma-enrollment:` 的历史
浏览器记录，不把这些凭据复制到服务端，也不再调用 Key 登录审批接口。清除本地记录
不等于撤销 NyxID 上的旧凭据；需要时可在 NyxID 单独撤销。

CMA 为 worker 管理的运行时服务 Key 与旧的网页登录凭据是两回事，继续由 CMA 托管。
