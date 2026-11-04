# Runtime Source Layout

当前安装入口是 `ordinary-plugin.ts`：沿用 OpenClaw 原生 memory/context/Agent loop，提供版本化来源读取与未确认工作说明。CangHai 数据校验、来源与事务模块是当前依赖，不按目录名称或 schema 版本机械退役。

旧 `plugin.ts`、native SQL/query embedding 桥及其验收／初始化注册已从源码移除，恢复点在 Git 历史。其余旧 Host context、checkpoint、Praxis 编排和验收工具按依赖分组继续清理，不是另一条现行运行路线。仍被普通入口使用的 Evidence、来源定位、同步状态、view 及事务检查保留；framework、twin、learning 等目录的职责说明不代表完整能力已实现。

现行要求从[设计基线](../docs/10-DESIGN-BASELINE.md)进入；[契约目录](../docs/contracts/README.md)定义开发目标。完整记忆、Episode v2 和完成协调的实现差异单列在基线，不能由旧源码行为反推产品规则。
