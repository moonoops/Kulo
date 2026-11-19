# Hindsight 双层记忆授权

此模块加载到现有 Hindsight API 进程中，保留同一实例、同一数据库和两个 Bank。请求直接进入 Hindsight，不增加网关、转发端口或记忆副本。

| 记忆身份 | 私有 Bank | 共享 Bank |
| --- | --- | --- |
| Router | 读写 | 只读 |
| Worker（含子代理） | 禁止 | 读写 |

身份由两枚不同的 Bearer 密钥决定。请求中的角色、标签和 Bank 配置不能改变权限。密钥至少 32 个非空格可打印 ASCII 字符，两个 Bank ID 必须不同。

Kulo 托管安装另生成独立的 `KULO_HINDSIGHT_MANAGEMENT_API_KEY`，只保存在安装目录的 `0600` 服务配置中，不进入主脑／Worker 的运行时设置。该身份只增加固定两个 Bank 的配置读取／初始化、异步操作取消和验证文档删除，用于配置策略及清理真实模型验收材料；全局 Bank、MCP、导入导出、别名和其他管理入口继续拒绝。普通双密钥部署无需配置此可选身份。

托管启动入口 `python -m kulo_hindsight.managed --config <runtime.json>` 仅加载指定私密文件，不向上发现 `.env`；服务绑定 `127.0.0.1`。安装程序使用独立 HOME、Python 环境、pg0 数据及系统服务标识，卸载默认保留数据库并删除模型及运行时 API 密钥。

## 安装与启动

模块针对 `hindsight-api-slim==1.2.1` 的扩展和 HTTP 路由验证。升级 Hindsight 前应重新验证路由和权限覆盖。

```sh
uv pip install ./integrations/hindsight
kulo-hindsight-api
```

启动命令替换原来的 `hindsight-api`，沿用原服务端口、数据库、数据卷和模型配置。也可使用同进程 ASGI 入口：

```sh
uvicorn kulo_hindsight.app:create_app --factory --host 127.0.0.1 --port 8888
```

需要配置的变量见 [env.example](env.example)。服务端和 Kulo Hub 使用一致的 `KULO_HINDSIGHT_ROUTER_API_KEY`、`KULO_HINDSIGHT_WORKER_API_KEY`、`KULO_HINDSIGHT_PRIVATE_BANK`、`KULO_HINDSIGHT_SHARED_BANK`。

私有／共享 Bank 映射由服务端固定。修改 Hub 中的库名，不会让 Worker 获得另一个 Bank 的权限。

数据库必须显式配置独立的强口令，不能复用任一记忆密钥；空口令及公开默认的 pg0 凭据会阻止启动。启动时还会尝试错误口令，确认数据库实际拒绝访问；忽略口令的 trust/peer 配置或无法验证的连接不会放行服务。数据库端口和数据目录仅向可信记忆服务开放，不能挂载给 Worker。连接 URI 中的口令需要 URL 编码。切换已有 pg0 的凭据必须按 pg0 的数据库凭据迁移流程完成，不能只修改客户端 URL。

不要同时保留原版 API、MCP、控制台或其他能绕过这套授权的入口。Hub 及其状态、模型凭据、服务安装目录与 Worker 的执行账户、可写任务目录必须分离；节点凭据不能拥有 Hub 管理权限。

## 开放的接口

只开放 Kulo 记忆工具所需的 REST 操作：版本探测、文档列表／原文、recall、reflect、Knowledge Pages 列表／搜索／读取、写入文档和创建知识页面／文件夹，以及对应 Bank 的异步操作状态。

入站中间件在读取请求体前检查身份、Bank 和操作；官方 `TenantExtension` 与 `OperationValidatorExtension` 再检查引擎收到的真实 Bank，防止别名解析改变访问目标。

全局 Bank 列表、MCP、导入导出、克隆、别名、配置、Webhook、模型追踪、指标和其他未列入允许范围的路由默认拒绝。运行时密钥不能管理数据库或 Bank 的权限配置。匿名／无效凭据返回 401，越权返回 403，不用空结果冒充权限拒绝。

`GET /v1/kulo/access` 返回当前已认证身份、固定 Bank ID 和读写权限及 `policyVersion`，不返回密钥。Hub 探活还必须实际使用 Worker 密钥读取私库路径并确认 403；权限声明不能代替负向验证。

## 验证

```sh
uv run --project integrations/hindsight --extra test pytest
```

测试包含真实 Hindsight HTTP 路由的私库负向遍历，以及独立临时 PostgreSQL 和本机 TCP 服务：主脑读取私有哨兵、Worker 读取共享对照、Worker 直接请求私库被拒绝、异步文档写入入队、共享知识文件夹写入和读回、主脑共享写入被拒绝、私有页面／操作 ID 不能从共享路径读出。在 macOS 上还通过真正隔离的 Pi Env daemon 运行 curl，并检查私有文件及主脑环境变量无法读取。临时数据库使用随机口令，不调用付费模型、不连接现有用户数据库。

这些服务端检查需要和 Kulo 的 Env、凭据隔离及管理接口测试一起通过。只通过 HTTP 授权测试，不代表一个仍拥有宿主文件或数据库访问权限的执行节点已经隔离。
