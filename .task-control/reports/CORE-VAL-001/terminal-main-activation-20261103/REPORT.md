# 已审终态清理加载到 main

本地代码提交 `c6ef12a3dcbd6355971b64449128db9ee9dcb5b1` 保存精确9源码/测试和12份非敏感证据，旧dirty、原配置和私人资料未纳入；未推送。独审89/89结果复用，没有重复大套测试。重新编译通过，2753安装成员匹配；只改变两生产模块的编译文件/声明/映射及真实build identity，依赖、manifest和技能不变。

实际 main 10.9已加载 generation17，PID31634未变。官方链接首次exit1但已保存并应用generation16；原因是旧Core路径仍在前面产生owner歧义。未重复安装，通过官方Core-only路径patch后恢复正常。Core active且诊断为空，真实stella_status成功，publisher=false，固定90f来源端口仍要求原生请求准入。前后配置只换Core路径，原97来源/362描述符、工具/身份/资料权限、selfie及其他插件保持；新技能仍eligible且未被agent过滤。health正常，activeWork全部0、writeCustody0、queuedEvents0，**没有独立retained计数，不称其已归零**。

旧2753成员和本次新鲜私有备份/窄回滚patch保留；未演练回滚。没有重启或新能力确认，没有私人正文、chat.send、模型调用。

## 尚未完成的实际终态验收

真实终态派发与缓存释放未执行验证，不能把加载/队列空当作通过。官方直接tools.invoke没有原生用户请求/recorder生命周期；静态检查10.9中slash-command可在Agent启动前返回，chat final不等于agent lifecycle end；现有公开RPC也没有Core请求缓存计数。未找到能够保证零模型、又覆盖这段链路的官方入口，因此没有尝试发送付费请求、伪造Host事件或再建一次性测试插件。

最小恢复条件：下一次明确授权的原生请求结合仅终态/缓存计数的最小元数据观测，或确认官方零模型原生生命周期生产者。当前已审事件订阅不需要conversation-access，不能为验收自动开放该权限。89项合成回归只证明代码处理契约，实际派发、真实正向理解及10.8兼容仍未验。保留当前健康已审包，不回退用户配置。
