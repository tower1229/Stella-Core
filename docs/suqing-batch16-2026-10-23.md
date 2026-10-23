# 肃清第十六批：WebChat profile 兼容与只读诊断

基线 `da94d041b31d5fed7a47a8cac8c1f62772b1e412`；最终提交、源文件 hash 与命令结果见 `.artifacts/suqing-batch16-20261023/delivery.json`。本批不是新 npm 安装包验收，也没有将旧包 SHA 当作新代码身份。真实 main 未加载本批代码，真实源、身份、processing grant、旧会话和生产配置均未改动。

## 最小代码改动

`checkpoint-request-identity.ts` 共用解析用于 `checkpoint-host-request` 和 `checkpoint-request-ingress`。保留旧 transport 路径；仅对原版 WebChat 缺 sender 的情况使用当前 Host 可信 `SessionCreation.actor`，要求 human/profile、operator/direct/admin，并与显式 `webchatOwnerProfileId` 精确匹配。Core requester 为 `openclaw-profile:<profileId>`，不改 Host sender，不将 profile 映射成 Telegram 身份。原版 OpenClaw 零修改。

工具检查不再拿 Core 派生 principal 冒充 Host transport sender，而是比较捕获时的实际 Host sender，保留精确 run/session、当前用户轮资格、一次性 callId、正常取消及旧闭包失效。profile 变化、其他 profile、伪造工具 sender 和未知旧历史继续拒绝。

新增 `stella.identity` 只读 RPC。公开 `registerGatewayMethod` handler 可读取当前调用连接的 `authenticatedUserProfile`；接口仅使用这项元数据与现有 scope，空参数、当前连接、profile 必须存在。没有 runtime/config/checkpoint/source/LLM 访问。未新增 main 权限或身份绑定。`profileAccess=required` 和 `operator.admin` 均保留；不依赖私有 Host 导出或 opaque patch。

`webchatOwnerProfileId` 为可选 checkpoint-only 字段，旧配置默认行为不变。来源授权仍按原 manifest/policy；声明 source_access_context 的 v3 来源独立检查 processing requester，未将 114 条真实对象统一允许。没有要求所有旧 retain-v1 来源新增许可系统。

## 分层验证与原始失败

- TypeScript：首次发现可移植声明类型和测试类型错误，修复后 `tsc -p tsconfig.test.json --outDir .artifacts/suqing-batch16-20261023/compiled-a2` exit 0。该命令覆盖运行源码和测试的类型检查/编译。
- 定向测试：`webchat-identity-diagnostic`、`checkpoint-agent-supply`、`checkpoint-source-access`、`checkpoint-plugin-runtime`，最终 114/114，0 fail/skip/cancel。包括 profile 绑定、来源 grant 分离、无副作用 RPC、归档→checkpoint→Agent工具→同会话后续轮、profile 替换、伪造工具身份、旧历史和原有 CAS/取消回归。API stub 与内存夹具不能冒充实际 Host 正常 profile 用户全链路。
- 首次测试缺少编译目录的 schema 资源，集成项失败；记录在 `tests-a2.log`。补齐仓库 schemas 后复核通过，记录在 `tests-a2-resources.log`，没有将夹具失败改写成通过。
- 原版 Host：使用 Node 24.22.1、已安装 OpenClaw 2026.8.2 和本批实际编译入口，独立 state/home/cache、合成 workspace、假临时 token/device、loopback provider。Core API observation wrapper 只记录原公开载荷与结果，不注入 sender/profile，不是无 wrapper 的安装包 E2E。
- a1 在 Control UI 握手因缺版本/build元数据失败。使用公开 `/control-ui-config.json` 的 serverVersion/serverBuildId 后恢复，保留 Host 版本校验，未放宽安全配置。
- a2 发现探针收尾计数竞态：早期 `passed=true` 之后才计入 Host 后台标题请求。因此其原始 passed 字段不能证明“零模型请求”；以本报告和后续收尾后的计数为准，原件保留。
- a3 起捕获全部假 provider wire，并将诊断 RPC、Core 辅助 LLM、正常 Agent 和 Host dashboard label 分开。a4 校正假 provider SSE 终止符后做最终复核，exit 0：身份 RPC 1 次明确拒绝且该阶段 provider=0；WebChat 入场反例1个通过、Core辅助LLM=0、Agent admission=0；额外 provider=1，为完整 wire 已核实的 Host dashboard 标签调用。Gateway PID64698 exit0、runner PID64692 exit0，fake provider关闭。结果见同目录 `host-identity-a4/result.json`。

实际 WebChat 请求为 `Provider/Surface=webchat`、`ChatType=direct`、admin=true、sender 缺失、profile actor 缺失。Core 返回 `checkpoint_webchat_profile_required`，未启动正常 Agent、未进入 Core 辅助 LLM、未创建 checkpoint。只读身份 RPC 也明确返回 profile_required，其调用窗口 provider 请求为0。这里确认的是合成 token/device 登录的实际行为，不推断真实 Chrome 当前连接一定相同。

Host dashboard 标题生成独立于 Core reply_dispatch；原始 wire 证实它可向 loopback 发出标签请求。不能承诺用 Core 入场拒绝拦住这类 Host 调用，也不能用 chat.send 做“任何 LLM 之前终止”的真实身份诊断。直接只读身份 RPC 不经过聊天/Agent 路径。所有模型端都是本机假服务，无真实 API、费用或凭据。

隔离限制：继承禁止读取用户私人树、禁止非 loopback 网络和禁止 ps 的规则；未递归扫描/hash Host 树。结果只绑定已知公开包版本、入口和具名文件，不认证整个 Host 安装来源。失败/成功 Gateway、runner、fake provider 的退出状态保存在各 attempt 原件。

## 剩余最小步骤与授权

1. 本批代码的安装包与真实 main 加载尚未执行；需单独允许将新包用于 main 的只读诊断，不伴随模型调用或身份授权变更。随后在当前网页的 Debug/manual RPC 调用 `stella.identity {}`；不能用另一个 CLI 的主体代替网页主体。
2. 若返回 profile_required，先确认可用的原版 Host 可信 profile 认证机制及其具体影响；本批不创建 profile、不配置代理、不链接账户，也不将设备当个人身份。此时不能给出伪造的“已核实 profile ID”。
3. 取得可信 ID 后，精确授权 `plugins.entries.stella-core.config.webchatOwnerProfileId=<原始ID>`；对当前 v3 processing 文件仅追加 `requesterIds` 中的 `openclaw-profile:<ID>`，保留 Telegram requester 和全部原用途/受众/模型/对象策略。真实源的新 commit/checkpoint 必须明确固定，不能自动信 HEAD。
4. 使用新空会话首次绑定，不接管未知旧历史；正常 Agent/真实模型验收仍需单独确定外发资料与费用范围。114 条真实记忆没有在本批运行语义判断，16 条缺描述的限制不变。

full_memory 仍未验收；本批没有新代理、输出缓冲、运行中撤权或迁移框架，也没有扩大到 wiki/RAG、附件或其他 writer。
