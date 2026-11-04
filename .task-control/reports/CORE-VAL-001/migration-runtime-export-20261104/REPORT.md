# MIG02 运行导出接缝候选

新增无写盘 `prepareMigratedRepositorySource`，复用原来源准备与版本读取内核。真实固定 MIG02 生成器仅对两个虚构文稿执行 build；用其逐件收据、原件字节及明确的合成分段/策略组成现有 manifest → profile → catalog，固定 Git 版本后由普通来源工具列举/回读。

- 六个源码/测试/文档路径见 CODE-MANIFEST.json，基线 c0c4d2da，完整差异 CODE.patch。
- 定向 37/37；解包 152/152，均含新增 9 项，不累加。SDK 10.9，锁仍10.8；本候选未跑CI/真实Host/模型。
- 首次 npm pack 在配置加载前拒绝同一空文件被同时用作 user/global 配置，非权限拒绝；改用现有CI的两个独立空文件后成功。原失败保留，未安装任何依赖。
- 保留原件 BOM/CRLF，拒绝规范化改写替代原文、冒名清单、临时身份、待决版本、错误hash/size/selector及未获准来源；改版后旧pin/cursor/Evidence拒绝。
- 函数不独立证明 receipt 源 Git commit/originBlob 的归属，不写盘、不授予许可。生产者仍须交付真实身份/分段/策略/descriptor和最终运行SHA。附件/全仓/理解写回未验。

同步会话的14项矩阵与32/17项冻结验收保持原字节，不重复写树。本包是新增生产者收据适配，不把候选manifest当运行catalog；当前真实90f绑定及旧UNKNOWN加载保持不动。独审待父安排，本轮只做本地精确候选提交。
