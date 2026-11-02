# 26 项历史失败与当前普通插件的对应

基线：Core `3a0c547c66cf2d5b773f5895a36155cce4a84981`，OpenClaw 2026.10.8。
原始失败取自 `f5be7098` 的两份 CI 回执；父协调者独立复核确认，
`3a0c547c` 的 CI 41370313708 / 41370313898 仍是 1786/1760/26，
26 个归一化失败块相同。逐项身份、签名、来源 hash 见同名 JSON。

**本包建议不修改运行代码或测试。** 26 项涉及的旧 Core 路由不在当前
ordinary plugin 的本地静态导入闭包内；本包未据此识别出应优先移植到当前
Core 入口的共同修复。这不能排除 Host、外部 SDK 或整体产品仍有缺陷。
它们确实阻断现有全量 CI，因此流水线仍失败，不能标为整体通过。

| 数量 | 失败组 | 已核失败点／前置阻塞 | 对当前本地 Core 路由的关系 |
| --- | --- | --- | --- |
| 1 | Dreaming SDK 审计 | 明确断言 2026.8.2，且后续类型/私有调用点同样固定旧版 | 旧审计不在普通插件运行路径 |
| 2 | 私有 Host 补丁/安装器 | 读取旧 `embedded-agent-DGMNaRB-.js` 及其精确 hash；10.8 没有此文件 | 普通插件不修改 Host，也不调用旧安装器 |
| 10 | 原生上下文及 Google replay codec | 旧桥只接受 8.2，再从当前 SDK 目录导入已不存在的私有文件 | 普通入口不注册旧 provider/context engine，不执行这份 codec |
| 1 | 空输出策略 | 断言 8.2 并读取旧私有 builtin 导出 | 普通路径使用 Host 自有 Agent loop |
| 12 | 原生 SQLite 精确读取 | 旧 fixture/ambient 类型声称 8.2，却加载实际 10.8 SDK；公开 facade 不再导出 `MEMORY_INDEX_SOURCES_TABLE`，插值形成 `JOIN undefined` | 旧 SQL 桥未接入普通入口；不是 SQLite 缺失、vector 扩展或 OS 权限问题 |

表内记录已观察到的首个失败点或前置阻塞；其后的断言未验证。修复这些阻塞
也可能暴露后续问题。SQL 结论是旧桥与公共导出不匹配，不是表已被删除。

证据与定向验证：

- TypeScript AST 遍历当前入口的本地运行时 import/export/literal import()：
  17 个模块，未解析边为 0；旧 plugin、provider、context engine、native reader、
  codec、completion、Host 补丁模块均不在闭包内。外部 SDK 内部未递归遍历，
  此结论只描述本地 Core 的静态导入，不排除 Host、外部 SDK 或整体产品缺陷。
- 对原先只显示 `completion_failed` 的一例，保持测试原样单独重放，仍失败；
  spec reporter 暴露其 cause 同样是旧 `tool-call-id-bBWjBMFi.js` 缺失。
- 独立合成 `:memory:` SQLite 探针确认：10.8 的公共 sources 常量缺失，
  旧查询报 `no such table: undefined`。Host 内部仍有该表名常量；这里没有
  声称表已被删除，也没有读取实际 Host 数据库。
- 官方测试编译成功；现有 ordinary/candidate/continuation 定向测试 16/16。
  这次没有增加、删除、skip 或放宽测试，没有运行全量套件或正式 consumer。
  上述旧例失败、SQL 诊断和 16 项通过分别记录，不合计为全部通过。

处置边界沿用已接受的 CORE-D1 和 2026-10-30 重对齐方案 §6：原生
memory/context/loop 继续由 Host 承担；旧 SQL、私有桥与全部 slot 替换退出主线。
这不是新的架构调整或仓库退役决定：旧源码、测试、26 个失败和暂停任务全部保留。
不能简单换版本字符串、改私有文件名、补造 SDK 导出或硬编码表名来恢复旧桥。

请求身份/取消、精确版本和写事务等产品保证仍有效；当前合成工具测试与已完成的
四次真实 Gateway 工具调用只证明其声明范围，不替代原生向量授权、Dreaming、
真实来源或完整记忆验收。现有正式 runner 仍包含旧原生产物与消费要求；
即便抹掉这些单元失败，也不会由此证明新的普通插件 consumer 已通过。

最小下一步仍是已安装、已可见的续谈流程的实际模型消费验证：同一份虚构 brief
的修订与新会话接续，单列两次新 Agent 请求范围，限定 Gemini 3.8 Flash / low。
本包不执行或授权付费调用。不为 CI 数量移植旧桥，也不修改现有正式门禁。
